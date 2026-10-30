// Review D-2, round 11 (item A, lane G GH10-1 and lane F F1, MEDIUM):
// round 10's resend() deleted the intent on ANY exception from
// eth_sendTransaction, reading it as "the node refused the send". A
// transport failure after the send left (a proxy that forwards and then
// answers 502, a request timeout) throws too: the send mines as a stray
// with no intent to scan from, and every later healthy resume refused
// "find that transaction and record it by hand". Only a JSON-RPC error
// answer (a numeric `code`: the node answered, nothing is out) drops the
// intent it set (R11-C1). Lane G's GH-* cases: fwd-error and fwd-timeout
// are the red ones; refuse, fwd-empty, fwd-short, fwd-other the controls.
import { expect } from "chai";
import { ethers } from "hardhat";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 11: a transport failure after the send keeps the intent", function () {
  this.timeout(300000);
  const s = strays();

  /** A resume whose re-send of entry #0 the node answers as `mode` says. */
  async function resumeWith(start: number, hide: string, mode: string) {
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        if (mode === "refuse")
          throw Object.assign(new Error("signer down"), { code: -32000 });
        await request({ method: a.method, params: [rest] });
        if (mode === "fwd-error") throw new Error("502 bad gateway");
        if (mode === "fwd-timeout")
          throw Object.assign(new Error("request timeout"), {
            code: "TIMEOUT",
          });
        if (mode === "fwd-empty") return "";
        if (mode === "fwd-short") return "0x1234";
        return hide; // fwd-other: another transaction's hash
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      return await h.accepted(s.box.file);
    } finally {
      restore();
    }
  }

  for (const mode of [
    "refuse",
    "fwd-error",
    "fwd-timeout",
    "fwd-empty",
    "fwd-short",
    "fwd-other",
  ]) {
    const sent = mode !== "refuse";
    it(`GH-${mode}: the re-send ${sent ? "left and mined" : "was refused (code -32000)"}; a healthy resume completes${sent ? ", the stray recorded once" : ""}`, async function () {
      const start = await h.nonce();
      await h.sendOne(s.box.file);
      const hide = s.load().txs[0].hash!;
      expect(await resumeWith(start, hide, mode)).to.not.equal("accepted");
      if (sent)
        expect(s.load().txs[0].resendFrom, "the intent is kept").to.be.a(
          "number",
        );
      else
        expect(s.load().txs[0], "a refused send leaves no intent").to.not.have.property(
          "resendFrom",
        );
      expect(await s.resume(), "a healthy chain and record").to.equal(
        "accepted",
      );
      expect(s.load().strays ?? []).to.have.length(sent ? 1 : 0);
      expect(await h.nonce()).to.equal(start + (sent ? 2 : 1));
    });
  }
});
