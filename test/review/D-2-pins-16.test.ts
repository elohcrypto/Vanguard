// U2 round 16 (item B, lane G G15-2 = lane F F15-1; R16-C2): the record
// named a rate limit by `/429|too many requests/i` on the node's whole
// answer, so a 429 inside an amount, a nonce or an address read as a rate
// limit, while an Infura -32005 text, a compute-units text, "Rate limit
// exceeded" and ethers' "exceeded maximum retry limit" (what a read's
// exhausted 429 retry says: G15-3, item D) read as a lagging RPC. The
// acceptance table of lead-r15/g15-2-3-check-1926ed4.txt plus two rows,
// as a pin (R16-CS1): T1-T3 and T10 "other", T4-T9 "rate-limited"; T11-T13
// pin the -32005 code, a bare 429 answer and the \b after the status.
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 16 pins: the rate-limit wording is word-anchored and complete", function () {
  let real: typeof setTimeout;
  beforeEach(() => {
    real = global.setTimeout;
    (global as any).setTimeout = (f: any) => real(f, 0);
  });
  afterEach(() => {
    (global as any).setTimeout = real;
  });
  const refusal = async (msg: string) => {
    const e: any = {
      from: "0x00000000000000000000000000000000000000aa",
      to: null,
      value: "0",
      dataHash: ethers.keccak256("0x6001"),
      data: "0x6001",
      nonce: 5,
      block: 100,
      status: "sent",
      hash: "0x" + "ab".repeat(32),
      label: "x",
    };
    const raw = async (m: string) => {
      if (m === "eth_getTransactionCount") return "0x5";
      if (m === "eth_blockNumber") return "0x70";
      if (m === "eth_sendTransaction") throw new Error(msg);
      return null;
    };
    const out = await new EntryChain(h.fused(raw), { chainId: 11155111, txs: [e] } as any, 1, () => {}, () => {})
      .receipt(e)
      .then((x) => x, (x) => x);
    expect(out).to.be.instanceOf(RecordRefusal);
    return out.message;
  };
  const RATE = /: the RPC rate-limited the send; kept in the record, wait, then resume$/;
  const LAG = /: a lagging or inconsistent RPC; kept in the record, resume against a synced RPC$/;
  const rows: [string, string, RegExp][] = [
    ["T1", "insufficient funds for gas * price + value: balance 4290000", LAG],
    ["T2", "nonce too low: next nonce 429", LAG],
    ["T3", "sender 0x4290aB00000000000000000000000000000000", LAG],
    ["T4", "project ID request rate exceeded", RATE],
    ["T5", "compute units per second capacity", RATE],
    ["T6", "Rate limit exceeded", RATE],
    ["T7", "exceeded maximum retry limit", RATE],
    ["T8", "HTTP 502: server response 429 Too Many Requests", RATE],
    ["T9", "-32005 project ID request rate exceeded", RATE],
    // R16-CS1: the \b before the status word keeps "opcode" out.
    ["T10", "invalid opcode 429 at pc 7", LAG],
    // One row per remaining alternative of the rule, so none drops unseen.
    ["T11", '{"code":-32005,"message":"daily request count exceeded"}', RATE],
    ["T12", "429", RATE],
    ["T13", "response 4291 ms", LAG],
  ];
  for (const [id, msg, want] of rows)
    it(`${id}: "${msg}" is ${want === RATE ? "a rate limit" : "another failure"}`, async function () {
      expect(await refusal(msg)).to.match(want);
    });
});
