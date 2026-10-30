// Review D-2, round 14 (item C, R14-C6): the record-side survivor of lane
// G's round-13 lever (swarm-13/G/out/g-mutants-13-all.txt) its own kill
// row kills (g-kill-13.txt): V12, the window pass throwing on a block the
// node does not serve; lane G's BV12, ported.
import { expect } from "chai";
import { ethers } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 14 pins: lane G's round-13 record survivor", function () {
  this.timeout(300000);
  const s = strays();

  it("P-V12 (lane G BV12): a block the node answers null for inside the window is skipped; the re-send is still found", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    let sent: string | null = null;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        sent = await request({ method: a.method, params: [rest] });
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {});
    try {
      for (let i = 0; !sent && i < 500; i++) await s.wait(10);
      expect(sent, "the forwarded re-send went out").to.not.equal(null);
    } finally {
      r.remove();
      restore();
    }
    const from = s.load().txs[0].resendFrom!;
    expect(from, "the killed re-send left an intent").to.be.a("number");
    const lag = h.node(async (a) =>
      a.method === "eth_getBlockByNumber" && Number(a.params[0]) === from ? null : undefined,
    );
    let res: string;
    try {
      res = await s.resume();
    } finally {
      lag();
    }
    expect(res).to.equal("accepted");
    expect((s.load().strays ?? []).map((x) => x.hash)).to.include(sent);
  });
});
