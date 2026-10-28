// Review D-2, round 13 (item D, R13-C4): pins for lane G's round-12
// lever survivors on the record side (swarm-12/G/out/g-mutants-12-rec):
// A05 (the refused-connection clause without the earlier-intent guard:
// lane G's R5, ported) and F05 (the fill's by-hand text naming entry #0
// whatever entry's payload it carries).
import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatError } from "hardhat/internal/core/errors";
import { ERRORS } from "hardhat/internal/core/errors-list";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 13 pins: lane G's round-12 record survivors", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);

  /** Entry #0 mined and hidden; its re-send forwarded with the nonce dropped, then the run killed. */
  async function killedResend() {
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
      expect(sent, "the re-send went out").to.not.equal(null);
    } finally {
      r.remove();
      restore();
    }
    return { start, hide };
  }

  it("P-A05 (lane G R5): a refused connection after an earlier killed forwarded re-send keeps the earlier intent", async function () {
    const { start, hide } = await killedResend();
    const kept = s.load().txs[0].resendFrom;
    expect(kept, "the killed forwarded re-send left an intent").to.be.a("number");
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction")
        throw new HardhatError(ERRORS.NETWORK.NODE_IS_NOT_RUNNING, { network: "remote" });
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      await h.accepted(s.box.file);
    } finally {
      restore();
    }
    expect(s.load().txs[0].resendFrom, "the earlier intent stays").to.equal(kept);
  });

  it("P-F05: the fill's by-hand text names the entry whose payload it carries (entry #1, not #0)", async function () {
    const [d] = await ethers.getSigners();
    const to = ethers.Wallet.createRandom().address;
    const start = await h.nonce();
    const r = new Recorder(s.box.file, await h.fresh(s.box.file), 1, () => {});
    try {
      await r.install();
      await (await ethers.getContractFactory("IdentityRegistry")).deploy();
      await (await d.sendTransaction({ to, value: 7n })).wait();
    } finally {
      r.remove();
    }
    const rec = s.load();
    expect(rec.txs.map((e) => e.nonce)).to.deep.equal([start, start + 1]);
    // entry #1's payload by hand at the free nonce start + 2, no intent
    const t = await (await d.sendTransaction({ to, value: 7n, nonce: start + 2 })).wait();
    process.env.DEPLOY_FILL_HASH = t!.hash;
    expect(await s.resume()).to.contain(
      `DEPLOY_FILL_HASH ${t!.hash} carries entry #1 (${rec.txs[1].label})'s payload at nonce ${start + 2}`,
    );
  });
});
