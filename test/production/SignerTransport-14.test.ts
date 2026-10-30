// U2 round 14 (item A, lane G F1, lead lead-r13/lead-attack13-G-429;
// R14-C1): the signer's provider re-sent the SAME raw transaction when
// the upstream answered HTTP 429 (ethers' FetchRequest throttle retry),
// so a forward answered 429 reached the node twice; the second copy came
// back "nonce too low" (-32000), the signer relayed that as a refusal,
// HTTP 200, while the first copy mined, and resend() dropped the intent.
// Now the signer makes ONE upstream attempt per eth_sendRawTransaction: a
// 429, a gateway error, a reset or a timeout after it is a transport
// failure (HTTP 502), and a JSON-RPC error answer is the answer to the
// one request that left. A proxy in front of the in-process node counts
// the raw transactions that reach the node.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { Live, rpc, runSigner } from "../helpers/signerProcess";

type Mode = "429once" | "429nofwd" | "429code" | "307";

describe("U2 round 14: one send, one answer", function () {
  this.timeout(300000);
  const PASS = "a long enough test password";
  let dir: string;
  let base: (a: any) => Promise<any>;

  before(() => (base = network.provider.request.bind(network.provider)));
  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-transport-14-"));
    fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
    const w = ethers.Wallet.fromPhrase(
      "test test test test test test test test test test test junk",
    );
    fs.writeFileSync(
      path.join(dir, "keys", "a.json"),
      await ethers.encryptKeystoreJson(
        { address: w.address, privateKey: w.privateKey },
        PASS,
        {
          scrypt: { N: 1 << 10 },
        },
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * The in-process node behind a proxy (lead-r13/proxy13.js modes): the
   * first eth_sendRawTransaction (429once) is forwarded, then answered
   * HTTP 429; (429nofwd) answered HTTP 429 unforwarded; (429code) the
   * first eth_getCode, the signer's own read before it signs, answered
   * HTTP 429; (307) the first eth_sendRawTransaction answered with a
   * redirect to the proxy itself, unforwarded. `sendsIn` counts the raw
   * transactions the node received.
   */
  async function proxy(mode: Mode) {
    const st = { sendsIn: 0, once: false };
    let url = "";
    const tooMany = (res: http.ServerResponse) => {
      st.once = true;
      res.statusCode = 429;
      res.setHeader("content-type", "text/plain");
      res.end("Too Many Requests");
    };
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const c = JSON.parse(b);
        if (mode === "429code" && c.method === "eth_getCode" && !st.once)
          return tooMany(res);
        const raw = c.method === "eth_sendRawTransaction";
        if (raw && mode === "429nofwd" && !st.once) return tooMany(res);
        if (raw && mode === "307" && !st.once) {
          st.once = true;
          res.writeHead(307, { location: url });
          return res.end();
        }
        let out: any;
        try {
          if (raw) st.sendsIn++;
          out = { jsonrpc: "2.0", id: c.id, result: await base(c) };
        } catch (e: any) {
          out = {
            jsonrpc: "2.0",
            id: c.id,
            error: { code: e.code ?? -32603, message: e.message },
          };
        }
        if (raw && mode === "429once" && !st.once) return tooMany(res);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, st, url };
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

  /** One eth_sendTransaction through the real signer behind `mode`: its answer, the node's raw count, the nonce before and after. */
  async function send(mode: Mode) {
    const up = await proxy(mode);
    const [d] = await ethers.getSigners();
    const start = await nonce();
    let a: any;
    try {
      await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live: Live) => {
          a = await rpc(live, "eth_sendTransaction", [
            {
              from: d.address,
              to: d.address,
              value: "0x1",
              nonce: ethers.toQuantity(start),
            },
          ]);
        },
      );
    } finally {
      up.server.close();
    }
    return { a, sendsIn: up.st.sendsIn, start, end: await nonce() };
  }

  it("429once: a send forwarded, then answered HTTP 429, is a transport failure, HTTP 502; it reached the node once and mined", async function () {
    const r = await send("429once");
    expect(r.sendsIn, "raw transactions the node received").to.equal(1);
    expect(r.a.status).to.equal(502);
    expect(r.a.body.error, "no JSON-RPC error relayed").to.equal(undefined);
    expect(r.a.body.transport).to.match(/^HTTP 502: /);
    expect(r.end, "the one copy mined").to.equal(r.start + 1);
  });

  it("429nofwd: a send answered HTTP 429 before any forward is a transport failure, HTTP 502; nothing reached the node", async function () {
    const r = await send("429nofwd");
    expect(r.sendsIn, "raw transactions the node received").to.equal(0);
    expect(r.a.status).to.equal(502);
    expect(r.a.body.error).to.equal(undefined);
    expect(r.a.body.transport).to.match(/^HTTP 502: /);
    expect(r.end, "nothing mined").to.equal(r.start);
  });

  it("307: a send answered with a redirect is not followed: a transport failure, HTTP 502; nothing reached the node", async function () {
    const r = await send("307");
    expect(r.sendsIn, "raw transactions the node received").to.equal(0);
    expect(r.a.status).to.equal(502);
    expect(r.a.body.error).to.equal(undefined);
    expect(r.a.body.transport).to.match(/^HTTP 502: /);
    expect(r.end, "nothing mined").to.equal(r.start);
  });

  // Round 15 (R15-C3): a read keeps ethers' 429 retry (the send never),
  // so the signer's own read retried answers the hash; before, its 429
  // came back as a coded -32000 that RpcRetry retried (isTransient).
  it("429code: a 429 on the signer's own read before it signs is retried by its provider (R15-C3): the hash, one raw at the node", async function () {
    const r = await send("429code");
    expect(r.sendsIn, "raw transactions the node received").to.equal(1);
    expect(r.end).to.equal(r.start + 1);
    expect(r.a.body.error, JSON.stringify(r.a.body)).to.equal(undefined);
    expect(r.a.body.result).to.match(/^0x[0-9a-f]{64}$/);
  });
});
