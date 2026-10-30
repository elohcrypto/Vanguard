// Review D-2, round 3 (ported from the swarm's attack-u2r2-lag, inverted):
// a recorded entry is never dropped and never planned again at a new
// nonce. A node that lags (LA, LB, LC), lies (LD), reorgs a mined entry
// away (LF), evicts it, swallows it or has its send refused leaves the
// entry in the record; a resume sends it again at its recorded nonce with
// its recorded payload or adopts what mined there, so whatever a resume
// against a bad node does, a healthy resume ends with the contract
// deployed exactly once.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

type Hook = (a: any, request: any) => Promise<any> | undefined;

describe("D-2 a recorded entry stays at its nonce whatever the node says", function () {
  this.timeout(600000);
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

  /** A node K blocks behind once `st.on` (head, receipts, hashes, counts); `hook` first. */
  function node(K: number, hook?: Hook) {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    const st = { on: false, headOnly: false };
    const shim = h.fused(async (a: any) => {
      if (hook) {
        const r = await hook(a, request);
        if (r !== undefined) return r;
      }
      if (st.headOnly && a.method === "eth_blockNumber")
        return ethers.toQuantity(Number(await request(a)) - K);
      if (!st.on) return request(a);
      const real = Number(await request({ method: "eth_blockNumber" }));
      const seen = real - K;
      const m = a.method;
      if (m === "eth_blockNumber") return ethers.toQuantity(seen);
      if (
        m === "eth_getTransactionReceipt" ||
        m === "eth_getTransactionByHash"
      ) {
        const t = await request({
          method: "eth_getTransactionByHash",
          params: [a.params[0]],
        });
        if (t && t.blockNumber && Number(t.blockNumber) > seen) return null;
        return request(a);
      }
      if (m === "eth_getTransactionCount")
        return request({
          method: m,
          params: [a.params[0], ethers.toQuantity(Math.min(seen, real))],
        });
      return request(a);
    });
    p.request = shim;
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        shim({ method: m, params: x ?? [] });
    return {
      st,
      restore: () => {
        p.request = request;
        if (send) p.send = send;
      },
    };
  }

  /** Contracts the deployer created from nonce `start` on. */
  async function created(start: number) {
    const [d] = await ethers.getSigners();
    const out: string[] = [];
    for (let n = start; n < (await h.nonce()); n++) {
      const a = ethers.getCreateAddress({ from: d.address, nonce: n });
      if ((await ethers.provider.getCode(a)) !== "0x") out.push(a);
    }
    return out;
  }
  const mine = async (n: number) => {
    for (let i = 0; i < n; i++)
      await network.provider.request({ method: "evm_mine" });
  };
  const deployIR = async () => {
    const c = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await c.waitForDeployment();
  };
  /** Run 1: the recorder sends one IdentityRegistry deploy and stops. */
  async function sendOne(confirmations = 1) {
    const r1 = new Recorder(
      box.file,
      await h.fresh(box.file),
      confirmations,
      () => {},
    );
    await r1.install();
    await (
      await ethers.getContractFactory("IdentityRegistry")
    )
      .deploy()
      .catch(() => {});
    r1.remove();
  }

  /**
   * Resume against `bad` (refused with the entry kept, or settled), then
   * a healthy resume: no refusal, the flow replays the one entry, one
   * contract made, at the entry's recorded nonce.
   */
  async function resumes(start: number, bad: () => void, good: () => void) {
    bad();
    const r2 = new Recorder(box.file, load(), 1, () => {});
    const err = await r2.install().then(
      () => "",
      (e: Error) => e.message,
    );
    r2.remove();
    if (err)
      expect(err).to.match(/kept in the record, resume against a synced RPC/);
    expect(load().txs, "the entry is kept").to.have.length(1);
    expect(load().txs[0].nonce).to.equal(start);
    good();
    const r3 = new Recorder(box.file, load(), 1, () => {});
    await r3.install();
    try {
      await deployIR();
      await r3.finish();
      expect(r3.reused, "the flow replays the entry").to.equal(1);
    } finally {
      r3.remove();
    }
    expect(await created(start), "one deploy").to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
  }

  for (const K of [3, 5, 10]) {
    it(`LA K=${K}: head reads K behind at the send and at the resume`, async function () {
      await mine(20);
      const start = await h.nonce();
      const n = node(K);
      n.st.headOnly = true;
      try {
        await sendOne();
        n.st.headOnly = false;
        await resumes(
          start,
          () => (n.st.on = true),
          () => (n.st.on = false),
        );
      } finally {
        n.restore();
      }
    });
  }

  for (const K of [0, 1, 5]) {
    it(`LB lag ${K}: a slow signer sent 25 blocks after the intent, its reply lost`, async function () {
      await mine(20);
      const start = await h.nonce();
      let lose = true;
      const n = node(K, async (a, request) => {
        if (a.method !== "eth_sendTransaction" || !lose) return undefined;
        await mine(25);
        await request(a);
        lose = false;
        throw new Error("reply lost");
      });
      try {
        await sendOne();
        expect(load().txs[0].status).to.equal("sending");
        await resumes(
          start,
          () => (n.st.on = true),
          () => (n.st.on = false),
        );
      } finally {
        n.restore();
      }
    });
  }

  it("LC an older entry (intent block 30 earlier, no payload kept), a node 5 behind", async function () {
    await mine(40);
    const start = await h.nonce();
    const n = node(5);
    try {
      await sendOne();
      const rec: any = load();
      delete rec.txs[0].data; // made before round 3
      rec.txs[0].block -= 30;
      saveRecord(box.file, rec);
      await resumes(
        start,
        () => (n.st.on = true),
        () => (n.st.on = false),
      );
    } finally {
      n.restore();
    }
  });

  it("LD a node that answers counts from a stale state and no hash", async function () {
    await mine(20);
    const start = await h.nonce();
    const st = { lie: false };
    const n = node(0, async (a, request) => {
      if (!st.lie) return undefined;
      if (a.method === "eth_getTransactionCount") {
        const real = Number(await request({ method: "eth_blockNumber" }));
        return request({
          method: a.method,
          params: [a.params[0], ethers.toQuantity(real - 6)],
        });
      }
      if (
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt"
      )
        return null;
      return undefined;
    });
    try {
      await sendOne();
      await resumes(
        start,
        () => (st.lie = true),
        () => (st.lie = false),
      );
    } finally {
      n.restore();
    }
  });

  it("LF a reorg after a receipt: sent again at its nonce, never refused for good", async function () {
    await mine(12);
    const snap = await network.provider.request({ method: "evm_snapshot" });
    const start = await h.nonce();
    const r1 = new Recorder(box.file, await h.fresh(box.file), 3, () => {});
    await r1.install();
    const c = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await c.waitForDeployment(); // a receipt read; 3 confirmations wanted
    r1.remove();
    expect(load().txs[0].status).to.equal("sent");
    await network.provider.request({ method: "evm_revert", params: [snap] });
    expect(await h.nonce(), "the deploy is reorged away").to.equal(start);
    const lines: string[] = [];
    const r2 = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    await r2.install();
    try {
      await deployIR();
      await r2.finish();
    } finally {
      r2.remove();
    }
    expect(lines.join("\n")).to.match(/sent again at its nonce \d+/);
    expect(await created(start), "one deploy").to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
  });

  it("an eviction on a synced node is sent again at the same nonce, once", async function () {
    const start = await h.nonce();
    const lines: string[] = [];
    const r = new Recorder(box.file, await h.fresh(box.file), 1, (m) =>
      lines.push(m),
    );
    await r.install();
    try {
      await network.provider.send("evm_setAutomine", [false]);
      try {
        await (await ethers.getContractFactory("IdentityRegistry")).deploy();
        const [t] = await network.provider.send("eth_pendingTransactions", []);
        await network.provider.send("hardhat_dropTransaction", [t.hash]);
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      await r.finish();
    } finally {
      r.remove();
    }
    expect(lines.join("\n")).to.match(/sent again at its nonce \d+/);
    expect(await created(start), "one deploy").to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
  });

  /** Resume after run 1 left the entry unmined: sent again at its nonce. */
  async function sentAgain(start: number) {
    const lines: string[] = [];
    const r2 = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    await r2.install();
    try {
      await deployIR();
      await r2.finish();
      expect([r2.sent, r2.reused]).to.deep.equal([1, 1]);
    } finally {
      r2.remove();
    }
    expect(lines.join("\n")).to.match(
      new RegExp(`sent again at its nonce ${start}`),
    );
    expect(await created(start), "one deploy").to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
  }

  it("a send the node dropped before it mined is sent again at its nonce on resume", async function () {
    const start = await h.nonce();
    const r1 = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    await r1.install();
    await network.provider.send("evm_setAutomine", [false]);
    try {
      await (await ethers.getContractFactory("IdentityRegistry")).deploy();
      const [t] = await network.provider.send("eth_pendingTransactions", []);
      await network.provider.send("hardhat_dropTransaction", [t.hash]);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
      r1.remove();
    }
    expect(load().txs[0].status).to.equal("sent");
    await sentAgain(start);
  });

  it("a send the signer refused is sent again at its nonce on resume", async function () {
    const start = await h.nonce();
    let once = true;
    const n = node(0, async (a) => {
      if (a.method !== "eth_sendTransaction" || !once) return undefined;
      once = false;
      throw new Error("refused by the operator (#1)");
    });
    try {
      await sendOne();
    } finally {
      n.restore();
    }
    expect(load().txs[0].status).to.equal("sending");
    await sentAgain(start);
  });

  it("the hash is on disk before any read that follows its send (F2 LOW-2)", async function () {
    let sent = false;
    let onDisk: unknown = "no read after the send";
    const n = node(0, (a) => {
      if (a.method === "eth_sendTransaction") sent = true;
      else if (sent && onDisk === "no read after the send") {
        onDisk = load().txs[0].hash ?? null;
      }
      return undefined;
    });
    try {
      await sendOne();
    } finally {
      n.restore();
    }
    expect(onDisk).to.equal(load().txs[0].hash);
  });
});
