// Review D-2, round 7 (the round-6 attacker G's GH, inverted): nothing is
// sent while a recorded stray is pending. The strays are read before any
// entry is settled, so a record that already holds a hashless intent
// behind a pending stray (a round-5 record, or a run killed between the
// plan and the refusal) is refused by name with the intent unsent. Once
// the stray mines, the resume completes; once it drops, the intent's
// nonce sits above a gap: refused by name until the operator fills the
// stray's nonce (a cancel to self), which is then counted as its
// replacement, and the resume completes.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 7: nothing is sent while a recorded stray is pending", function () {
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
  const pending = async (a: string) =>
    Number(
      await network.provider.request({
        method: "eth_getTransactionCount",
        params: [a, "pending"],
      }),
    );
  /** `p` or "HANG" after `ms`: a resume that waits forever fails here. */
  const bounded = (p: Promise<string>, ms = 6000) =>
    Promise.race([
      p,
      new Promise<string>((ok) => realST(() => ok("HANG"), ms)),
    ]);

  /** GH's record: #0 mined, a stray pending at start + 1, #1 hashless at start + 2. */
  async function ghRecord() {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(box.file);
    await automine(false);
    const stray = await d.sendTransaction({ to: h.AGENT, value: 1 });
    const rec = load();
    const { data } = await (
      await ethers.getContractFactory("KeyManager")
    ).getDeployTransaction();
    rec.strays = [
      {
        hash: stray.hash,
        from: d.address,
        nonce: start + 1,
        entry: 0,
        label: rec.txs[0].label,
      },
    ];
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: start + 2,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "new KeyManager",
    });
    saveRecord(box.file, rec);
    const before = await pending(d.address);
    const res = await bounded(h.accepted(box.file));
    expect(res).to.equal(
      `stray ${stray.hash} (nonce ${start + 1}, the re-send of entry #0) is pending on this node: wait for it to mine or drop, then re-run`,
    );
    expect(await pending(d.address), "nothing sent").to.equal(before);
    const e1 = load().txs[1];
    expect([e1.hash, e1.status], "entry #1 unsent").to.deep.equal([
      undefined,
      "sending",
    ]);
    return { d, start, stray: stray.hash };
  }

  it("GH: refused by name with nothing sent; once the stray mines, the resume completes", async function () {
    const { start } = await ghRecord();
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await bounded(h.accepted(box.file))).to.equal("accepted");
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
      [start + 2, "confirmed"],
    ]);
    expect(await h.created(start)).to.have.length(2);
    expect(await h.nonce()).to.equal(start + 3);
  });

  it("GH: once the stray drops, the gap is refused by name with nothing sent; the operator's fill is counted as its replacement and the resume completes", async function () {
    const { d, start, stray } = await ghRecord();
    await network.provider.request({
      method: "hardhat_dropTransaction",
      params: [stray],
    });
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await bounded(h.accepted(box.file))).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is dropped and its nonce is unfilled below record entry #1's nonce ${start + 2}: fill nonce ${start + 1} from the deployer (a cancel to self), then resume; if this node lags, re-run against a synced RPC`,
    );
    expect(await pending(d.address), "nothing sent").to.equal(start + 1);
    const fill = await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait();
    const lines: string[] = [];
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    await bounded(r.install().then(() => "accepted"));
    r.remove();
    expect(lines.join("\n")).to.contain(
      `nonce ${start + 1}: stray ${stray} replaced by ${fill!.hash}, outside the record, never adopted`,
    );
    expect(load().strays![0].replacedBy).to.equal(fill!.hash);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
      [start + 2, "confirmed"],
    ]);
    expect(await h.created(start)).to.have.length(2);
    expect(await h.accepted(box.file), "a re-run").to.equal("accepted");
    expect(await h.nonce()).to.equal(start + 3);
  });
});
