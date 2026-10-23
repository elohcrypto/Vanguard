// Review D-2, round 4 (ported from the swarm's attack-u2r3-resend A1, A3b,
// A4 and A11 and the auditor's f-probe, inverted): the record's invariant
// holds whatever the signer does with the nonce field and whatever the
// record file holds. A transaction becomes an entry's only when it was
// mined from the entry's sender at the entry's nonce; a re-send goes out
// only with a payload that matches the entry's recorded hash and fields;
// a send that threw and that the flow sends again is settled the way a
// resume settles it, never waited on without a hash.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

type Hook = (a: any, request: any) => Promise<any> | undefined;

describe("D-2 round 4: the entry's nonce and payload, whatever the signer and the file say", function () {
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

  /** The provider with `hook` in front (undefined: the node answers). */
  function node(hook: Hook) {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    const shim = async (a: any) => {
      const r = await hook(a, request);
      return r !== undefined ? r : request(a);
    };
    p.request = shim;
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        shim({ method: m, params: x ?? [] });
    return () => {
      p.request = request;
      if (send) p.send = send;
    };
  }
  const mine = async (n: number) => {
    for (let i = 0; i < n; i++)
      await network.provider.request({ method: "evm_mine" });
  };
  async function created(start: number) {
    const [d] = await ethers.getSigners();
    const out: string[] = [];
    for (let n = start; n < (await h.nonce()); n++) {
      const a = ethers.getCreateAddress({ from: d.address, nonce: n });
      if ((await ethers.provider.getCode(a)) !== "0x") out.push(a);
    }
    return out;
  }
  const irData = async () =>
    (
      await (
        await ethers.getContractFactory("IdentityRegistry")
      ).getDeployTransaction()
    ).data;
  const kmData = async () =>
    (
      await (
        await ethers.getContractFactory("KeyManager")
      ).getDeployTransaction()
    ).data;
  /** Run 1 sends one IdentityRegistry deploy; `refuse`: the signer refuses it. */
  async function sendOne(refuse = false) {
    let once = refuse;
    const restore = node(async (a) => {
      if (a.method !== "eth_sendTransaction" || !once) return undefined;
      once = false;
      throw new Error("refused by the operator (#1)");
    });
    const r1 = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    try {
      await r1.install();
      await (
        await ethers.getContractFactory("IdentityRegistry")
      )
        .deploy()
        .catch(() => {});
    } finally {
      r1.remove();
      restore();
    }
  }
  /** Settle the record with every send that reaches the node counted. */
  async function settleCounting() {
    const sends: any[] = [];
    const restore = node(async (a) => {
      if (a.method === "eth_sendTransaction") sends.push(a.params[0]);
      return undefined;
    });
    try {
      const err = await h.settle(box.file, load()).then(
        () => "",
        (e: Error) => e.message,
      );
      return { err, sends };
    } finally {
      restore();
    }
  }

  it("A1: a signer that drops the nonce never has its transaction confirmed as the entry", async function () {
    await mine(20);
    const start = await h.nonce();
    await sendOne();
    expect(load().txs[0].status).to.equal("sent");
    const st = { lie: true, sends: 0 };
    const restore = node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        st.sends++;
        const { nonce, ...rest } = a.params[0]; // this signer ignores it
        return request({ method: a.method, params: [rest] });
      }
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
      await expect(h.settle(box.file, load())).to.be.rejectedWith(
        "kept in the record",
      );
      st.lie = false;
      for (let i = 0; i < 2; i++) {
        await expect(h.settle(box.file, load())).to.be.rejectedWith(
          new RegExp(
            `mined at nonce ${start + 1} from 0x[0-9a-fA-F]{40}, not as the entry recorded \\(nonce ${start} from .*kept in the record`,
          ),
        );
      }
    } finally {
      restore();
    }
    expect(st.sends, "the one re-send, nothing after").to.equal(1);
    const e = load().txs[0];
    expect([e.nonce, e.status, !!e.data, e.contract]).to.deep.equal([
      start,
      "sent",
      true,
      undefined,
    ]);
  });

  it("A4: a payload that does not match its recorded hash is refused, nothing sent", async function () {
    const start = await h.nonce();
    await sendOne(true);
    const rec = load();
    expect(rec.txs[0].status).to.equal("sending");
    rec.txs[0].data = await kmData();
    saveRecord(box.file, rec);
    const { err, sends } = await settleCounting();
    expect(err).to.match(
      /record entry #0 \(new IdentityRegistry\): its recorded data \(its keccak256 is not its dataHash\): an edited record; kept, nothing sent/,
    );
    expect(sends, "nothing sent").to.have.length(0);
    expect(await h.nonce()).to.equal(start);
    expect(load().txs[0].data).to.equal(await kmData());
  });

  for (const [field, bad] of [
    ["nonce", (e: any) => (e.nonce = String(e.nonce))],
    ["value", (e: any) => (e.value = "0x1")],
    ["sender", (e: any) => (e.from = "deployer")],
    ["target", (e: any) => (e.to = "0x1234")],
  ] as const) {
    it(`A4: a recorded ${field} that is not one is refused, nothing sent`, async function () {
      const start = await h.nonce();
      await sendOne(true);
      const rec = load();
      bad(rec.txs[0]);
      saveRecord(box.file, rec);
      const { err, sends } = await settleCounting();
      expect(err).to.match(
        new RegExp(
          `its recorded ${field} \\(not an? \\w+( \\w+)?\\): an edited record; kept, nothing sent`,
        ),
      );
      expect(sends).to.have.length(0);
      expect(await h.nonce()).to.equal(start);
    });
  }

  it("O07: an entry without a payload is refused on a healthy node, never sent empty", async function () {
    const start = await h.nonce();
    await sendOne(true);
    const rec = load();
    delete rec.txs[0].data;
    saveRecord(box.file, rec);
    const { err, sends } = await settleCounting();
    expect(err).to.contain("the entry has no recorded payload to send again");
    expect(sends).to.have.length(0);
    expect(await created(start)).to.have.length(0);
  });

  it("D (F3 LOW-4): a send that threw, sent again by the flow, is settled at its nonce, no hang", async function () {
    this.timeout(30000);
    const start = await h.nonce();
    let once = true;
    const restore = node(async (a) => {
      if (a.method !== "eth_sendTransaction" || !once) return undefined;
      once = false;
      throw new Error("refused by the operator (#1)");
    });
    const lines: string[] = [];
    const r = new Recorder(box.file, await h.fresh(box.file), 1, (m) =>
      lines.push(m),
    );
    const flow = async () => {
      const F = await ethers.getContractFactory("IdentityRegistry");
      await expect(F.deploy()).to.be.rejectedWith("refused by the operator");
      const c = await F.deploy();
      await c.waitForDeployment();
      await r.finish();
    };
    // a real timer (setTimeout is shortened here): a hang fails by name
    // and still removes the hook, so no later test runs under it
    const hung = new Promise((_, ko) =>
      realST(() => ko(new Error("the retry hung (no hash) for 15 s")), 15000),
    );
    try {
      await r.install();
      await Promise.race([flow(), hung]);
    } finally {
      r.remove();
      restore();
    }
    expect(lines.join("\n")).to.match(
      new RegExp(`sent again at its nonce ${start}`),
    );
    expect(await created(start), "one deploy").to.have.length(1);
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
  });

  /**
   * M-1 pins: entry A (confirmed, nonce n) and an entry at the same nonce
   * after it. The node shows A's hash as `shown` (null: as the chain has
   * it). The later entry is dropped only when A's transaction is mined,
   * is A in every field, and the later entry is an intent ("sending").
   */
  async function m1(
    shown: (t: any) => any,
    later: { status: "sending" | "sent"; hash?: string },
    aHash: string | null = ethers.keccak256("0x01"),
  ) {
    const [d] = await ethers.getSigners();
    const n = await h.nonce();
    const rec = await h.fresh(box.file);
    const [dataA, dataE] = [await irData(), await kmData()];
    const base = { from: d.address, to: null, value: "0", nonce: n };
    rec.txs.push({
      ...base,
      dataHash: ethers.keccak256(dataA),
      block: await ethers.provider.getBlockNumber(),
      hash: aHash ?? undefined,
      status: "confirmed",
      label: "A",
    } as any);
    rec.txs.push({
      ...base,
      dataHash: ethers.keccak256(dataE),
      data: dataE,
      block: await ethers.provider.getBlockNumber(),
      ...later,
      label: "E",
    } as any);
    rec.startNonce = n - 1; // A is counted as mined before n
    saveRecord(box.file, rec);
    const tx = {
      hash: aHash ?? undefined,
      from: d.address,
      nonce: ethers.toQuantity(n),
      to: null,
      value: "0x0",
      input: dataA,
      blockNumber: "0x1",
    };
    const restore = node(async (a) =>
      a.method === "eth_getTransactionByHash" && a.params[0] === tx.hash
        ? shown(tx)
        : undefined,
    );
    try {
      return await h.settle(box.file, load()).then(
        () => "",
        (e: Error) => e.message,
      );
    } finally {
      restore();
    }
  }

  it("M-1: an intent at a mined earlier entry's nonce, that entry as recorded, is dropped", async function () {
    await m1((t) => t, { status: "sending" });
    expect(load().txs.map((t) => t.label)).to.deep.equal(["A"]);
  });

  it("M-1: an earlier entry's hash mined at another nonce drops nothing", async function () {
    await m1((t) => ({ ...t, nonce: ethers.toQuantity(Number(t.nonce) + 1) }), {
      status: "sending",
    });
    expect(load().txs.map((t) => t.label)).to.deep.equal(["A", "E"]);
  });

  it("M-1 (O12, Z3): an earlier entry's hash mined as another transaction drops nothing", async function () {
    await m1((t) => ({ ...t, input: "0x" }), { status: "sending" });
    expect(load().txs.map((t) => t.label)).to.deep.equal(["A", "E"]);
  });

  it("M-1 (O13, Z2): an earlier entry's transaction still pending drops nothing", async function () {
    await m1((t) => ({ ...t, blockNumber: null }), { status: "sending" });
    expect(load().txs.map((t) => t.label)).to.deep.equal(["A", "E"]);
  });

  it("M-1 (O14): a sent entry at a mined earlier entry's nonce is never dropped", async function () {
    await m1((t) => t, { status: "sent", hash: ethers.keccak256("0x02") });
    expect(load().txs.map((t) => t.label)).to.deep.equal(["A", "E"]);
  });

  it("M-1 (O15): an earlier entry without a hash is no evidence", async function () {
    await m1((t) => t, { status: "sending" }, null);
    expect(load().txs.map((t) => t.label)).to.deep.equal(["A", "E"]);
  });
});

describe("D-2 round 4: a re-send's fields and sameTx, pinned", function () {
  const B = "0x00000000000000000000000000000000000000bb";
  const H2 = "0x" + "ef".repeat(32);
  const entry = (over = {}): any => ({
    from: "0x00000000000000000000000000000000000000aa",
    to: null,
    value: "0",
    dataHash: ethers.keccak256("0x6001"),
    data: "0x6001",
    nonce: 5,
    block: 100,
    status: "sending",
    label: "x",
    ...over,
  });
  const chain = (raw: any, e: any) =>
    new EntryChain(
      raw,
      { chainId: 11155111, txs: [e] } as any,
      1,
      () => {},
      () => {},
    );
  /** A node that knows no hash and leaves nonce 5 unused; sends counted. */
  const unknown =
    (sends: any[]) =>
    async (m: string, p: any[] = []) =>
      m === "eth_getTransactionCount"
        ? "0x5"
        : m === "eth_sendTransaction"
          ? (sends.push(p[0]), H2)
          : m === "eth_blockNumber"
            ? "0x70"
            : null;

  it('O08: an intent sent again is "sent" with its new hash, also when refused after', async function () {
    const e = entry();
    const sends: any[] = [];
    const out = await chain(unknown(sends), e)
      .receipt(e)
      .then(
        (r) => r,
        (x) => x,
      );
    expect(out).to.be.instanceOf(RecordRefusal);
    expect([e.status, e.hash, sends.length]).to.deep.equal(["sent", H2, 1]);
  });

  it("O02, Z7: an entry is sent again with its recorded value, target and sender", async function () {
    const e = entry({ to: B, value: "5" });
    const sends: any[] = [];
    await chain(unknown(sends), e)
      .receipt(e)
      .catch(() => {});
    expect(sends).to.deep.equal([
      { from: e.from, to: B, value: "0x5", data: "0x6001", nonce: "0x5" },
    ]);
  });

  it("Z14, Z15: sameTx compares the calldata and the nonce, not only the value", function () {
    const e = entry({ to: B, value: "5" });
    const t = {
      from: e.from,
      nonce: "0x5",
      to: B,
      value: "0x5",
      input: "0x6001",
    };
    const c = chain(async () => null, e);
    expect(c.sameTx(e, t)).to.equal(true);
    expect(c.sameTx(e, { ...t, input: "0x6002" })).to.equal(false);
    expect(c.sameTx(e, { ...t, nonce: "0x6" })).to.equal(false);
  });
});
