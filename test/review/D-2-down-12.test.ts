// Review D-2, round 12 (item A2, lane G GG11-2, LOW; R12-C1): a refused
// connection is provably pre-send. Hardhat's HttpProvider throws a
// HardhatError with no `code` for ECONNREFUSED (NODE_IS_NOT_RUNNING,
// number 108) and for its request timeout (NETWORK_TIMEOUT, 109), so
// round 11 kept a down signer's stale intent: a day later a killed
// re-send sat more than 5000 blocks past it and needed DEPLOY_FILL_HASH
// (round 10's GB-C again). Number 108 now drops the intent the send set,
// like a JSON-RPC refusal; the timeout and every other transport failure
// keep it. A3: behind a foreign signer that launders a forwarded send
// into a JSON-RPC error and drops the nonce, the mined re-send has no
// intent; the fill refuses its hash and names the by-hand strays row.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { HardhatError } from "hardhat/internal/core/errors";
import { ERRORS } from "hardhat/internal/core/errors-list";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 12: a refused connection drops the intent; a timeout keeps it", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);

  const refused = () =>
    new HardhatError(
      ERRORS.NETWORK.NODE_IS_NOT_RUNNING,
      { network: "remote" },
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1248"), {
        code: "ECONNREFUSED",
      }),
    );
  const timeout = () =>
    new HardhatError(
      ERRORS.NETWORK.NETWORK_TIMEOUT,
      {},
      Object.assign(new Error("timeout"), { type: "request-timeout" }),
    );

  /** Entry #0 mined and hidden; a resume whose re-send throws `mk()`. */
  async function downResume(mk: () => Error) {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") throw mk();
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(s.box.file)).to.not.equal("accepted");
    } finally {
      restore();
    }
    return { start, hide };
  }

  it("GB-C, a refused connection (HH108): the intent goes; a day later a killed re-send is found without the fill", async function () {
    const { start, hide } = await downResume(refused);
    expect(s.load().txs[0], "a refused connection leaves no intent").to.not.have.property("resendFrom");
    await network.provider.request({ method: "hardhat_mine", params: [ethers.toQuantity(5001)] });
    // day 2: a re-send forwarded (nonce dropped) and killed before its record
    let sent = false;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        await request({ method: a.method, params: [rest] });
        sent = true;
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {});
    for (let i = 0; !sent && i < 300; i++) await s.wait(5);
    r.remove();
    restore();
    expect(await s.resume(), "found without a manual fill").to.equal("accepted");
    expect(s.load().strays ?? []).to.have.length(1);
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("control, the request timeout (HH109): the intent is kept", async function () {
    await downResume(timeout);
    expect(s.load().txs[0].resendFrom, "a timeout may have forwarded the send").to.be.a("number");
  });

  it("A3, a foreign signer (forwards, launders the transport failure into code -32000, drops the nonce): the fill refuses the stray's hash and names the by-hand strays row", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    let mined = "";
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        mined = await request({ method: a.method, params: [rest] });
        throw Object.assign(new Error("socket hang up"), { code: -32000 });
      }
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(s.box.file)).to.contain("the node answered: socket hang up");
    } finally {
      restore();
    }
    expect(s.load().txs[0], "today's behaviour: the intent dropped").to.not.have.property("resendFrom");
    expect(await s.resume()).to.contain(`nonce ${start + 1} is no entry's and no stray's`);
    process.env.DEPLOY_FILL_HASH = mined;
    expect(await s.resume()).to.equal(
      `DEPLOY_FILL_HASH ${mined} carries entry #0 (${s.load().txs[0].label})'s payload at nonce ${start + 1}, but the record keeps no re-send intent of that entry from before its block: add it to strays by hand (runbook 02a, "A stray recorded by hand"), then resume without DEPLOY_FILL_HASH: refusing; unset DEPLOY_FILL_HASH after the resume completes`,
    );
  });
});
