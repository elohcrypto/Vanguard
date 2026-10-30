// Review D-2, round 10 (item A, lane G GB-A and GB-A2, MEDIUM, from round
// 9's item B): account() cleared every spent entry's resendFrom once the
// account balanced, no nonce was free and the deployer's pending count
// equalled its nonce. A node whose pending count lags (a load-balanced
// RPC, a signer on another node) met all four while a re-send was still
// in a mempool; once it mined, the stray was unfindable and every later
// resume refused "record it by hand" (the fill's second shape too: it
// needs an entry with an intent). The intent is kept for the life of the
// record: the healthy resume finds the stray by itself.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 10: a re-send's intent is never cleared", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);

  /** Killed while its re-send's reply is awaited; the node got the re-send. */
  async function killedResend(start: number, hide: string) {
    let sent = false;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        await request({ method: a.method, params: [rest] });
        sent = true;
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {});
    try {
      for (let i = 0; !sent && i < 500; i++) await s.wait(10);
      expect(sent, "the re-send went out").to.equal(true);
    } finally {
      r.remove();
      restore();
    }
  }

  /**
   * Entry #0 mined at start; a run killed with its re-send pending in
   * the mempool (automine off), then a resume behind a node whose pending
   * count reads as latest (it has not seen the re-send); then it mines.
   */
  async function laggingPending() {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await s.automine(false);
    await killedResend(start, s.load().txs[0].hash!);
    const pending = await network.provider.request({
      method: "eth_getTransactionCount",
      params: [d.address, "pending"],
    });
    expect(Number(pending), "the re-send is pending").to.equal(start + 2);
    const restore = h.node(async (a, request) =>
      a.method === "eth_getTransactionCount" && a.params[1] === "pending"
        ? request({ method: a.method, params: [a.params[0], "latest"] })
        : undefined,
    );
    try {
      expect(await s.resume(), "the lagging resume").to.equal("accepted");
    } finally {
      restore();
    }
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await h.nonce()).to.equal(start + 2);
    return { start };
  }

  it("GB-A: a lagging pending count never clears the intent: once the re-send mines, the healthy resume completes", async function () {
    await laggingPending();
    expect(await s.resume(), "a healthy chain and record").to.equal(
      "accepted",
    );
  });

  it("GB-A2: the stray is found by itself, counted once, and no DEPLOY_FILL_HASH is needed", async function () {
    const { start } = await laggingPending();
    const blk = await ethers.provider.getBlock("latest", true);
    const t = blk!.prefetchedTransactions.find((x) => x.nonce === start + 1)!;
    expect(process.env.DEPLOY_FILL_HASH).to.equal(undefined);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => [x.nonce, x.hash])).to.deep.equal([
      [start + 1, t.hash],
    ]);
    const before = JSON.stringify(s.load());
    expect(await s.resume(), "a re-run").to.equal("accepted");
    expect(JSON.stringify(s.load()), "nothing more recorded").to.equal(before);
    expect(s.load().txs[0].resendFrom, "the intent kept").to.be.a("number");
  });
});
