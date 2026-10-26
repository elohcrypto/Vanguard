// Review D-2, round 8 (item H): pins for the round-7 attacker G's
// surviving mutants (g-mutate7.py): N04 the gap check uses the entry's
// sender, N06 the own-entry lookup uses the sender, N13 a shown stray's
// sender is checked, N17 a stray the node shows without a receipt is not
// counted, N31 more than one stray is counted, N28 the lag refusal leaves
// the in-memory entry unchanged. Each passes on 3c1fcdf and fails under
// its mutant.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { saveRecord, TxEntry } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 8: pins for the round-7 stray survivors", function () {
  this.timeout(180000);
  const s = strays();
  const fake = (x: string) => ethers.keccak256(ethers.toUtf8Bytes(x));
  /** Entry #0 mined at start (its receipt not yet read). */
  async function base() {
    const [d] = await ethers.getSigners();
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [other.address, ethers.toQuantity(ethers.parseEther("1"))],
    });
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await network.provider.request({ method: "evm_mine" });
    return { d, other, start, rec: s.load() };
  }
  /** `who` (a fresh wallet) sends a call to itself at nonce `n`; its entry. */
  async function call(who: any, n: number): Promise<TxEntry> {
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [who.address, ethers.toQuantity(n)],
    });
    const block = await ethers.provider.getBlockNumber();
    const t = await (await who.sendTransaction({ to: who.address })).wait();
    return {
      from: who.address,
      to: who.address,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      data: "0x",
      nonce: n,
      block,
      hash: t!.hash,
      status: "sent",
      label: "a call",
    };
  }
  const row = (d: any, hash: string, nonce: number) => ({
    hash,
    from: d.address,
    nonce,
    entry: 0,
    label: "new IdentityRegistry",
  });

  it("N04: a dropped stray below another sender's later entry is no gap: dropped, the resume completes", async function () {
    const { d, other, start, rec } = await base();
    rec.txs.push(await call(other, start + 5));
    rec.strays = [row(d, fake("N04"), start + 1)];
    saveRecord(s.box.file, rec);
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(": dropped, not counted");
  });

  it("N06: another sender's entry at the stray's nonce number is no own entry there: the deployer's fill is the replacement, counted", async function () {
    const { d, other, start, rec } = await base();
    const fill = await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait();
    rec.txs.push(await call(other, start + 1));
    rec.strays = [row(d, fake("N06"), start + 1)];
    saveRecord(s.box.file, rec);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays![0].replacedBy).to.equal(fill!.hash);
  });

  it("N13: a stray the chain shows from another sender at its nonce is refused by name", async function () {
    const { d, other, start, rec } = await base();
    const theirs = await call(other, start + 3);
    rec.strays = [row(d, theirs.hash!, start + 3)];
    saveRecord(s.box.file, rec);
    expect(await s.resume()).to.equal(
      `stray ${theirs.hash} (nonce ${start + 3}, the re-send of entry #0): the chain shows it from ${other.address} at nonce ${start + 3}, not as recorded: refusing`,
    );
  });

  it("N17: a stray shown mined without a receipt is printed as not mined and not counted: the account refuses; with its receipt it completes", async function () {
    const { d, start, rec } = await base();
    const t = await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait();
    rec.strays = [row(d, t!.hash, start + 1)];
    saveRecord(s.box.file, rec);
    const restore = h.node(async (a) =>
      a.method === "eth_getTransactionReceipt" && a.params[0] === t!.hash
        ? null
        : undefined,
    );
    const lines: string[] = [];
    let err = "";
    try {
      err = await s.resume(lines);
    } finally {
      restore();
    }
    expect(lines.join("\n")).to.contain(
      `nonce ${start + 1}: ${t!.hash}, the signer's re-send of entry #0 (new IdentityRegistry) at another nonce: not mined on this node, not counted`,
    );
    expect(err).to.contain(
      `the deployer's nonce is ${start + 2} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume`,
    );
    expect(await s.resume()).to.equal("accepted");
  });

  it("N31: two mined strays are both counted", async function () {
    const { d, start, rec } = await base();
    const t1 = await (await d.sendTransaction({ to: d.address })).wait();
    const t2 = await (await d.sendTransaction({ to: d.address })).wait();
    rec.strays = [row(d, t1!.hash, start + 1), row(d, t2!.hash, start + 2)];
    saveRecord(s.box.file, rec);
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(lines.filter((l) => l.includes("it cost "))).to.have.length(2);
    expect(await h.nonce()).to.equal(start + 3);
  });

  it("N28: the lag refusal leaves the in-memory entry as it was: status sent, no contract, no code hash", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    const at = ethers.getCreateAddress({ from: d.address, nonce: start });
    const r = new Recorder(s.box.file, await h.fresh(s.box.file), 1, () => {});
    let lie = 1;
    const restore = h.node(async (a) =>
      a.method === "eth_getCode" &&
      lie > 0 &&
      String(a.params[0]).toLowerCase() === at.toLowerCase()
        ? (lie--, "0x")
        : undefined,
    );
    let err = "";
    try {
      await r.install();
      await (await ethers.getContractFactory("IdentityRegistry")).deploy();
      await r.finish().catch((e: Error) => (err = e.message));
    } finally {
      r.remove();
      restore();
    }
    expect(err).to.contain("has a receipt but no code on this node");
    const e = r.rec.txs[0];
    expect([e.status, e.contract, e.codeHash, e.gasUsed]).to.deep.equal([
      "sent",
      undefined,
      undefined,
      undefined,
    ]);
    expect(e.hash, "its hash kept").to.match(/^0x[0-9a-f]{64}$/);
  });
});
