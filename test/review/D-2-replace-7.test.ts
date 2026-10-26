// Review D-2, round 7 (the round-6 attacker G's GB, inverted; the design
// countersigned in advance): a recorded stray REPLACED at its nonce (the
// operator's speed-up or cancel, the way out of a stray stuck pending) is
// counted as a mined stray is: the replacement's hash goes into the
// stray's row (replacedBy), is printed with its cost on every resume and
// is never adopted as an entry. Another sender's transaction, a nonce no
// stray holds, or an entry at the stray's nonce keep today's account.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 7: a stray replaced at its nonce is counted, never adopted", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(async () => {
    (global as any).setTimeout = realST;
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
  });
  const automine = (on: boolean) =>
    network.provider.request({ method: "evm_setAutomine", params: [on] });

  /** A resume whose lines are kept: "accepted", else the refusal. */
  async function resume(lines: string[] = []) {
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    try {
      await r.install();
      r.remove();
      return "accepted";
    } catch (e: any) {
      return e.message as string;
    }
  }

  /**
   * Entry #0 mined at `start`; a resume behind a backend hiding it, whose
   * signer drops the nonce, leaves the stray at start + 1 pending.
   */
  async function pendingStray() {
    const start = await h.nonce();
    await h.sendOne(box.file);
    await automine(false);
    const hide = load().txs[0].hash;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        return request({ method: a.method, params: [rest] });
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    const stray = load().strays![0].hash;
    expect(await h.accepted(box.file)).to.contain("is pending on this node");
    return { start, stray };
  }

  /** The stray dropped, the deployer's own `tx` mined at its nonce. */
  async function replace(stray: string, tx: any) {
    await network.provider.request({
      method: "hardhat_dropTransaction",
      params: [stray],
    });
    const [d] = await ethers.getSigners();
    const sent = await d.sendTransaction(tx);
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
    return sent.hash;
  }

  const line = (start: number, stray: string, by: string) =>
    `   ⚠️  nonce ${start + 1}: stray ${stray} replaced by ${by}, outside the record, never adopted; it cost `;

  it("GB: after a cancel at the stray's nonce the healthy resume completes; the replacement is recorded, printed and counted once", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await pendingStray();
    const by = await replace(stray, { to: d.address, nonce: start + 1 });
    const lines: string[] = [];
    expect(await resume(lines), "recoverable").to.equal("accepted");
    expect(load().strays!.map((s) => [s.hash, s.replacedBy])).to.deep.equal([
      [stray, by],
    ]);
    const hits = lines.filter((l) => l.startsWith(line(start, stray, by)));
    expect(hits, lines.join("\n")).to.have.length(1);
    expect(hits[0]).to.match(new RegExp(`it cost ${d.address} [0-9.]+ ETH$`));
    expect(
      load().txs.map((t) => t.hash),
      "never an entry",
    ).to.not.include(by);
    expect(load().txs).to.have.length(1);
    const again: string[] = [];
    expect(await resume(again), "a second resume").to.equal("accepted");
    expect(
      again.filter((l) => l.startsWith(line(start, stray, by))),
    ).to.have.length(1);
    expect(await h.nonce(), "sends nothing").to.equal(start + 2);
  });

  it("GB: a replacement that created a contract prints its address", async function () {
    const { start, stray } = await pendingStray();
    const { data } = await (
      await ethers.getContractFactory("KeyManager")
    ).getDeployTransaction();
    const by = await replace(stray, { data, nonce: start + 1 });
    const [d] = await ethers.getSigners();
    const made = ethers.getCreateAddress({ from: d.address, nonce: start + 1 });
    const lines: string[] = [];
    expect(await resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(
      `${line(start, stray, by)}${d.address}`,
    );
    expect(lines.join("\n")).to.contain(
      ` and created ${made}, which the record does not own`,
    );
  });

  it("another sender's transaction never replaces a deployer stray: a hand-edited replacedBy naming one is refused by name", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await pendingStray();
    await replace(stray, { to: d.address, nonce: start + 1 });
    expect(await resume()).to.equal("accepted");
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [other.address, ethers.toQuantity(ethers.parseEther("1"))],
    });
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [other.address, ethers.toQuantity(start + 1)],
    });
    const theirs = await (
      await other.sendTransaction({ to: other.address })
    ).wait();
    const rec = load();
    rec.strays![0].replacedBy = theirs!.hash;
    saveRecord(box.file, rec);
    expect(await resume()).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0): its replacement ${theirs!.hash} is not shown mined from ${d.address} at nonce ${start + 1}: refusing`,
    );
  });

  it("a replacedBy naming the deployer's transaction at another nonce is refused by name", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await pendingStray();
    await replace(stray, { to: d.address, nonce: start + 1 });
    expect(await resume()).to.equal("accepted");
    const later = await (await d.sendTransaction({ to: d.address })).wait();
    const rec = load();
    rec.strays![0].replacedBy = later!.hash;
    saveRecord(box.file, rec);
    expect(await resume()).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0): its replacement ${later!.hash} is not shown mined from ${d.address} at nonce ${start + 1}: refusing`,
    );
  });

  it("a deployer transaction at a nonce no stray holds stays outside the record (N1 refusal unchanged)", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await pendingStray();
    await replace(stray, { to: d.address, nonce: start + 1 });
    expect(await resume()).to.equal("accepted");
    await (await d.sendTransaction({ to: d.address })).wait();
    expect(await resume()).to.equal(
      `the deployer's nonce is ${start + 3} but the record accounts for ${start + 2}: a transaction outside the record; refusing to resume`,
    );
  });

  it("an entry that took a dropped stray's nonce is the entry, not a replacement: dropped, not counted", async function () {
    const { start, stray } = await pendingStray();
    await network.provider.request({
      method: "hardhat_dropTransaction",
      params: [stray],
    });
    await automine(true);
    const r = new Recorder(box.file, load(), 1, () => {});
    await r.install();
    try {
      await (
        await (await ethers.getContractFactory("IdentityRegistry")).deploy()
      ).waitForDeployment();
      await (
        await (await ethers.getContractFactory("KeyManager")).deploy()
      ).waitForDeployment();
      await r.finish();
    } finally {
      r.remove();
    }
    expect(load().txs.map((t) => t.nonce)).to.deep.equal([start, start + 1]);
    const lines: string[] = [];
    expect(await resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(
      `${stray}, the signer's re-send of entry #0 (new IdentityRegistry) at another nonce: dropped, not counted`,
    );
    expect(load().strays![0].replacedBy, "no replacement").to.equal(undefined);
  });
});
