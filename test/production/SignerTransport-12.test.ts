// U2 round 12 (item A, lane G GG11-1, lead-attack11-G; R12-C1, R12-C6):
// behind scripts/production/signer.js a numeric JSON-RPC code did not mean
// "nothing of the send is out". The signer answered every upstream
// failure as `{ error: { code: -32000 } }`, a transport failure after it
// forwarded the raw transaction included, so resend() read a mined
// re-send as a refusal and deleted its intent. Now the signer answers a
// transport failure of its broadcast with HTTP
// 502 and a body that is no JSON-RPC answer; Hardhat's HttpProvider then
// throws without a code and the intent stays. RpcRetry retries the same
// nonce through the signer, whose slot memory sends the same transaction
// again; the entry's nonce mines once and the record adopts it. Once a
// send's outcome is unknown, no error RpcRetry passes up carries a code
// or a number (R12-C6); a connection refused before anything left still
// drops the intent (A2). The real signer runs against a proxy in front
// of the in-process node.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { HttpProvider } from "hardhat/internal/core/providers/http";
import { Recorder } from "../../scripts/production/deployRecord";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { Live, rpc, runSigner } from "../helpers/signerProcess";

const { installRetry } = require("../../demo/utils/RpcRetry");

describe("U2 round 12: a transport failure behind the signer is no refusal", function () {
  this.timeout(300000);
  const box = h.files();
  const PASS = "a long enough test password";
  let dir: string;
  let base: (a: any) => Promise<any>;
  const load = () => loadRecord(box.file)!;
  const automine = (on: boolean) =>
    network.provider.request({ method: "evm_setAutomine", params: [on] });

  before(() => (base = network.provider.request.bind(network.provider)));
  // A fresh keystore directory per test: the signer remembers what it
  // signed at each nonce beside its keys.
  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-transport-"));
    fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
    const w = ethers.Wallet.fromPhrase(
      "test test test test test test test test test test test junk",
    );
    expect(w.address).to.equal((await ethers.getSigners())[0].address);
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
  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await automine(true);
  });

  /**
   * The in-process node behind a proxy. Every eth_sendRawTransaction is
   * forwarded; the first `fail` replies are lost (`drop`: the socket
   * closed; `502`: a gateway error page). `mineOn`: the raw send that is
   * followed by one mined block before its reply. `tip`: the priority fee
   * the signer is told (R12-C8: a re-send with other fees than the
   * evicted send has another hash).
   */
  async function proxy(mode: string, fail: number | ((n: number) => boolean), mineOn = 0, tip?: bigint) {
    const raws: string[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const c = JSON.parse(b);
        let out: any;
        try {
          const fee = tip !== undefined && c.method === "eth_maxPriorityFeePerGas";
          out = { jsonrpc: "2.0", id: c.id, result: fee ? ethers.toQuantity(tip) : await base(c) };
        } catch (e: any) {
          const error = { code: e.code ?? -32603, message: e.message };
          out = { jsonrpc: "2.0", id: c.id, error };
        }
        if (c.method === "eth_sendRawTransaction") {
          raws.push(c.params[0]);
          if (raws.length === mineOn) await base({ method: "evm_mine" });
          if (typeof fail === "function" ? fail(raws.length) : raws.length <= fail) {
            if (mode === "drop") return req.socket.destroy();
            res.statusCode = 502;
            return res.end("<html>502 Bad Gateway</html>");
          }
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, raws, url };
  }

  const env = (url: string) => ({
    SIGNER_UPSTREAM: url,
    SIGNER_TEST: "1",
    SIGNER_PROMPT: "0",
    SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
    SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
    SIGNER_TOKEN_FILE: path.join(dir, "token"),
  });
  /** The CLI's side: Hardhat's HttpProvider to the signer at `url`. */
  const cli = (url: string, token: string, host?: number) =>
    new HttpProvider(url, "remote", {
      Authorization: `Bearer ${token}`,
      ...(host ? { Host: `127.0.0.1:${host}` } : {}),
    });

  /** Entry #0 sent and evicted unmined: a resume re-sends it at its nonce. */
  async function evicted() {
    const start = await h.nonce();
    await automine(false);
    await h.sendOne(box.file);
    await base({ method: "hardhat_dropTransaction", params: [load().txs[0].hash] });
    await automine(true);
    return start;
  }

  /** As evicted(), entry #0 sent through the signer at `live`. */
  async function evictedVia(live: Live) {
    const p = cli(live.url, live.token);
    const restore = h.node(async (a) =>
      a.method === "eth_sendTransaction" ? p.request(a) : undefined,
    );
    try {
      return await evicted();
    } finally {
      restore();
    }
  }

  /** A resume whose eth_sendTransaction goes through `p`; its lines kept. */
  async function resumeVia(p: any, lines: string[] = []) {
    const restore = h.node(async (a) =>
      a.method === "eth_sendTransaction" ? p.request(a) : undefined,
    );
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    try {
      await r.install();
      r.remove();
      return "accepted";
    } catch (e: any) {
      return e.message as string;
    } finally {
      restore();
    }
  }

  for (const mode of ["drop", "502"]) {
    it(`A1 (${mode}): a send the signer forwarded and lost the reply to is answered HTTP 502, no JSON-RPC error; it mined`, async function () {
      const up = await proxy(mode, 1);
      const [d] = await ethers.getSigners();
      const start = await h.nonce();
      try {
        const r = await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
          const tx = { from: d.address, to: d.address, value: "0x1", nonce: ethers.toQuantity(start) };
          const a = await rpc(live, "eth_sendTransaction", [tx]);
          expect(a.body.error, "the signer answered a JSON-RPC error").to.equal(undefined);
          expect(a.status).to.equal(502);
          expect(a.body.transport).to.match(/^HTTP 502: /);
        });
        expect(r.code, r.out).to.equal(0);
      } finally {
        up.server.close();
      }
      expect(up.raws, "forwarded once").to.have.length(1);
      expect(await h.nonce(), "the forwarded send mined").to.equal(start + 1);
    });
  }

  it("A1 control: an error the node answered keeps its numeric code and message", async function () {
    const up = await proxy("drop", 0);
    const [d] = await ethers.getSigners();
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        const tx = { from: d.address, to: d.address, value: ethers.toQuantity(10n ** 30n) };
        const a = await rpc(live, "eth_sendTransaction", [tx]);
        expect(a.status).to.equal(200);
        expect(a.body.error.code).to.be.a("number");
        expect(a.body.error.message).to.match(/insufficient funds|balance/i);
      });
    } finally {
      up.server.close();
    }
  });

  // R12-C8: run 40601356051 (tests 1/2) found the re-send byte-identical
  // to the evicted send, so no adoption ran. Each case is forced here.
  it("A1: a re-send lost in transport behind the signer keeps the intent; the entry is adopted at its nonce", async function () {
    const start = await evicted();
    const gone = load().txs[0].hash;
    // another priority fee than the evicted send's: another signed transaction
    const up = await proxy("drop", Infinity, 0, ethers.parseUnits("1", "gwei") + 7n);
    const lines: string[] = [];
    let res = "";
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        res = await resumeVia(cli(live.url, live.token), lines);
      });
    } finally {
      up.server.close();
    }
    expect(up.raws, "the re-send was forwarded").to.have.length(1);
    expect(load().txs[0].resendFrom, "the intent is kept").to.be.a("number");
    // the transaction mined at the entry's nonce: adopted there
    expect(res, lines.join("\n")).to.equal("accepted");
    const sent = ethers.Transaction.from(up.raws[0]).hash;
    expect(sent, "the re-send is another signed transaction").to.not.equal(gone);
    expect(load().txs[0].hash, "the record holds the mined re-send").to.equal(sent);
    expect(lines.join("\n")).to.contain(`mined as ${sent}; adopted`);
    expect(await h.nonce(), "the re-send mined at the entry's nonce").to.equal(start + 1);
    expect(await h.accepted(box.file), "a healthy resume").to.equal("accepted");
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([[start, "confirmed"]]);
    expect(load().strays ?? []).to.deep.equal([]);
  });

  it("A1, byte for byte: a re-send of the signer's own evicted send lost in transport keeps the intent; it mines under its own hash", async function () {
    const up = await proxy("drop", (n) => n > 1);
    const lines: string[] = [];
    let [res, start, gone] = ["", 0, ""];
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        start = await evictedVia(live);
        gone = load().txs[0].hash!;
        res = await resumeVia(cli(live.url, live.token), lines);
      });
    } finally {
      up.server.close();
    }
    expect(up.raws, "sent, then sent again byte for byte").to.have.length(2);
    expect(up.raws[1]).to.equal(up.raws[0]);
    expect(ethers.Transaction.from(up.raws[1]).hash).to.equal(gone);
    expect(load().txs[0].resendFrom, "the intent is kept").to.be.a("number");
    expect(res, lines.join("\n")).to.equal("accepted");
    expect(load().txs[0].hash, "found under its own hash").to.equal(gone);
    expect(lines.join("\n")).to.not.contain("adopted");
    expect(await h.nonce(), "the re-send mined at the entry's nonce").to.equal(start + 1);
    expect(await h.accepted(box.file), "a healthy resume").to.equal("accepted");
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([[start, "confirmed"]]);
    expect(load().strays ?? []).to.deep.equal([]);
  });

  it("A1 end to end: RpcRetry retries the nonce through the signer, the same transaction is sent again, mined once, adopted", async function () {
    const start = await evicted();
    // The first forward stays pending, its reply lost; the retry's
    // forward is followed by a mined block.
    const up = await proxy("drop", 1, 2);
    const lines: string[] = [];
    let res = "";
    await automine(false);
    try {
      const r = await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        const p = cli(live.url, live.token);
        installRetry(p, { baseMs: 5, maxMs: 20, log: (m: string) => lines.push(m) });
        res = await resumeVia(p);
      });
      expect(r.out).to.match(/RETRY of #1 \(same request\): send/);
    } finally {
      up.server.close();
      await automine(true);
    }
    expect(res, lines.join("\n")).to.equal("accepted");
    expect(up.raws, "the same transaction, twice").to.have.length(2);
    expect(up.raws[1]).to.equal(up.raws[0]);
    expect(lines.join("\n")).to.match(/outcome unknown, retry 1\//);
    const t = ethers.Transaction.from(up.raws[0]);
    expect(load().txs.map((e) => [e.nonce, e.status, e.hash])).to.deep.equal([[start, "confirmed", t.hash]]);
    expect(load().strays ?? []).to.deep.equal([]);
    expect(await h.nonce(), "mined once").to.equal(start + 1);
    expect(await h.accepted(box.file), "a further resume").to.equal("accepted");
  });

  /** A TCP relay to `to` that refuses every connection once closed. */
  async function relay(to: number) {
    const socks: net.Socket[] = [];
    const server = net.createServer((s) => {
      const o = net.connect(to, "127.0.0.1");
      socks.push(s, o);
      s.pipe(o).pipe(s);
      s.on("error", () => o.destroy());
      o.on("error", () => s.destroy());
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    const close = () => {
      server.close();
      for (const s of socks) s.destroy();
    };
    return { port, close };
  }

  it("R12-C6: a send forwarded then lost behind the signer, then every call refused: the error reaching the record has no code, the intent is kept", async function () {
    const start = await evicted();
    const up = await proxy("502", Infinity);
    let res = "";
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        const r = await relay(live.port);
        const p: any = cli(`http://127.0.0.1:${r.port}`, live.token, live.port);
        const send = p.request.bind(p);
        // the signer's port, as the CLI sees it, refuses once the first send is answered
        p.request = (a: any) => send(a).finally(() => a.method === "eth_sendTransaction" && r.close());
        installRetry(p, { baseMs: 1, maxMs: 2, log: () => {} });
        res = await resumeVia(p);
      });
    } finally {
      up.server.close();
    }
    expect(load().txs[0].resendFrom, "the intent is kept").to.be.a("number");
    expect(res, "the forwarded re-send adopted at its nonce").to.equal("accepted");
    expect(await h.nonce(), "the forwarded re-send mined").to.equal(start + 1);
    expect(await h.accepted(box.file)).to.equal("accepted");
  });

  it("A2: a connection refused before anything left drops the intent the send set (RpcRetry under the record)", async function () {
    await evicted();
    const r = await relay(1);
    r.close();
    const p: any = cli(`http://127.0.0.1:${r.port}`, "unused");
    installRetry(p, { baseMs: 1, maxMs: 2, log: () => {} });
    expect(await resumeVia(p)).to.contain("HH108");
    expect(load().txs[0], "nothing left: no intent").to.not.have.property("resendFrom");
  });
});
