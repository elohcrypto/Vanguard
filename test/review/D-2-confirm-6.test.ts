// Review D-2, round 6 (the round-5 attacker G's G6, inverted): a plain
// error in the settle's code read leaves the entry as it was, so the flow's
// next retry settles it, never meets it "confirmed" without a code hash.
import { expect } from "chai";
import { ethers } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 6: a plain error reading a new contract's code leaves its entry unsettled", function () {
  this.timeout(120000);
  const box = h.files();
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(() => {
    (global as any).setTimeout = realST;
  });

  it("F (G6): after an eth_getCode reset in the retry's settle, the third attempt settles the same entry; one contract, the record complete", async function () {
    const start = await h.nonce();
    let refuse = true;
    let resent = false;
    let flake = true;
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction" && refuse) {
        refuse = false;
        throw new Error("refused by the operator (#1)");
      }
      if (a.method === "eth_sendTransaction") resent = true;
      if (a.method === "eth_getCode" && resent && flake) {
        flake = false;
        throw new Error("rpc connection reset");
      }
      return undefined;
    });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    const attempts: string[] = [];
    try {
      await r.install();
      for (let i = 0; i < 3; i++) {
        try {
          await (
            await (await ethers.getContractFactory("IdentityRegistry")).deploy()
          ).waitForDeployment();
          attempts.push("ok");
          break;
        } catch (e: any) {
          attempts.push(String(e.message).split("\n")[0]);
        }
      }
      await r.finish();
    } finally {
      r.remove();
      restore();
    }
    expect(attempts).to.deep.equal([
      "refused by the operator (#1)",
      "rpc connection reset",
      "ok",
    ]);
    const [mine] = await h.created(start);
    const e = loadRecord(box.file)!.txs[0];
    expect([e.status, e.contract, e.codeHash]).to.deep.equal([
      "confirmed",
      mine,
      ethers.keccak256(await ethers.provider.getCode(mine)),
    ]);
    expect(await h.created(start)).to.have.length(1);
    expect(await h.accepted(box.file)).to.equal("accepted");
  });
});
