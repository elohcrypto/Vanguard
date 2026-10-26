// Review D-2, round 8 (the round-7 attacker G's GG1 and GG1b, inverted):
// two strays at ONE nonce. S1 is recorded, the node drops it, the same
// faulty backend answers the re-send again and S2 mines at that nonce.
// Round 7 counted S2 as a stray AND as S1's replacement, so every resume
// refused "the deployer's nonce is N but the record accounts for N+1".
// A transaction whose hash is another recorded stray's is never a
// replacement: S1 is printed as dropped, its nonce taken by S2.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 8: two strays at one nonce count that nonce once", function () {
  this.timeout(180000);
  const s = strays();
  const taken = (s1: string, s2: string) =>
    `${s1}, the signer's re-send of entry #0 (new IdentityRegistry) at another nonce: dropped, its nonce taken by stray ${s2}`;

  it("GG1: the first stray dropped, the re-send answered again at its nonce: the healthy resume completes, the nonce counted once", async function () {
    const { start, stray, hide } = await s.pendingStray();
    await s.drop(stray);
    await s.automine(true);
    const restore = s.liar(start, hide, "0x4c4b40");
    try {
      expect(await h.accepted(s.box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    const [s1, s2] = s.load().strays!;
    expect([s1.nonce, s2.nonce], "two strays at one nonce").to.deep.equal([
      start + 1,
      start + 1,
    ]);
    const lines: string[] = [];
    expect(await s.resume(lines), "healthy chain and record").to.equal(
      "accepted",
    );
    expect(lines.join("\n")).to.contain(taken(s1.hash, s2.hash));
    expect(s.load().strays![0].replacedBy, "never a replacement").to.equal(
      undefined,
    );
    expect(await h.nonce(), "startNonce + 1 entry + 1 stray").to.equal(
      start + 2,
    );
    expect(await h.created(start), "one contract per entry").to.have.length(2);
    expect(await s.resume(), "a second resume").to.equal("accepted");
  });

  it("GG1b: the record shape stray() writes for two strays at one nonce (S1 dropped, S2 mined), built by hand: completes, as round 6 did", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const rec = s.load();
    const e0 = rec.txs[0];
    const s2 = await (
      await d.sendTransaction({ data: e0.data!, nonce: start + 1 })
    ).wait();
    const s1 = ethers.keccak256("0x1234");
    rec.strays = [
      {
        hash: s1,
        from: d.address,
        nonce: start + 1,
        entry: 0,
        label: e0.label,
      },
      {
        hash: s2!.hash,
        from: d.address,
        nonce: start + 1,
        entry: 0,
        label: e0.label,
      },
    ];
    saveRecord(s.box.file, rec);
    const lines: string[] = [];
    expect(await s.resume(lines), "two strays at one nonce").to.equal(
      "accepted",
    );
    expect(lines.join("\n")).to.contain(taken(s1, s2!.hash));
    expect(s.load().strays![0].replacedBy).to.equal(undefined);
  });

  it("a replacement of another stray at the same nonce is no replacement of this one either", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const rec = s.load();
    const e0 = rec.txs[0];
    // S2 replaced by R (recorded), S1 dropped: R holds the nonce once.
    const r = await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait();
    const [s1, s2] = ["0x1234", "0x5678"].map((x) => ethers.keccak256(x));
    const row = {
      from: d.address,
      nonce: start + 1,
      entry: 0,
      label: e0.label,
    };
    rec.strays = [
      { ...row, hash: s1 },
      { ...row, hash: s2, replacedBy: r!.hash },
    ];
    saveRecord(s.box.file, rec);
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(taken(s1, s2));
    expect(s.load().strays!.map((x) => x.replacedBy)).to.deep.equal([
      undefined,
      r!.hash,
    ]);
  });

  /** GG1b's shape by hand: S1 (dropped) and S2 (mined) at start + 1. */
  async function twins(round7 = false) {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const rec = s.load();
    const e0 = rec.txs[0];
    const s2 = (await (
      await d.sendTransaction({ data: e0.data!, nonce: start + 1 })
    ).wait())!.hash;
    const s1 = ethers.keccak256("0xabcd");
    const row = {
      from: d.address,
      nonce: start + 1,
      entry: 0,
      label: e0.label,
    };
    rec.strays = [
      { ...row, hash: s1, ...(round7 ? { replacedBy: s2 } : {}) },
      { ...row, hash: s2 },
    ];
    saveRecord(s.box.file, rec);
    return { start, s1, s2 };
  }

  it("a record round 7 wrote (S1's replacedBy naming S2) completes: S2 is never S1's replacement", async function () {
    const { start, s1, s2 } = await twins(true);
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(taken(s1, s2));
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("a record round 7 wrote with both strays' replacedBy naming one fill: that nonce is counted once, as the first stray's", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const rec = s.load();
    const fill = (await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait())!.hash;
    const [s1, s2] = ["0x01", "0x02"].map((x) => ethers.keccak256(x));
    const row = {
      from: d.address,
      nonce: start + 1,
      entry: 0,
      label: rec.txs[0].label,
      replacedBy: fill,
    };
    rec.strays = [
      { ...row, hash: s1 },
      { ...row, hash: s2 },
    ];
    saveRecord(s.box.file, rec);
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(
      `nonce ${start + 1}: stray ${s1} replaced by ${fill}, outside the record`,
    );
    expect(lines.join("\n")).to.contain(taken(s2, s1));
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("more than 5000 blocks on, the nonce another stray holds is read by its hash, no scan: completes", async function () {
    const { start, s1, s2 } = await twins();
    await network.provider.request({
      method: "hardhat_mine",
      params: ["0x1389"],
    });
    const lines: string[] = [];
    expect(await s.resume(lines)).to.equal("accepted");
    expect(lines.join("\n")).to.contain(taken(s1, s2));
    expect(await h.nonce()).to.equal(start + 2);
  });
});
