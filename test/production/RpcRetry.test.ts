import { expect } from "chai";

const { installRetry, isTransient } = require("../../demo/utils/RpcRetry");

/**
 * Task 5.15 (readiness review M-3): demo/utils/RpcRetry.js against a toy
 * chain. Reads retry on transient errors only, with backoff and a bound;
 * a send keeps one nonce, and after an unknown outcome the transaction
 * mined at that nonce is adopted only when it is the same one: nothing is
 * ever sent twice.
 */
describe("RpcRetry (bounded retry, no double send)", function () {
  const FROM = "0x00000000000000000000000000000000000000aa";
  const TO = "0x00000000000000000000000000000000000000bb";
  const err = (message: string, code?: string | number) =>
    Object.assign(new Error(message), code === undefined ? {} : { code });

  /** A chain whose eth_sendTransaction misbehaves per `plan` (one entry per call). */
  function chain(plan: string[] = []) {
    const c: any = {
      nonce: 7,
      pending: [] as any[],
      blocks: [[]] as any[][],
      sends: [] as any[],
      reads: 0,
      readFaults: [] as Error[],
      mine() {
        c.blocks.push(c.pending.splice(0));
        c.nonce += c.blocks[c.blocks.length - 1].length;
      },
      async request({ method, params }: any) {
        if (method === "eth_sendTransaction") {
          const tx = params[0];
          c.sends.push(tx);
          const step = plan.shift() ?? "ok";
          const t = {
            from: FROM,
            nonce: tx.nonce,
            to: tx.to,
            value: tx.value ?? "0x0",
            input: tx.data,
            hash: `0x${c.sends.length}`,
          };
          if (Number(tx.nonce) < c.nonce + c.pending.length && step !== "other")
            throw err("nonce too low");
          if (step === "reset-after") {
            c.pending.push(t);
            c.mine();
            throw err("read ECONNRESET", "ECONNRESET");
          }
          if (step === "reset-pending") {
            c.pending.push(t);
            throw err("socket hang up");
          }
          if (step === "reset-before")
            throw err("connect ETIMEDOUT", "ETIMEDOUT");
          if (step === "other") {
            c.pending.push({ ...t, input: "0xdead" });
            c.mine();
            throw err("read ECONNRESET", "ECONNRESET");
          }
          c.pending.push(t);
          c.mine();
          return t.hash;
        }
        c.reads++;
        if (c.readFaults.length) throw c.readFaults.shift();
        if (method === "eth_getTransactionCount")
          return `0x${(c.nonce + (params[1] === "pending" ? c.pending.length : 0)).toString(16)}`;
        if (method === "eth_blockNumber")
          return `0x${(c.blocks.length - 1).toString(16)}`;
        if (method === "eth_getBlockByNumber")
          return { transactions: c.blocks[Number(params[0])] ?? [] };
        if (method === "eth_chainId") return "0x7a69";
        throw err(`unexpected ${method}`);
      },
    };
    return c;
  }
  function hook(c: any, extra: any = {}) {
    const waits: number[] = [];
    const lines: string[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      if (c.pending.length) c.mine(); // time passes: the mempool mines
    };
    installRetry(c, { log: (m: string) => lines.push(m), sleep, ...extra });
    return { waits, lines };
  }
  const tx = { from: FROM, to: TO, data: "0x1234" };

  it("classifies: transient yes; revert, range cap, archive, others no", function () {
    for (const m of [
      "read ECONNRESET",
      "Too Many Requests error received from x",
      "daily request count exceeded, request rate limited",
      "Your app has exceeded its compute units per second capacity",
      "HH108: Network timeout",
      "502 Bad Gateway",
    ])
      expect(isTransient(err(m)), m).to.equal(true);
    expect(isTransient(err("x", -32005))).to.equal(true);
    // A rate-limit code or wording on a range cap or a revert is not one.
    expect(
      isTransient(err("query returned more than 10000 results", -32005)),
    ).to.equal(false);
    expect(
      isTransient(err("execution reverted: rate limit per wallet")),
    ).to.equal(false);
    expect(isTransient(err("missing trie node: request timed out"))).to.equal(
      false,
    );
    for (const m of [
      "execution reverted: Ownable: caller is not the owner",
      "query returned more than 10000 results",
      "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range",
      "missing trie node abc (path ) state 0x is not available",
      "header not found",
      "insufficient funds for gas * price + value",
    ])
      expect(isTransient(err(m)), m).to.equal(false);
  });

  it("retries a read with backoff, then gives up at the bound", async function () {
    const c = chain();
    c.readFaults = [
      err("read ECONNRESET", "ECONNRESET"),
      err("rate limit exceeded", -32005),
    ];
    const { waits, lines } = hook(c);
    expect(await c.request({ method: "eth_chainId" })).to.equal("0x7a69");
    expect(waits).to.deep.equal([500, 1000]);
    expect(lines.join("\n")).to.contain("retry 2/6");
    const d = chain();
    d.readFaults = Array.from({ length: 4 }, () => err("socket hang up"));
    hook(d, { retries: 2 });
    let thrown: any;
    await d.request({ method: "eth_chainId" }).catch((e: any) => (thrown = e));
    expect(thrown?.message).to.equal("socket hang up");
    expect(d.reads).to.equal(3);
  });

  it("scrubs the RPC URL's key from its retry lines", async function () {
    const c = chain();
    const url = "https://rpc.example/v3/APIKEY123456?k=QKEY99";
    c.readFaults = [
      err(`Too Many Requests from ${url} (key APIKEY123456, QKEY99)`),
    ];
    const lines: string[] = [];
    installRetry(c, {
      url,
      log: (m: string) => lines.push(m),
      sleep: async () => {},
    });
    await c.request({ method: "eth_chainId" });
    expect(lines.length).to.equal(1);
    for (const x of ["APIKEY123456", "QKEY99", "/v3/"])
      expect(lines[0]).to.not.contain(x);
  });

  it("never retries a revert, a range cap or a missing-state error", async function () {
    for (const m of [
      "execution reverted",
      "query returned more than 10000 results",
      "missing trie node",
    ]) {
      const c = chain();
      c.readFaults = [err(m)];
      const { waits } = hook(c);
      let thrown: any;
      await c
        .request({ method: "eth_chainId" })
        .catch((e: any) => (thrown = e));
      expect(thrown?.message, m).to.equal(m);
      expect(waits, m).to.deep.equal([]);
    }
  });

  it("pins the nonce before the first send and keeps a given one", async function () {
    const c = chain();
    hook(c);
    await c.request({ method: "eth_sendTransaction", params: [tx] });
    expect(Number(c.sends[0].nonce)).to.equal(7);
    await c.request({
      method: "eth_sendTransaction",
      params: [{ ...tx, nonce: "0x8" }],
    });
    expect(c.sends[1].nonce).to.equal("0x8");
  });

  it("a send dropped before the node saw it is resent with the same nonce", async function () {
    const c = chain(["reset-before"]);
    hook(c);
    const h = await c.request({ method: "eth_sendTransaction", params: [tx] });
    expect(c.sends.map((s: any) => Number(s.nonce))).to.deep.equal([7, 7]);
    expect(h).to.equal("0x2");
    expect(c.nonce).to.equal(8);
  });

  it("a send that mined before its reply was lost is adopted, not resent", async function () {
    const c = chain(["reset-after"]);
    const { lines } = hook(c);
    const h = await c.request({ method: "eth_sendTransaction", params: [tx] });
    expect(c.sends.length).to.equal(1);
    expect(h).to.equal("0x1");
    expect(lines.join("\n")).to.contain("adopted (not resent)");
  });

  it("a send left pending is adopted once mined, after 'nonce too low' on the retry", async function () {
    const c = chain(["reset-pending"]);
    // The pending one has not mined when the retry goes out.
    let first = true;
    const lines: string[] = [];
    installRetry(c, {
      log: (m: string) => lines.push(m),
      sleep: async () => {
        if (!first && c.pending.length) c.mine();
        first = false;
      },
    });
    const h = await c.request({ method: "eth_sendTransaction", params: [tx] });
    expect(c.sends.length).to.equal(2);
    expect(c.sends.every((s: any) => Number(s.nonce) === 7)).to.equal(true);
    expect(h).to.equal("0x1");
    expect(c.nonce).to.equal(8);
  });

  it("refuses when another transaction took the nonce, and resends nothing", async function () {
    const c = chain(["other"]);
    hook(c);
    let thrown: any;
    await c
      .request({ method: "eth_sendTransaction", params: [tx] })
      .catch((e: any) => (thrown = e));
    expect(thrown?.message).to.match(
      /went to another transaction .*nothing resent/,
    );
    expect(c.sends.length).to.equal(1);
  });

  it("refuses a nonce already mined before the first send: a stale pending count (review L-2)", async function () {
    const c = chain();
    const real = c.request;
    // A load-balanced RPC whose pending view lags its mined count.
    c.request = async (a: any) =>
      a.method === "eth_getTransactionCount" && a.params[1] === "pending"
        ? "0x6"
        : real(a);
    hook(c);
    let thrown: any;
    await c
      .request({ method: "eth_sendTransaction", params: [tx] })
      .catch((e: any) => (thrown = e));
    expect(thrown?.message).to.match(
      /nonce 6 is already mined \(7 mined\).*not sent/,
    );
    expect(c.sends.length).to.equal(0);
  });

  it("a first-attempt 'nonce too low' is not ours to adopt: it is thrown", async function () {
    const c = chain();
    // Another process's transaction holds nonce 7, pending.
    c.pending.push({
      from: FROM,
      nonce: "0x7",
      to: TO,
      value: "0x0",
      input: "0xbeef",
      hash: "0xother",
    });
    hook(c);
    let thrown: any;
    await c
      .request({
        method: "eth_sendTransaction",
        params: [{ ...tx, nonce: "0x7" }],
      })
      .catch((e: any) => (thrown = e));
    expect(thrown?.message).to.equal("nonce too low");
    expect(c.sends.length).to.equal(1);
  });

  // U2 round 12 (R12-C6): after an unknown outcome the send may be out, so
  // no error leaving it may read as a refusal: no code, no number, the
  // message and the cause kept. A connection refused before anything
  // left is no unknown outcome: its error passes up as it came.
  it("after an unknown outcome, an error leaving the send carries no code and no number (R12-C6)", async function () {
    const c = chain(["reset-before"]);
    const real = c.request;
    // the read after the unknown send is answered with a JSON-RPC error
    c.request = async (a: any) => {
      if (c.sends.length && a.method === "eth_getTransactionCount")
        throw err("refused by the node", -32000);
      return real(a);
    };
    hook(c);
    let thrown: any;
    await c
      .request({ method: "eth_sendTransaction", params: [tx] })
      .catch((e: any) => (thrown = e));
    expect(thrown?.message).to.equal("refused by the node");
    expect(thrown?.code).to.equal(undefined);
    expect(thrown?.number).to.equal(undefined);
    expect(thrown?.cause?.code).to.equal(-32000);
  });

  it("a connection refused on the first attempt (HH108) is no unknown outcome: it passes up with its number", async function () {
    const c = chain();
    const refused = () =>
      Object.assign(new Error("HH108: Cannot connect to the network remote."), {
        number: 108,
      });
    const real = c.request;
    c.request = async (a: any) => {
      if (a.method === "eth_sendTransaction") throw refused();
      return real(a);
    };
    c.readFaults = Array.from({ length: 7 }, refused);
    hook(c);
    let thrown: any;
    await c
      .request({ method: "eth_sendTransaction", params: [tx] })
      .catch((e: any) => (thrown = e));
    expect(thrown?.number).to.equal(108);
  });
  it("P-Z15: a connection refused on every attempt, the reads answered, is no unknown outcome: it passes up with its number", async function () {
    const c = chain();
    const real = c.request;
    c.request = async (a: any) => {
      if (a.method === "eth_sendTransaction")
        throw Object.assign(new Error("HH108: Cannot connect to the network remote."), { number: 108 });
      return real(a);
    };
    hook(c);
    let thrown: any;
    await c
      .request({ method: "eth_sendTransaction", params: [tx] })
      .catch((e: any) => (thrown = e));
    expect(thrown?.number).to.equal(108);
    expect(thrown?.cause).to.equal(undefined);
  });
  // U2 round 13 (L5, lane C): a refused first attempt marks nothing
  // unknown, so its retry line does not say so.
  it("L5: a connection refused on the first attempt (HH108) logs a retry, never 'outcome unknown'", async function () {
    const c = chain();
    const real = c.request;
    c.request = async (a: any) => {
      if (a.method === "eth_sendTransaction")
        throw Object.assign(new Error("HH108: Cannot connect to the network remote."), { number: 108 });
      return real(a);
    };
    const { lines } = hook(c);
    await c.request({ method: "eth_sendTransaction", params: [tx] }).catch(() => {});
    expect(lines.join("\n")).to.match(/HH108: Cannot connect to the network remote\.; retry 1\/\d+ in \d+ ms \(same nonce\)/);
    expect(lines.join("\n")).to.not.contain("outcome unknown");
  });
});
