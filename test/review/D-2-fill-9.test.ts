// Review D-2, round 9 (item D, lane G's LOW + GB1 + GJ6): past 5000 blocks
// after a re-send's intent, a resume that met an unrecorded re-send
// refused "find that transaction and record it by hand", and nothing in
// code or runbook said how. One operator escape for the class, checked
// against the chain: DEPLOY_FILL_HASH accepts a hash whose mined
// transaction is either round 8's cancel-to-self at a dropped stray's
// nonce, or (new) the deployer's transaction at a free nonce carrying an
// entry's recorded payload (sameTx, the nonce swapped), mined after the
// entry's re-send intent: recorded as that entry's stray, its row's
// block the intent's (as unrecorded() writes it).
// Anything else is refused by name, and every refusal that names the
// variable says to unset it after the resume completes (GB1). R9-C4:
// lane C's seven round-8 refusals are pinned first, unchanged in what
// they name.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

const UNSET = "; unset DEPLOY_FILL_HASH after the resume completes";

describe("D-2 round 9: DEPLOY_FILL_HASH names a fill or an unrecorded re-send", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  /** The pending stray dropped, the cancel at its nonce mined, `n` blocks on. */
  async function cancelled(n: number) {
    const [d] = await ethers.getSigners();
    const { start, stray, hide } = await s.pendingStray();
    await s.drop(stray);
    const fill = await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    await mine(n);
    return { d, start, stray, hide, fill: fill.hash };
  }

  /**
   * The cX shape (D-2-unrecorded-8): entry #0 mined at start, then a run
   * killed while its re-send's reply is awaited; `forward`: the node got
   * the re-send (its hash returned here), mined at start + 1.
   */
  async function killedResend(forward: boolean) {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    let sent: string | null = null;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        sent = forward
          ? await request({ method: a.method, params: [rest] })
          : "0x";
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {});
    try {
      for (let i = 0; !sent && i < 500; i++) await s.wait(10);
      expect(sent, "the re-send went out").to.not.equal(null);
    } finally {
      r.remove();
      restore();
    }
    return { start, hide, stray: sent! };
  }

  it("R9-C4 pin: lane C's seven round-8 refusals still refuse by name, nothing recorded", async function () {
    const { d, start, stray, hide } = await cancelled(5001);
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [other.address, ethers.toQuantity(ethers.parseEther("1"))],
    });
    const theirs = (await (
      await other.sendTransaction({ to: other.address })
    ).wait())!.hash;
    const call = await (
      await d.sendTransaction({ to: d.address, data: "0x01" })
    ).wait();
    const later = (await (await d.sendTransaction({ to: d.address })).wait())!
      .hash;
    const rec = s.load();
    rec.txs.push({
      from: d.address,
      to: d.address,
      value: "0",
      dataHash: ethers.keccak256("0x01"),
      nonce: start + 2,
      block: call!.blockNumber,
      hash: call!.hash,
      status: "confirmed",
      label: "a call",
    });
    saveRecord(s.box.file, rec);
    const before = JSON.stringify(s.load());
    const refused = async (hash: string) => {
      process.env.DEPLOY_FILL_HASH = hash;
      const err = await s.resume();
      expect(JSON.stringify(s.load()), "nothing recorded").to.equal(before);
      return err;
    };
    const named = (hash: string, what: string) =>
      `DEPLOY_FILL_HASH ${hash} ${what}: refusing`;
    expect(await refused(hide)).to.contain(
      named(hide, "is record entry #0's transaction, not a fill"),
    );
    expect(await refused(call!.hash)).to.contain(
      named(call!.hash, "is record entry #1's transaction, not a fill"),
    );
    expect(await refused(stray), "the dropped stray").to.contain(
      named(stray, "is not shown by this node"),
    );
    expect(await refused("0x1234")).to.contain(
      named("0x1234", "is not a transaction hash"),
    );
    const unknown = `0x${"ab".repeat(32)}`;
    expect(await refused(unknown)).to.contain(
      named(unknown, "is not shown by this node"),
    );
    expect(await refused(theirs)).to.contain(
      `DEPLOY_FILL_HASH ${theirs} is ${other.address}'s transaction at nonce 0`,
    );
    expect(await refused(later)).to.contain(
      `DEPLOY_FILL_HASH ${later} is ${d.address}'s transaction at nonce ${start + 3}`,
    );
  });

  it("a cancel past the bound (round 8's shape) completes with its hash", async function () {
    const { start, fill } = await cancelled(5001);
    expect(await s.resume()).to.contain("DEPLOY_FILL_HASH=");
    process.env.DEPLOY_FILL_HASH = fill;
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays![0].replacedBy).to.equal(fill);
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("an unrecorded re-send past the bound: the refusal names DEPLOY_FILL_HASH and unset; with its hash the resume records it as the entry's stray, counted once", async function () {
    const { start, stray } = await killedResend(true);
    const from = s.load().txs[0].resendFrom!;
    await mine(5001);
    expect(await s.resume()).to.equal(
      `nonce ${start + 1}: ${s.load().deployer} used nonce ${start + 1} more than 5000 blocks after the intent (block ${from}); the bound is entry #0 (${s.load().txs[0].label})'s intent, the earliest the record keeps; if it is an entry's re-send, pass its hash as DEPLOY_FILL_HASH=<hash>, then resume; otherwise record it by hand${UNSET}`,
    );
    expect(s.load().strays ?? [], "no stray recorded").to.deep.equal([]);
    process.env.DEPLOY_FILL_HASH = stray;
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(s.load().strays).to.deep.equal([
      {
        hash: stray,
        from: s.load().deployer,
        nonce: start + 1,
        entry: 0,
        label: s.load().txs[0].label,
        block: from,
      },
    ]);
    expect(lines.join("\n")).to.contain(`nonce ${start + 1}: ${stray}`);
    expect(await h.nonce()).to.equal(start + 2);
    expect(await s.resume(), "the flag still set: stale").to.equal(
      `DEPLOY_FILL_HASH ${stray} is stray ${stray} itself, not a fill: refusing${UNSET}`,
    );
    delete process.env.DEPLOY_FILL_HASH;
    expect(await s.resume(), "a re-run without it").to.equal("accepted");
  });

  it("an unrecorded re-send's wrong hashes are refused by name: another sender's, before the start, an entry's own, another payload, pending", async function () {
    const [d] = await ethers.getSigners();
    const deploy = (
      await (
        await ethers.getContractFactory("IdentityRegistry")
      ).getDeployTransaction()
    ).data;
    // entry #0's payload, sent before the record's start
    const early = (await (await d.sendTransaction({ data: deploy })).wait())!
      .hash;
    const { start, hide } = await killedResend(false); // nothing mined
    const e = s.load().txs[0];
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [other.address, ethers.toQuantity(ethers.parseEther("1"))],
    });
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [other.address, ethers.toQuantity(start + 1)],
    });
    const theirs = (await (
      await other.sendTransaction({ data: e.data! })
    ).wait())!.hash;
    await s.automine(false);
    const pending = await d.sendTransaction({
      data: e.data!,
      nonce: start + 1,
      gasLimit: BigInt(e.gas!),
    });
    const before = JSON.stringify(s.load());
    const refused = async (hash: string) => {
      process.env.DEPLOY_FILL_HASH = hash;
      const err = await s.resume();
      expect(JSON.stringify(s.load()), "nothing recorded").to.equal(before);
      return err;
    };
    const not = (hash: string, who: string, at: number) =>
      `DEPLOY_FILL_HASH ${hash} is ${who}'s transaction at nonce ${at}, not at a recorded stray's sender and nonce, nor an entry's re-send at a free nonce of the deployer: refusing${UNSET}`;
    expect(await refused(theirs)).to.equal(
      not(theirs, other.address, start + 1),
    );
    expect(await refused(early)).to.equal(not(early, d.address, start - 1));
    expect(await refused(hide)).to.equal(
      `DEPLOY_FILL_HASH ${hide} is record entry #0's transaction, not a fill: refusing${UNSET}`,
    );
    expect(await refused(pending.hash)).to.equal(
      `DEPLOY_FILL_HASH ${pending.hash} is not mined on this node: refusing${UNSET}`,
    );
    await s.drop(pending.hash);
    const payload = await d.sendTransaction({
      to: d.address,
      nonce: start + 1,
    });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await refused(payload.hash)).to.equal(
      not(payload.hash, d.address, start + 1),
    );
  });

  it("GB1: a stale value on a record it fits nowhere refuses naming unset", async function () {
    const [d] = await ethers.getSigners();
    await h.sendOne(s.box.file);
    const t = await d.sendTransaction({ to: d.address });
    await t.wait();
    process.env.DEPLOY_FILL_HASH = t.hash;
    expect(await s.resume()).to.equal(
      `DEPLOY_FILL_HASH ${t.hash} is ${d.address}'s transaction at nonce ${t.nonce}, not at a recorded stray's sender and nonce, nor an entry's re-send at a free nonce of the deployer: refusing${UNSET}`,
    );
  });
});
