// U2 round 13 (item A, lane G LOW, lead M2, lead-attack12-G-bnfail;
// R13-C2): signer.js sent its raw transaction through ethers'
// broadcastTransaction, which reads eth_blockNumber (and the network)
// beside the send. A node error on that READ (-32005, rate limited)
// rejected with a numeric code, so the signer relayed it as a JSON-RPC
// error, HTTP 200, while the forwarded send mined, and resend() dropped
// the intent. Now the signer sends eth_sendRawTransaction alone and
// checks the answered hash itself: the hash of the raw transaction, or a
// transport failure (a lying node). The real signer runs against a proxy
// in front of the in-process node.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { Live, rpc, runSigner } from "../helpers/signerProcess";

describe("U2 round 13: the signer sends the raw transaction alone", function () {
  this.timeout(300000);
  const PASS = "a long enough test password";
  let dir: string;
  let base: (a: any) => Promise<any>;

  before(() => (base = network.provider.request.bind(network.provider)));
  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-transport-13-"));
    fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
    const w = ethers.Wallet.fromPhrase("test test test test test test test test test test test junk");
    fs.writeFileSync(
      path.join(dir, "keys", "a.json"),
      await ethers.encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, PASS, {
        scrypt: { N: 1 << 10 },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * The in-process node behind a proxy that counts each method while
   * `during` is set. `bnfail`: eth_blockNumber answers -32005 (lead
   * proxy12.js MODE bnfail). `wronghash`: eth_sendRawTransaction is
   * forwarded, then answered with another hash.
   */
  async function proxy(mode: "bnfail" | "wronghash") {
    const raws: string[] = [];
    const seen: Record<string, number> = {};
    const state = { during: false };
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const c = JSON.parse(b);
        if (state.during) seen[c.method] = (seen[c.method] ?? 0) + 1;
        let out: any;
        if (mode === "bnfail" && c.method === "eth_blockNumber")
          out = { jsonrpc: "2.0", id: c.id, error: { code: -32005, message: "rate limited (read)" } };
        else
          try {
            out = { jsonrpc: "2.0", id: c.id, result: await base(c) };
          } catch (e: any) {
            out = { jsonrpc: "2.0", id: c.id, error: { code: e.code ?? -32603, message: e.message } };
          }
        if (c.method === "eth_sendRawTransaction") {
          raws.push(c.params[0]);
          if (mode === "wronghash") out = { jsonrpc: "2.0", id: c.id, result: `0x${"ab".repeat(32)}` };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, raws, seen, state, url };
  }

  const env = (url: string) => ({
    SIGNER_UPSTREAM: url,
    SIGNER_TEST: "1",
    SIGNER_PROMPT: "0",
    SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
    SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
    SIGNER_TOKEN_FILE: path.join(dir, "token"),
  });
  const nonce = async () => (await ethers.provider.getTransactionCount((await ethers.getSigners())[0].address));

  it("bnfail: a failing eth_blockNumber read beside the send is not read; the signer answers the hash, HTTP 200", async function () {
    const up = await proxy("bnfail");
    const [d] = await ethers.getSigners();
    const start = await nonce();
    let a: any;
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        const tx = { from: d.address, to: d.address, value: "0x1", nonce: ethers.toQuantity(start) };
        up.state.during = true;
        a = await rpc(live, "eth_sendTransaction", [tx]);
        up.state.during = false;
      });
    } finally {
      up.server.close();
    }
    expect(up.raws, "forwarded once").to.have.length(1);
    expect(a.status).to.equal(200);
    expect(a.body.error, "no JSON-RPC error relayed").to.equal(undefined);
    expect(a.body.result).to.equal(ethers.keccak256(up.raws[0]));
    expect(up.seen.eth_blockNumber ?? 0, "eth_blockNumber reads during the send").to.equal(0);
    expect(await nonce(), "the send mined").to.equal(start + 1);
  });

  it("wronghash: a node answering another hash for the forwarded send is a transport failure, HTTP 502", async function () {
    const up = await proxy("wronghash");
    const [d] = await ethers.getSigners();
    let a: any;
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        const tx = { from: d.address, to: d.address, value: "0x1" };
        a = await rpc(live, "eth_sendTransaction", [tx]);
      });
    } finally {
      up.server.close();
    }
    expect(up.raws, "forwarded once").to.have.length(1);
    expect(a.status).to.equal(502);
    expect(a.body.error, "no JSON-RPC error").to.equal(undefined);
    expect(a.body.transport).to.match(/^HTTP 502: /);
  });
});
