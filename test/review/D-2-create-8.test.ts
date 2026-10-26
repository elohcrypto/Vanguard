// Review D-2, round 8 (the round-7 attacker G's GA1, inverted): confirm()
// pinned the receipt's contractAddress as the entry's contract whenever
// its code matched, so a receipt naming ANOTHER contract with the right
// code was accepted. A creation's contract is the CREATE address of its
// sender and nonce: a receipt naming another is refused by name (a lying
// node), nothing set; the next healthy run completes with the real one.
import { expect } from "chai";
import { ethers } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 8: a creation's contract is its CREATE address", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;

  it("GA1: a receipt naming another contract (with the right code) is refused by name; nothing pinned; the healthy resume pins the CREATE address", async function () {
    const [d] = await ethers.getSigners();
    const IR = await ethers.getContractFactory("IdentityRegistry");
    const other = await (await IR.deploy()).waitForDeployment();
    const otherAt = await other.getAddress();
    const n = await h.nonce();
    const mine = ethers.getCreateAddress({ from: d.address, nonce: n });
    const restore = h.node(async (a, request) => {
      if (a.method !== "eth_getTransactionReceipt") return undefined;
      const r = await request(a);
      return r?.contractAddress ? { ...r, contractAddress: otherAt } : r;
    });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    let err = "";
    try {
      await r.install();
      await IR.deploy();
      await r.finish().catch((e: Error) => (err = e.message));
    } finally {
      r.remove();
      restore();
    }
    expect(err).to.equal(
      `record entry #0 (new IdentityRegistry): the receipt names ${otherAt} as the contract created, not ${mine}, the CREATE address of ${d.address} at nonce ${n}: an inconsistent RPC; kept, re-run against a synced RPC`,
    );
    const m = r.rec.txs[0];
    expect([m.status, m.contract, m.codeHash], "nothing set").to.deep.equal([
      "sent",
      undefined,
      undefined,
    ]);
    expect(load().txs[0].contract).to.equal(undefined);
    expect(await h.accepted(box.file), "healthy resume").to.equal("accepted");
    expect(load().txs[0].contract).to.equal(mine);
    expect(load().txs[0].codeHash).to.equal(
      ethers.keccak256(await ethers.provider.getCode(mine)),
    );
  });
});
