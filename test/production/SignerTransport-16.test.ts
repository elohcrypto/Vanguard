// U2 round 16 (item D, lane G G15-3, lane C INFO (a); R16-C4): round 15
// gave the signer's own reads ethers' 429 retry back, unbounded in
// practice: 12 attempts on a random exponential backoff held the CLI
// 168-272 s, and an integer Retry-After header is taken by ethers as a
// delay in MILLISECONDS beyond its request timeout (fetch.js 477-482), so
// `Retry-After: 1200000` held a read for 20 minutes. Now the header is
// dropped (a real one is in seconds: ethers would misread it) and a read
// gets 8 attempts: a permanent 429 fails the read within about 30 s of
// backoff with ethers' "exceeded maximum retry limit", nothing is sent,
// and the record calls that refusal a rate limit (item B).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { Live, rpc, runSigner } from "../helpers/signerProcess";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import * as h from "../helpers/deployRecordFlow";
const { isTransient } = require("../../demo/utils/RpcRetry");

describe("U2 round 16: a read's 429 retry is bounded", function () {
  this.timeout(300000);
  const PASS = "a long enough test password";
  let dir: string;
  let base: (a: any) => Promise<any>;

  before(() => (base = network.provider.request.bind(network.provider)));
  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-transport-16-"));
    fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
    const w = ethers.Wallet.fromPhrase(
      "test test test test test test test test test test test junk",
    );
    fs.writeFileSync(
      path.join(dir, "keys", "a.json"),
      await ethers.encryptKeystoreJson(
        { address: w.address, privateKey: w.privateKey },
        PASS,
        { scrypt: { N: 1 << 10 } },
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** The in-process node behind a proxy answering every eth_getCode HTTP 429 with `Retry-After: 1200000` once `armed` (or, `slow`, every eth_getCode 2.5 s late). */
  async function proxy(slow = false) {
    const st = { sendsIn: 0, faults: 0, armed: false };
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const c = JSON.parse(b);
        if (slow && st.armed && c.method === "eth_getCode") await new Promise((ok) => setTimeout(ok, 2500));
        else if (st.armed && c.method === "eth_getCode") {
          st.faults++;
          res.statusCode = 429;
          res.setHeader("retry-after", "1200000");
          res.setHeader("content-type", "text/plain");
          return res.end("Too Many Requests");
        }
        let out: any;
        try {
          if (c.method === "eth_sendRawTransaction") st.sendsIn++;
          out = { jsonrpc: "2.0", id: c.id, result: await base(c) };
        } catch (e: any) {
          out = { jsonrpc: "2.0", id: c.id, error: { code: e.code ?? -32603, message: e.message } };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { server, st, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const env = (url: string) => ({
    SIGNER_UPSTREAM: url,
    SIGNER_TEST: "1",
    SIGNER_PROMPT: "0",
    SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
    SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
    SIGNER_TOKEN_FILE: path.join(dir, "token"),
  });
  const nonce = async () =>
    ethers.provider.getTransactionCount((await ethers.getSigners())[0].address);

  /** The record's refusal of an entry whose re-send failed with `msg`. */
  async function refusal(msg: string) {
    const real = global.setTimeout;
    (global as any).setTimeout = (f: any) => real(f, 0);
    try {
      const e: any = {
        from: "0x00000000000000000000000000000000000000aa",
        to: null,
        value: "0",
        dataHash: ethers.keccak256("0x6001"),
        data: "0x6001",
        nonce: 5,
        block: 100,
        status: "sent",
        hash: "0x" + "ab".repeat(32),
        label: "x",
      };
      const raw = async (m: string) => {
        if (m === "eth_getTransactionCount") return "0x5";
        if (m === "eth_blockNumber") return "0x70";
        if (m === "eth_sendTransaction") throw new Error(msg);
        return null;
      };
      const out = await new EntryChain(h.fused(raw), { chainId: 11155111, txs: [e] } as any, 1, () => {}, () => {})
        .receipt(e)
        .then((x) => x, (x) => x);
      expect(out).to.be.instanceOf(RecordRefusal);
      return out.message as string;
    } finally {
      (global as any).setTimeout = real;
    }
  }

  it("a permanent 429 with Retry-After: 1200000 on the signer's own eth_getCode fails the read within 70 s: 8 attempts, nothing sent, named a rate limit", async function () {
    const [d] = await ethers.getSigners();
    const up = await proxy();
    const start = await nonce();
    let a: any;
    let took = 0;
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        up.st.armed = true;
        const t0 = Date.now();
        const p = rpc(live, "eth_sendTransaction", [
          { from: d.address, to: d.address, value: "0x1", nonce: ethers.toQuantity(start) },
        ]);
        p.catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        a = await Promise.race([p, new Promise((ok) => (timer = setTimeout(() => ok("held"), 90000)))]);
        clearTimeout(timer);
        took = Date.now() - t0;
        up.st.armed = false;
      });
    } finally {
      up.server.close();
    }
    expect(a, "the read was still held at 90 s").not.to.equal("held");
    expect(took, "answered within 70 s").to.be.below(70000);
    expect(up.st.faults, "eth_getCode attempts answered 429").to.equal(8);
    expect(a.status, JSON.stringify(a.body)).to.equal(200);
    expect(a.body.error?.message).to.contain("exceeded maximum retry limit");
    expect(up.st.sendsIn, "raw transactions the node received").to.equal(0);
    expect(await nonce()).to.equal(start);
    expect(await refusal(a.body.error.message)).to.match(/: the RPC rate-limited the send; kept in the record, wait, then resume$/);
  });

  // Lane G G15-4 U20 (R16-C5): the request timeout stays ethers' 300 s;
  // a shorter one would fail a slow read the signer needs.
  it("U20: a read answered 2.5 s late still answers: the hash, one raw at the node", async function () {
    const [d] = await ethers.getSigners();
    const up = await proxy(true);
    const start = await nonce();
    let a: any;
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        up.st.armed = true;
        a = await rpc(live, "eth_sendTransaction", [
          { from: d.address, to: d.address, value: "0x1", nonce: ethers.toQuantity(start) },
        ]);
      });
    } finally {
      up.server.close();
    }
    expect(a.body.result, JSON.stringify(a.body)).to.match(/^0x[0-9a-f]{64}$/);
    expect(up.st.sendsIn).to.equal(1);
    expect(await nonce()).to.equal(start + 1);
  });

  // Lane F INFO 7: SignerTransport-14's flipped 429code row no longer
  // asserts that RpcRetry takes a relayed 429 as transient; RpcRetry.test
  // does, and so does this row, for the exact relayed text.
  it("RpcRetry takes the signer's relayed 429 transport text as transient", function () {
    const e: any = new Error('HH110: Invalid JSON-RPC response received: {"transport":"HTTP 502: server response 429 Too Many Requests"}');
    expect(isTransient(e)).to.equal(true);
  });
});
