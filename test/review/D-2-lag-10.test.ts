// Review D-2, round 10 (item B, lane G GA4-text, LOW): when a free nonce
// is a listed stray's (its receipt lags on this node), the account
// refusal said "find that transaction and record it by hand"; following
// it adds a duplicate row. A free nonce a listed stray of the deployer
// holds now reads as a lagging RPC, by the stray's hash; "by hand" is
// said only for a nonce no stray lists.
import { expect } from "chai";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 10: a listed stray's lagging nonce is no lost transaction", function () {
  this.timeout(300000);
  const s = strays();

  it("GA4: a mined stray whose receipt the node does not show yet is named as lagging, not to be recorded by hand", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const restore = s.liar(start, s.load().txs[0].hash!);
    try {
      expect(await h.accepted(s.box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    const stray = s.load().strays![0].hash;
    const lag = h.node(async (a) =>
      a.method === "eth_getTransactionReceipt" && a.params[0] === stray
        ? null
        : undefined,
    );
    let res = "";
    try {
      res = await s.resume();
    } finally {
      lag();
    }
    expect(res).to.equal(
      `the deployer's nonce is ${start + 2} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume (stray ${stray} is listed but not shown mined on this node: a lagging RPC; resume against a synced RPC)`,
    );
    expect(res).to.not.contain("by hand");
    expect(s.load().strays, "one row").to.have.length(1);
    expect(await s.resume(), "the node caught up").to.equal("accepted");
  });
});
