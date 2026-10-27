// Review D-2, round 9 (item A, lane G GA4 and GA3, MEDIUM, a regression
// from round 8's item J): a recorded, mined stray whose receipt (or hash)
// a lagging node does not show yet was "not counted"; account() then ran
// unrecorded(), which found the same transaction at the free nonce by its
// payload and listed it a second time. The lagging resume was accepted
// and every later healthy resume refused for good. A transaction a
// listed stray already names (its hash or its replacedBy) is never found
// again, and a stray is never its own replacement (G16): the lagging
// resume refuses by name and the healthy one completes.
import { expect } from "chai";
import { ethers } from "hardhat";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 9: a listed stray is never listed again", function () {
  this.timeout(300000);
  const s = strays();

  /** Entry #0 mined at start, its re-send mined at start + 1 as a stray. */
  async function minedStray() {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const restore = s.liar(start, s.load().txs[0].hash!);
    try {
      expect(await h.accepted(s.box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    expect(await h.nonce()).to.equal(start + 2);
    return { start, stray: s.load().strays![0].hash };
  }

  /** A resume behind a node that answers null for `methods` of `hash`. */
  async function lagging(hash: string, methods: string[]) {
    const restore = h.node(async (a) =>
      methods.includes(a.method) && a.params[0] === hash ? null : undefined,
    );
    const lines: string[] = [];
    try {
      return { res: await s.resume(lines), lines };
    } finally {
      restore();
    }
  }

  it("GA4: a mined stray whose receipt the node does not show yet is not found again: one row; the healthy resume completes", async function () {
    const { stray } = await minedStray();
    await lagging(stray, ["eth_getTransactionReceipt"]);
    expect(s.load().strays, "one row per stray").to.have.length(1);
    expect(await s.resume(), "the node caught up").to.equal("accepted");
    expect(s.load().strays, "still one row").to.have.length(1);
  });

  it("GA3: a mined stray the node hides by hash and receipt is found by the scan as itself: one row; the healthy resume completes", async function () {
    const { stray } = await minedStray();
    await lagging(stray, [
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
    ]);
    expect(s.load().strays, "one row per stray").to.have.length(1);
    expect(await s.resume(), "the node recovered").to.equal("accepted");
  });

  it("G16: a stray is never its own replacement: the lagging resume refuses by name, replacedBy stays unset", async function () {
    const { start, stray } = await minedStray();
    const before = JSON.stringify(s.load());
    const { res } = await lagging(stray, [
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
    ]);
    expect(res).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is not shown by this node by its hash, but its block holds it from ${s.load().strays![0].from} at nonce ${start + 1}: a lagging RPC; kept, re-run against a synced RPC`,
    );
    expect(JSON.stringify(s.load()), "nothing recorded").to.equal(before);
  });
});
