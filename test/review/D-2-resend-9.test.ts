// Review D-2, round 9 (item B, lane G GJ1 and GJ2, MEDIUM, round 8's item
// J incomplete): resend() wrote `resendFrom = head` on EVERY re-send, and
// the entries loop re-sends before account() runs, so after a kill with
// the re-send forwarded, any further resume against the same faulty
// backend moved resendFrom past the unrecorded stray's block: the stray
// was unfindable and "record it by hand" was permanent. The earliest
// intent is kept (`??=`). Round 10 (item A, R10-C1): round 9's clear of
// the field once the account balanced is deleted with its pin (a lagging
// pending count let it run while a re-send was out: D-2-keep-10); the
// two "no clear while" cases stay as controls.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 9: a re-send's intent keeps its earliest block", function () {
  this.timeout(300000);
  const s = strays();
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  /** The cX shape (D-2-unrecorded-8): killed while the re-send's reply is awaited. */
  async function killedResend(start: number, forward: boolean, hide: string) {
    let sent = false;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        if (forward) await request({ method: a.method, params: [rest] });
        sent = true;
        return new Promise(() => {}); // the reply never comes
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

  it("GJ1: a kill with the re-send forwarded, then another faulty resume whose re-send is recorded: the healthy resume finds the first stray and completes", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    await killedResend(start, true, hide); // unrecorded stray at start + 1
    const first = s.load().txs[0].resendFrom!;
    expect(s.load().strays ?? []).to.deep.equal([]);
    await mine(1); // a live chain moves on between the kill and the re-run
    const gas = ethers.toQuantity(BigInt(s.load().txs[0].gas!) - 1n);
    const restore = s.liar(start, hide, gas);
    try {
      await h.accepted(s.box.file);
    } finally {
      restore();
    }
    expect(s.load().strays, "stray #2 recorded").to.have.length(1);
    expect(s.load().txs[0].resendFrom, "the earliest intent").to.equal(first);
    expect(await s.resume(), "a healthy chain and record").to.equal(
      "accepted",
    );
    expect(s.load().strays, "both strays, each once").to.have.length(2);
    expect(await h.nonce()).to.equal(start + 3);
  });

  it("GJ2: two kills in a row, each with its re-send forwarded: the healthy resume finds both strays and completes", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    await killedResend(start, true, hide);
    const first = s.load().txs[0].resendFrom!;
    await mine(1);
    await killedResend(start, true, hide);
    expect(s.load().txs[0].resendFrom, "the earliest intent").to.equal(first);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays, "both strays, each once").to.have.length(2);
  });

  it("GJ3 (control): one kill, then the healthy resume recovers it", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await killedResend(start, true, s.load().txs[0].hash!);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays).to.have.length(1);
  });

  it("GJ5 (control): a transaction at the free nonce with entry #0's calldata to another target is refused", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await killedResend(start, false, s.load().txs[0].hash!);
    await (
      await d.sendTransaction({
        to: d.address,
        data: s.load().txs[0].data!,
        nonce: start + 1,
      })
    ).wait();
    const res = await s.resume();
    expect(res).to.contain("but the record accounts for");
    expect(res).to.contain(`nonce ${start + 1} is no entry's and no stray's`);
  });

  it("no clear while a nonce is free: the refused resume keeps the intent", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await killedResend(start, false, s.load().txs[0].hash!);
    const from = s.load().txs[0].resendFrom;
    expect(from).to.be.a("number");
    await (await d.sendTransaction({ to: d.address, nonce: start + 1 })).wait();
    expect(await s.resume()).to.contain(
      `nonce ${start + 1} is no entry's and no stray's`,
    );
    expect(s.load().txs[0].status, "the entry mined").to.equal("confirmed");
    expect(s.load().txs[0].resendFrom, "kept").to.equal(from);
  });

  it("no clear while the deployer has a transaction pending: a re-send still out is found once it mines", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await s.automine(false);
    await killedResend(start, true, s.load().txs[0].hash!); // pending
    const from = s.load().txs[0].resendFrom;
    expect(await s.resume(), "the pending re-send is not seen").to.equal(
      "accepted",
    );
    expect(s.load().txs[0].resendFrom, "kept").to.equal(from);
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await h.nonce()).to.equal(start + 2);
    expect(await s.resume(), "found from its intent").to.equal("accepted");
    expect(s.load().strays).to.have.length(1);
  });
});
