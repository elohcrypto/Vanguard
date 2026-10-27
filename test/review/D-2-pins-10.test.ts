// Review D-2, round 10 (item D): pins for the rules lane G's round-9
// lever left unpinned (swarm-9/G/g-mutate9.py; Pnn kills mutant Hnn):
// H04, the listed-stray skip goes on to the next free nonce; H20, the
// operator's fill for a stray is never taken for a free nonce of the
// deployer; H26, the replacement scan's refusal past the bound says to
// unset the variable; P-X09 (round 10's lever), a node's answer that is
// no hash keeps the intent. Each passes at 0b4aa9c and after round 10.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

const UNSET = "; unset DEPLOY_FILL_HASH after the resume completes";

describe("D-2 round 10 pins: lane G's round-9 survivors (kills H04, H20, H26)", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  /** Killed while its re-send's reply is awaited; the node got the re-send. */
  async function killedResend(start: number, hide: string) {
    let sent: string | null = null;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        sent = await request({ method: a.method, params: [rest] });
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
    return sent!;
  }

  it("P04 (kills H04): a listed stray's lagging nonce does not end the search: an unrecorded re-send at the next free nonce is recorded", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    const restore = s.liar(start, hide);
    try {
      expect(await h.accepted(s.box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    const listed = s.load().strays![0].hash; // start + 1
    const lost = await killedResend(start, hide); // start + 2, unrecorded
    const lag = h.node(async (a) =>
      a.method === "eth_getTransactionReceipt" && a.params[0] === listed
        ? null
        : undefined,
    );
    try {
      expect(await s.resume(), "the lagging resume").to.contain(
        "the record accounts for",
      );
    } finally {
      lag();
    }
    expect(s.load().strays!.map((x) => [x.nonce, x.hash])).to.deep.equal([
      [start + 1, listed],
      [start + 2, lost],
    ]);
    expect(await s.resume(), "the node caught up").to.equal("accepted");
  });

  it("P20 (kills H20): a role key's fill at a nonce the deployer also has free is used for its stray only: the deployer's unrecorded re-send there is found", async function () {
    const [, role] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const lost = await killedResend(start, s.load().txs[0].hash!); // start + 1
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [role.address, ethers.toQuantity(start + 1)],
    });
    const fill = await role.sendTransaction({
      to: role.address,
      nonce: start + 1,
    });
    await fill.wait();
    const rec = s.load();
    (rec.strays ??= []).push({
      hash: `0x${"ab".repeat(32)}`, // dropped: no node shows it
      from: role.address,
      nonce: start + 1,
      entry: 0,
      label: "a role key's re-send",
      block: await ethers.provider.getBlockNumber(),
    });
    saveRecord(s.box.file, rec);
    process.env.DEPLOY_FILL_HASH = fill.hash;
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => [x.from, x.hash])).to.deep.equal([
      [role.address, `0x${"ab".repeat(32)}`],
      [s.load().deployer, lost],
    ]);
    expect(s.load().strays![0].replacedBy).to.equal(fill.hash);
  });

  it("P26 (kills H26): a dropped stray's fill past the bound: the refusal names DEPLOY_FILL_HASH and says to unset it", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await s.pendingStray();
    await s.drop(stray);
    await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    await mine(5001);
    const res = await s.resume();
    expect(res).to.contain(
      `pass the hash of the transaction that filled it as DEPLOY_FILL_HASH=<hash>, then resume${UNSET}`,
    );
    expect(res.endsWith(UNSET)).to.equal(true);
  });

  it("P-X09: a node that answers the re-send with no transaction hash keeps the intent (only a send the node refused leaves none)", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") return "0x";
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(s.box.file)).to.contain("no transaction hash");
    } finally {
      restore();
    }
    expect(s.load().txs[0].resendFrom, "kept").to.be.a("number");
  });
});
