// U2 round 15 (item D, R15-C4): a pin per round-15 rule of item C that
// SignerTransport-15's rows leave unguarded: the record names a rate
// limit by its words in any case, with or without the status number.
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 15 pins: the rate-limited re-send", function () {
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

  it("P-C1: 'TOO MANY REQUESTS' without a 429 is a rate limit", async function () {
    expect(await refusal("upstream: TOO MANY REQUESTS")).to.match(/the RPC rate-limited the send; kept in the record, wait, then resume$/);
  });

  it("P-C2: a bare 429 is a rate limit", async function () {
    expect(await refusal("HTTP 429")).to.match(/the RPC rate-limited the send; kept in the record, wait, then resume$/);
  });
});
