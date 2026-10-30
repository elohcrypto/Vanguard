// Review D-2, round 8 (the round-7 attacker G's GG8, inverted): an unsent
// intent recorded at a pending stray's own nonce (an old record, or a
// stale pending count) is dropped once the stray is mined. heldByStray
// read only the stray's own hash, so after the operator's cancel replaced
// the stray the intent was never dropped and every resume refused "used
// nonce N for a transaction that is not record entry #k". A replaced
// stray's transaction is its replacement's: s.replacedBy ?? s.hash.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 8: an intent at a replaced stray's nonce is stale", function () {
  this.timeout(180000);
  const s = strays();

  it("GG8: the operator's cancel replaces the pending stray; the dead intent at its nonce is dropped and the resume completes", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await s.pendingStray();
    const data = await s.keyManager();
    const rec = s.load();
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: start + 1,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "new KeyManager",
    });
    saveRecord(s.box.file, rec);
    expect(await s.resume()).to.contain("is pending on this node");
    await s.drop(stray);
    const fill = await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    const lines: string[] = [];
    expect(await s.resume(lines), "the runbook's cancel to self").to.equal(
      "accepted",
    );
    expect(lines.join("\n")).to.contain(
      `   ↩️  new KeyManager: its nonce ${start + 1} is stray ${stray}'s (an intent read from a lagging RPC, never sent); dropped from the record`,
    );
    expect(s.load().txs.map((t) => t.label)).to.deep.equal([
      "new IdentityRegistry",
    ]);
    expect(s.load().strays![0].replacedBy).to.equal(fill.hash);
    expect(await h.nonce()).to.equal(start + 2);
    expect(await h.created(start), "no KeyManager sent").to.have.length(1);
  });
});
