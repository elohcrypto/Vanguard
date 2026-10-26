// Review D-2, round 5 (ported from the round-4 attacker's attack-u2r4-record
// D3, D4 and R4 and the auditor's f-probe-edit-order, inverted): a retry
// meets the entry whose settle threw until it is settled; two sends in
// flight take two nonces and a refusal reaches its caller and every later
// send; an edited record is refused before anything is read or sent.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 5: a retry, two sends in flight, an edited record", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(() => {
    (global as any).setTimeout = realST;
  });
  const { node, created } = h;
  const accepted = () => h.accepted(box.file);
  const sendOne = (refuse = false) => h.sendOne(box.file, refuse);
  const IR = () => ethers.getContractFactory("IdentityRegistry");
  /** The flow deploys one IdentityRegistry, catching and retrying up to 3 times. */
  async function retried(hook: h.Hook) {
    const restore = node(hook);
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    const attempts: string[] = [];
    try {
      await r.install();
      for (let i = 0; i < 3; i++) {
        try {
          await (await (await IR()).deploy()).waitForDeployment();
          attempts.push("ok");
          break;
        } catch (e: any) {
          attempts.push(String(e.message).slice(0, 40));
        }
      }
      await r.finish();
    } finally {
      r.remove();
      restore();
    }
    return attempts;
  }
  it("A (G4 D3): a plain error before the retry's re-send leaves the entry next; the third attempt settles it", async function () {
    const start = await h.nonce();
    let refuse = true;
    let flake = true;
    const attempts = await retried(async (a) => {
      if (a.method === "eth_sendTransaction" && refuse) {
        refuse = false;
        throw new Error("refused by the operator (#1)");
      }
      const latest =
        a.method === "eth_getTransactionCount" && a.params[1] === "latest";
      if (latest && !refuse && flake) {
        flake = false;
        throw new Error("rpc connection reset");
      }
      return undefined;
    });
    expect(attempts).to.deep.equal([
      "refused by the operator (#1)",
      "rpc connection reset",
      "ok",
    ]);
    expect(await created(start), "one contract").to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
    expect(await accepted(), "the record resumes").to.equal("accepted");
  });

  it("A (G4 D4): a plain error after the retry's re-send went out; the next retry settles the same entry", async function () {
    const start = await h.nonce();
    let refuse = true;
    let resent = false;
    let flake = true;
    const attempts = await retried(async (a) => {
      if (a.method === "eth_sendTransaction" && refuse) {
        refuse = false;
        throw new Error("refused by the operator (#1)");
      }
      if (a.method === "eth_sendTransaction") resent = true;
      if (a.method === "eth_getTransactionReceipt" && resent && flake) {
        flake = false;
        throw new Error("rpc connection reset");
      }
      return undefined;
    });
    expect(attempts).to.deep.equal([
      "refused by the operator (#1)",
      "rpc connection reset",
      "ok",
    ]);
    expect(
      await created(start),
      "the contract is deployed once",
    ).to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
    expect(await accepted(), "the record resumes").to.equal("accepted");
  });

  it("A: a plain error reading the last send's receipt leaves it for the next send to confirm", async function () {
    const start = await h.nonce();
    let first = "";
    let flake = false;
    const restore = node(async (a, request) => {
      if (a.method === "eth_sendTransaction" && !first) {
        first = await request(a);
        return first;
      }
      const its =
        a.method === "eth_getTransactionReceipt" && a.params[0] === first;
      if (its && flake) {
        flake = false;
        throw new Error("rpc connection reset");
      }
      return undefined;
    });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    try {
      await r.install();
      const ir = await (await IR()).deploy();
      await ir.waitForDeployment();
      flake = true; // the record's own read of the first receipt fails once
      const add = async () => (await ir.addAgent(h.AGENT)).wait();
      await expect(add()).to.be.rejectedWith("rpc connection reset");
      await add();
      await r.finish();
    } finally {
      r.remove();
      restore();
    }
    const txs = load().txs;
    expect(txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
      [start + 1, "confirmed"],
    ]);
    expect(txs[0].contract).to.equal((await created(start))[0]);
  });

  it("A: a send that threw after the node mined it, retried by the flow, is one contract (G4 D1, pinned)", async function () {
    const start = await h.nonce();
    let once = true;
    const attempts = await retried(async (a, request) => {
      if (a.method !== "eth_sendTransaction" || !once) return undefined;
      once = false;
      await request(a);
      throw new Error("timeout after the node accepted it");
    });
    expect(attempts).to.deep.equal([
      "timeout after the node accepted it",
      "ok",
    ]);
    expect(await created(start)).to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
  });

  it("A: a send the node holds pending when it threw is refused by name, one contract once it mines (G4 D2, pinned)", async function () {
    const start = await h.nonce();
    const automine = (on: boolean) =>
      network.provider.request({ method: "evm_setAutomine", params: [on] });
    await automine(false);
    let once = true;
    const restore = node(async (a, request) => {
      if (a.method !== "eth_sendTransaction" || !once) return undefined;
      once = false;
      await request(a);
      throw new Error("timeout after the node accepted it");
    });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    let err = "";
    try {
      await r.install();
      const F = await IR();
      await F.deploy().catch(() => {});
      await F.deploy().catch((e: Error) => (err = e.message));
    } finally {
      r.remove();
      restore();
      await automine(true);
      await network.provider.request({ method: "evm_mine" });
    }
    expect(err).to.contain(
      `nonce ${start} is pending with another transaction: wait for it to mine, then re-run`,
    );
    await h.settle(box.file, load());
    expect(await created(start)).to.have.length(1);
  });

  it("B (G4 R4): two sends in flight from one sender take two nonces: two contracts, both confirmed", async function () {
    const start = await h.nonce();
    let reads = 0;
    let release = () => {};
    const restore = node(async (a) => {
      if (a.method !== "eth_getTransactionCount" || a.params[1] !== "pending")
        return undefined;
      // the first send's nonce read waits for a second one, at most 3 s
      if (++reads === 1)
        await new Promise<void>((ok) => {
          release = ok;
          realST(ok, 3000);
        });
      else release();
      return undefined;
    });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    let out: PromiseSettledResult<any>[] = [];
    let finished = "";
    try {
      await r.install();
      const F = await IR();
      out = await Promise.allSettled([F.deploy(), F.deploy()]);
      finished = await r.finish().then(
        () => "",
        (e: Error) => e.message,
      );
    } finally {
      r.remove();
      restore();
    }
    expect(out.map((o) => o.status)).to.deep.equal(["fulfilled", "fulfilled"]);
    expect(finished).to.equal("");
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
      [start + 1, "confirmed"],
    ]);
    expect(await created(start)).to.have.length(2);
  });

  it("B, G19: a refused send reaches its caller and every later send is refused with it, nothing sent", async function () {
    const [, other] = await ethers.getSigners();
    const sends: string[] = [];
    const restore = node(async (a) => {
      if (a.method === "eth_sendTransaction") sends.push(a.params[0].from);
      return undefined;
    });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    let out: PromiseSettledResult<any>[] = [];
    let later = "";
    try {
      await r.install();
      r.refuseFrom({ ops: other.address });
      const F = await IR();
      out = await Promise.allSettled([F.connect(other).deploy(), F.deploy()]);
      later = await F.deploy().then(
        () => "",
        (e: Error) => e.message,
      );
    } finally {
      r.remove();
      restore();
    }
    const why = `ops ${other.address} is external`;
    expect(out.map((o) => o.status)).to.deep.equal(["rejected", "rejected"]);
    for (const o of out) expect((o as any).reason.message).to.contain(why);
    expect(later).to.contain(why);
    expect(sends, "nothing reached the node").to.deep.equal([]);
    expect(load().txs).to.deep.equal([]);
  });

  it("G4-G13: the nonce lookup adopts the entry's own transaction past another sender's at the same nonce", async function () {
    const [d, , , , , o] = await ethers.getSigners();
    const n = await h.nonce();
    const rec = await h.fresh(box.file);
    const { data } = await (await IR()).getDeployTransaction();
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: n,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "new IdentityRegistry",
    });
    saveRecord(box.file, rec);
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [o.address, ethers.toQuantity(n)],
    });
    await (await o.sendTransaction({ to: o.address })).wait(); // nonce n too
    await (await d.sendTransaction({ data, nonce: n })).wait(); // its reply lost
    expect(await accepted()).to.equal("accepted");
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [n, "confirmed"],
    ]);
  });

  it("C (F-1): an edited later entry is refused before anything is read or sent", async function () {
    const start = await h.nonce();
    await sendOne(true);
    const rec = load();
    const e0 = rec.txs[0];
    expect([e0.status, !!e0.hash, !!e0.data]).to.deep.equal([
      "sending",
      false,
      true,
    ]);
    const flip = e0.data!.endsWith("00") ? "01" : "00";
    rec.txs.push({
      ...e0,
      nonce: e0.nonce + 1,
      data: e0.data!.slice(0, -2) + flip,
    });
    saveRecord(box.file, rec);
    const seen: string[] = [];
    const restore = node(async (a) => {
      seen.push(a.method);
      return undefined;
    });
    let err = "";
    try {
      err = await accepted();
    } finally {
      restore();
    }
    expect(err).to.equal(
      "record entry #1 (new IdentityRegistry): its recorded data (its keccak256 is not its dataHash): an edited record; kept, nothing sent",
    );
    expect(seen, "nothing read or sent").to.deep.equal([]);
    expect(await h.nonce()).to.equal(start);
  });
});
