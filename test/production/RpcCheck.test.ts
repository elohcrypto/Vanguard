import { expect } from "chai";
import * as http from "http";
import { spawn } from "child_process";
import { AddressInfo } from "net";

const rpcCheck = require("../../scripts/production/rpcCheck");
const { checkUrl } = rpcCheck;

/**
 * Task 5.15 (owner Q18 = B): scripts/production/rpcCheck.js against two
 * fake RPCs on ephemeral 127.0.0.1 ports: a pruned, range-capped,
 * rate-limiting one and an archive one.
 */
describe("rpc-check (scripts/production/rpcCheck.js)", function () {
  /** A fake RPC: `cap` max getLogs span, `pruned` below `head - 128`. */
  async function rpc(o: { pruned: boolean; cap: number; every429: number }) {
    const head = 300_000;
    let n = 0;
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        n++;
        const reply = (x: object, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id, ...x }));
        };
        if (method === "eth_blockNumber" && o.every429 && n % o.every429 === 0)
          return reply(
            { error: { code: 429, message: "Too Many Requests" } },
            429,
          );
        if (method === "eth_chainId") return reply({ result: "0xaa36a7" });
        if (method === "eth_blockNumber")
          return reply({ result: `0x${head.toString(16)}` });
        if (method === "eth_getBalance") {
          const at = Number(params[1]);
          return o.pruned && at < head - 128
            ? reply({
                error: {
                  code: -32000,
                  message: "missing trie node 0xabc (path ) <nil>",
                },
              })
            : reply({ result: "0x0" });
        }
        if (method === "eth_getLogs") {
          const q = params[0];
          const span = Number(q.toBlock) - Number(q.fromBlock) + 1;
          if (span > o.cap)
            return reply({
              error: {
                code: -32005,
                message: `block range is too large, max is ${o.cap}`,
              },
            });
          if (!q.address)
            return reply({
              error: {
                code: -32005,
                message: "query returned more than 10000 results",
              },
            });
          return reply({ result: [] });
        }
        if (method === "eth_gasPrice") return reply({ result: "0x77359400" });
        if (method === "eth_maxPriorityFeePerGas")
          return reply({ result: "0x3b9aca00" });
        if (method === "eth_getBlockByNumber")
          return reply({ result: { baseFeePerGas: "0x3b9aca00" } });
        reply({ error: { code: -32601, message: "no" } });
      });
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }

  it("reports a pruned, capped, rate-limited RPC and fails it on archive", async function () {
    const f = await rpc({ pruned: true, cap: 5_000, every429: 3 });
    try {
      const r = await checkUrl(f.url, { chain: 11155111 });
      const t = r.lines.join("\n");
      expect(r.ok).to.equal(false);
      expect(t).to.contain("✅ chain id 11155111 (want 11155111)");
      expect(t).to.match(
        /❌ archive: state at block 100000 refused: \[missing state\] -32000 missing trie node/,
      );
      expect(t).to.contain(
        "getLogs 10000 blocks refused: [range-capped] -32005 block range is too large, max is 5000 (a range error: scanLogs halves)",
      );
      expect(t).to.contain(
        "✅ getLogs: up to 5000 blocks per call accepted (logChunk <= 5000)",
      );
      expect(t).to.match(
        /address-less scan of 5000 blocks refused: .*query returned more than 10000 results \(range\/cap error: halved, then capped\)/,
      );
      expect(t).to.match(
        /rate: 40 calls at once in \d+ ms: \d+ answered, \d+ refused \(\d+ rate-limit or transient, retried by RpcRetry\)/,
      );
      expect(t).to.contain(
        "gas: gasPrice 2.000 gwei, priority fee 1.000 gwei, base fee 1.000 gwei",
      );
    } finally {
      f.s.close();
    }
  });

  it("passes an archive RPC and refuses another chain", async function () {
    const f = await rpc({ pruned: false, cap: 100_000, every429: 0 });
    try {
      const r = await checkUrl(f.url, { chain: 11155111 });
      expect(r.ok, r.lines.join("\n")).to.equal(true);
      expect(r.lines.join("\n")).to.contain(
        "up to 100000 blocks per call accepted",
      );
      const other = await checkUrl(f.url, { chain: 1 });
      expect(other.ok).to.equal(false);
      expect(other.lines.join("\n")).to.contain(
        "❌ chain id 11155111 (want 1)",
      );
    } finally {
      f.s.close();
    }
  });

  it("never prints a URL's credentials, path token or query key", async function () {
    const { redactUrl } = rpcCheck;
    expect(
      redactUrl(
        "https://user:s3cretpass@eth.example:8443/v3/abcdef123456?key=QK999999#x",
      ),
    ).to.equal("https://eth.example:8443/...");
    expect(redactUrl("http://127.0.0.1:8545")).to.equal(
      "http://127.0.0.1:8545",
    );
    expect(redactUrl("not a url")).to.equal("(rpc)");
    // A provider that echoes the URL and key in its error.
    const key = "PATHKEY0123456789";
    const s = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: `bad key ${key} for ${req.url}` },
        }),
      );
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    try {
      const url = `http://u:hunter2pass@127.0.0.1:${(s.address() as AddressInfo).port}/v3/${key}?apikey=QUERYKEY42`;
      const r = await checkUrl(url, {});
      const t = r.lines.join("\n");
      for (const secret of [key, "hunter2pass", "QUERYKEY42", "/v3/"])
        expect(t, secret).to.not.contain(secret);
      expect(t).to.match(/^RPC http:\/\/127\.0\.0\.1:\d+\/\.\.\./);
      expect(t).to.contain("<redacted>");
    } finally {
      s.close();
    }
  });

  it("redacts every key form an error may echo, in the CLI's stdout and stderr; errors are classified", async function () {
    const { scrub, classify } = rpcCheck;
    const KEY = "k3yAbcDEF";
    const ENC = "k3y%2Fslash%3D";
    const DEC = "k3y/slash=";
    const url = `https://user:pa55word@rpc.example/v3/${KEY}/x?apikey=${ENC}&x=1`;
    for (const echoed of [
      `invalid project id ${KEY}`,
      `bad apikey ${ENC}`,
      `bad apikey ${DEC}`,
      "auth failed for pa55word",
      `fetch ${url} failed`,
    ]) {
      const t = scrub(echoed, url);
      for (const secret of [KEY, ENC, DEC, "pa55word"])
        expect(t, echoed).to.not.contain(secret);
    }
    expect(classify("429 Too Many Requests")).to.equal("rate-limited");
    expect(classify("block range is too large")).to.equal("range-capped");
    expect(classify("missing trie node")).to.equal("missing state");
    expect(classify("invalid project id")).to.equal("unauthorized");
    expect(classify("boom")).to.equal("other");
    // The CLI against a provider echoing the path key and the decoded query.
    const srv = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: `invalid project id ${KEY}, key ${DEC}`,
          },
        }),
      );
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = (srv.address() as AddressInfo).port;
    const u = `http://user:pa55word@127.0.0.1:${port}/v3/${KEY}?apikey=${ENC}`;
    try {
      const out = await new Promise<string>((ok) => {
        const p = spawn(
          process.execPath,
          ["scripts/production/rpcCheck.js", "--chain", "31337"],
          { env: { ...process.env, RPC_CHECK_URLS: u } },
        );
        let t = "";
        p.stdout.on("data", (d) => (t += d));
        p.stderr.on("data", (d) => (t += d));
        p.on("exit", () => ok(t));
      });
      for (const secret of [KEY, ENC, DEC, "pa55word", "/v3/"])
        expect(out, secret).to.not.contain(secret);
      expect(out).to.contain("[unauthorized]");
    } finally {
      srv.close();
    }
  });

  it("scrubs before it truncates, and every query encoding (redact.js)", async function () {
    const {
      scrub,
      shown,
      secretsOf,
    } = require("../../scripts/production/redact");
    const KEY = "QWERTYKEY0123456789";
    const url = `https://rpc.example/v3/${KEY}`;
    const body = `${"x".repeat(110)}${KEY} tail`;
    for (const out of [
      shown(`HTTP 401: ${body}`, url, 120),
      scrub(body, url, 120),
    ]) {
      for (let n = 0; n + 8 <= KEY.length; n++)
        expect(out, out).to.not.contain(KEY.slice(n, n + 8));
    }
    // The rpc-check path: an HTML error page with the key at char 110.
    const srv = http.createServer((req, res) => {
      res.statusCode = 401;
      res.end(body);
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v3/${KEY}`;
      const t = (await checkUrl(u, {})).lines.join("\n");
      for (let n = 0; n + 8 <= KEY.length; n++)
        expect(t).to.not.contain(KEY.slice(n, n + 8));
    } finally {
      srv.close();
    }
    const q =
      "https://rpc.example/?apikey=a%2Bb%20c+d&token=TOK999;sess=SESS777&flag";
    const sec = secretsOf(q);
    for (const want of [
      "apikey=a%2Bb%20c+d&token=TOK999;sess=SESS777&flag",
      "apikey=a%2Bb%20c+d",
      "a%2Bb%20c+d",
      "a+b c+d",
      "a+b c d",
      "TOK999",
      "token=TOK999",
      "SESS777",
      "sess=SESS777",
      "flag",
    ])
      expect(sec, want).to.include(want);
    for (const echoed of [
      "a+b c d",
      "a+b c+d",
      "a%2Bb%20c+d",
      "TOK999",
      "SESS777",
    ])
      expect(scrub(`bad ${echoed}!`, q)).to.equal("bad <redacted>!");
  });

  it("matches any case and encoding, finds keys in composite values, spares short path words (final review L-2)", function () {
    const { scrub } = require("../../scripts/production/redact");
    const u1 = "https://rpc.example/api/eth/v3/AbCdEfGh1234?key=ab+KEYKEY9876";
    const t1 = scrub(
      "abcdefgh1234 ABCDEFGH1234 KEYKEY9876 keykey9876 via api eth v3 monkey",
      u1,
    );
    expect(t1).to.equal(
      "<redacted> <redacted> <redacted> <redacted> via api eth v3 monkey",
    );
    const u2 = "https://rpc.example/?k=a/b=c12345678";
    for (const echoed of [
      "a%2Fb%3Dc12345678",
      "a%2fb%3dc12345678",
      "A%2FB%3DC12345678",
    ])
      expect(scrub(`x ${echoed} y`, u2)).to.equal("x <redacted> y");
    expect(
      scrub("pw hunter2 at user", "https://user:hunter2@rpc.example/"),
    ).to.equal("pw <redacted> at <redacted>");
  });

  it("takes RPC URLs from the environment or a 0600 file, never argv (final review L-4)", async function () {
    const { spawnSync } = require("child_process");
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["scripts/production/rpcCheck.js", ...args], {
        env: { ...process.env, RPC_CHECK_URLS: "", ...env },
        encoding: "utf8",
      });
    const argv = run(["https://rpc.example/v3/ARGVKEY12345"]);
    expect(argv.status).to.equal(1);
    expect(argv.stderr).to.contain("an RPC URL on the command line is refused");
    expect(argv.stderr + argv.stdout).to.not.contain("ARGVKEY12345");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "rpcf-")),
      "urls",
    );
    fs.writeFileSync(f, "http://127.0.0.1:1\n", { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    const loose = run([], { RPC_CHECK_URLS_FILE: f });
    expect(loose.stderr).to.contain(
      "RPC_CHECK_URLS_FILE must be this user's own file, mode 0600",
    );
    fs.chmodSync(f, 0o600);
    const ok = run(["--chain", "11155111"], { RPC_CHECK_URLS_FILE: f });
    expect(ok.stdout).to.contain("RPC http://127.0.0.1:1");
    // Task 5.17 (deep review L-7): --chain is required.
    const any = run([], { RPC_CHECK_URLS_FILE: f });
    expect(any.status).to.equal(1);
    expect(any.stderr).to.contain("(--chain is required)");
  });
});
