// Review D-2, round 10 (item D, lane G GB-C, LOW): round 9's `??=` kept
// the intent of a send the node REFUSED (it answered with an error, so
// nothing of that send entered a mempool). A day later a fresh re-send
// killed before its record sat more than 5000 blocks after that stale
// intent and needed the manual fill. A refused send leaves no intent of
// its own; a send whose reply never came keeps the earliest (R10-C3), so
// GB-A and GJ1/GJ2 stay closed.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 10: a refused send leaves no intent", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

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

  /** A resume whose re-send of entry #0 the signer refuses (signer down). */
  async function refusedResend(start: number, hide: string) {
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") throw new Error("signer down");
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(s.box.file)).to.contain("signer down");
    } finally {
      restore();
    }
  }

  it("GB-C: a refused send's intent is not kept: a fresh re-send killed a day later is found without DEPLOY_FILL_HASH", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    await refusedResend(start, hide);
    expect(s.load().txs[0], "no intent of a refused send").to.not.have.property(
      "resendFrom",
    );
    await mine(5001); // about a day on Sepolia
    const at = await ethers.provider.getBlockNumber();
    await killedResend(start, hide);
    expect(s.load().txs[0].resendFrom, "the fresh intent").to.equal(at);
    expect(await s.resume(), "found from its own intent").to.equal("accepted");
    expect(s.load().strays).to.have.length(1);
  });

  it("R10-C3 pin: a refused send after a killed one keeps the killed send's intent: its stray is found", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    await killedResend(start, hide); // unrecorded stray at start + 1
    const first = s.load().txs[0].resendFrom!;
    await mine(1);
    await refusedResend(start, hide);
    expect(s.load().txs[0].resendFrom, "the earliest intent").to.equal(first);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays).to.have.length(1);
  });
});
