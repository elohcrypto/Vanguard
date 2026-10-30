// Review D-2, round 13 (item B, lane G R1/R1b, lane F F-7, lead M1;
// R13-C3): unrecorded() called findMined once per free nonce, so K free
// nonces cost K x 5001 block reads (19,614 for K = 4, lead-attack12-G-R1)
// and the same again on every resume. Now the window [earliest intent,
// +5000] is read once per resume into the deployer's transactions by
// nonce, and every free nonce is answered from it: at most 5001 reads per
// resume whatever K, none on a clean path. A nonce unrecorded past the
// window still costs one pass on each resume until it is recorded.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 13: the window is read once per resume", function () {
  this.timeout(900000);
  const s = strays();
  const mine = (n: number) =>
    network.provider.request({ method: "hardhat_mine", params: [ethers.toQuantity(n)] });

  /** Entry #0 mined and hidden; its re-send killed unsent: an intent only. */
  async function intentOnly() {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    let sent = false;
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") {
        sent = true;
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
      expect(sent, "the re-send was tried").to.equal(true);
    } finally {
      r.remove();
      restore();
    }
    expect(s.load().txs[0].resendFrom, "an intent").to.be.a("number");
    return start;
  }

  /** `f`'s answer and its eth_getBlockByNumber reads (no fuse: h.node's stops at 5000). */
  async function reads(f: () => Promise<string>) {
    let n = 0;
    const p: any = network.provider;
    const [request, send] = [p.request.bind(p), p.send?.bind(p)];
    const shim = (a: any) => {
      if (a.method === "eth_getBlockByNumber") n++;
      return request(a);
    };
    p.request = shim;
    if (send) p.send = (m: string, x?: unknown[]) => shim({ method: m, params: x ?? [] });
    try {
      return { res: await f(), n };
    } finally {
      p.request = request;
      if (send) p.send = send;
    }
  }

  it("R1: four free nonces used late in the window, the head far past: at most 5001 reads per resume, the refusal unchanged", async function () {
    const [d] = await ethers.getSigners();
    const start = await intentOnly();
    await mine(4900);
    for (let i = 0; i < 4; i++) await d.sendTransaction({ to: d.address, nonce: start + 1 + i });
    await mine(6000);
    const want = `the deployer's nonce is ${start + 5} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume (nonces ${[1, 2, 3, 4].map((i) => start + i).join(", ")} are no entry's and no stray's: find those transactions and record them by hand)`;
    for (const k of ["first", "second"]) {
      const a = await reads(() => s.resume());
      expect(a.res, `${k} resume`).to.equal(want);
      expect(a.n, `${k} resume's block reads`).to.be.at.most(5001);
    }
  });

  it("R1b: one nonce unrecorded past the window: one pass per resume, refused with the window's text each time", async function () {
    const [d] = await ethers.getSigners();
    const start = await intentOnly();
    await mine(5100);
    await d.sendTransaction({ to: d.address, nonce: start + 1 });
    for (const k of ["first", "second"]) {
      const a = await reads(() => s.resume());
      expect(a.res, `${k} resume`).to.contain(`nonce ${start + 1}: the chain head`);
      expect(a.res).to.contain("is more than 5000 blocks past entry #0");
      expect(a.n, `${k} resume's block reads`).to.be.at.most(5001);
    }
  });

  it("control: a clean resume reads no block", async function () {
    await h.sendOne(s.box.file);
    const a = await reads(() => s.resume());
    expect(a.res).to.equal("accepted");
    expect(a.n).to.equal(0);
  });
});
