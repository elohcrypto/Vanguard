import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, Live, rpc, runSigner } from "../helpers/signerProcess";
import { signerAuth } from "../../hardhat.config";

/**
 * Task 5.15 (the lead's security requirement): who may talk to the local
 * signers (scripts/production/rpcGuard.js), for both
 * scripts/production/signer.js and scripts/ci/remote-signer.js. A web
 * page in the operator's browser must not get a transaction signed: no
 * token, a wrong token, a foreign Host (DNS rebinding), an Origin or
 * Referer, a preflight, another content type, an oversized body or a
 * method off the list is refused, and nothing reaches the chain.
 */
describe("Signer request guard (rpcGuard.js)", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  const key = ethers.Wallet.createRandom();
  let dir: string;

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    fs.mkdirSync(path.join(dir, "keys"));
    const json = await ethers.encryptKeystoreJson(
      { address: key.address, privateKey: key.privateKey },
      PASS,
      { scrypt: { N: 1 << 10 } },
    );
    fs.writeFileSync(path.join(dir, "keys", "a.json"), json, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A raw request (Host and method set by hand); status, headers, body. */
  function raw(
    live: Live,
    opts: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((ok, ko) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: live.port,
          method: opts.method || "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${live.token}`,
            ...opts.headers,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            ok({ status: res.statusCode!, headers: res.headers, body }),
          );
        },
      );
      req.on("error", ko);
      req.end(
        opts.body ??
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts" }),
      );
    });
  }

  const SIGNERS: [string, (url: string) => Record<string, string>, string][] = [
    [
      "scripts/production/signer.js",
      (url) => ({
        SIGNER_UPSTREAM: url,
        SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
        SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
        SIGNER_TEST: "1",
      }),
      key.address,
    ],
    [
      "scripts/ci/remote-signer.js",
      (url) => ({
        SIGNER_UPSTREAM: url,
        MNEMONIC: "test test test test test test test test test test test junk",
        SIGNER_COUNT: "1",
      }),
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    ],
  ];

  it("the CLIs read a token only from this user's own 0600 file (review L-3)", function () {
    const E = "SIGNER_TOKEN_FILE";
    const was = process.env[E];
    const url = "http://127.0.0.1:8549";
    try {
      const f = path.join(dir, "cli.token");
      fs.writeFileSync(f, "a".repeat(64) + "\n", { mode: 0o600 });
      process.env[E] = f;
      expect(signerAuth(url)).to.deep.equal({
        Authorization: `Bearer ${"a".repeat(64)}`,
      });
      fs.chmodSync(f, 0o644);
      expect(() => signerAuth(url)).to.throw(
        /must be this user's own file, mode 0600/,
      );
      const link = path.join(dir, "cli-link.token");
      fs.chmodSync(f, 0o600);
      fs.symlinkSync(f, link);
      process.env[E] = link;
      expect(() => signerAuth(url)).to.throw(/must be this user's own file/);
      process.env[E] = path.join(dir, "absent.token");
      expect(signerAuth(url)).to.deep.equal({});
      // The default lives in this user's 0700 directory.
      delete process.env[E];
      const { tokenFileFor } = require("../../scripts/production/rpcGuard");
      const def = tokenFileFor(1, {}, true);
      expect(path.basename(def)).to.equal("1.token");
      expect(fs.statSync(path.dirname(def)).mode & 0o777).to.equal(0o700);
    } finally {
      if (was === undefined) delete process.env[E];
      else process.env[E] = was;
    }
  });

  for (const [script, envOf] of SIGNERS) {
    it(`${path.basename(script)}: an upstream error echoing its URL's key reaches no client or log`, async function () {
      const KEY = "UPSTREAMKEY7788";
      const up = await fakeUpstream(31337);
      // The same fake, reached through a path and query that carry the key.
      const url = `${up.url}/v3/${KEY}?apikey=${KEY}`;
      const tokenFile = path.join(dir, `${path.basename(script)}.key.token`);
      try {
        const r = await runSigner(
          script,
          { ...envOf(url), SIGNER_TOKEN_FILE: tokenFile },
          async (live) => {
            // eth_getLogs is allowed and the fake answers it with an error.
            up.echo(`bad key ${KEY} at ${url}`);
            const res = await rpc(live, "eth_getLogs", [{}]);
            expect(JSON.stringify(res.body)).to.not.contain(KEY);
            expect(res.body.error.message).to.contain("<redacted>");
          },
        );
        expect(r.out).to.not.contain(KEY);
      } finally {
        up.server.close();
      }
    });
  }

  for (const [script, envOf] of SIGNERS) {
    it(`${path.basename(script)}: a malformed call or a dead upstream is an error answer, never a crash (review L-1)`, async function () {
      const up = await fakeUpstream(31337);
      const tokenFile = path.join(dir, `${path.basename(script)}.l1.token`);
      try {
        const r = await runSigner(
          script,
          { ...envOf(up.url), SIGNER_TOKEN_FILE: tokenFile },
          async (live) => {
            for (const body of [
              "null",
              "[null]",
              "[1]",
              '{"method":5}',
              '"x"',
              "[]",
            ]) {
              const res = await raw(live, { body });
              expect(res.status, body).to.be.oneOf([200, 400]);
              expect(res.body, body).to.match(/Invalid Request|-32600/);
            }
            // The upstream goes away: a forwarded read is an error answer.
            await new Promise<void>((ok) => up.server.close(() => ok()));
            up.server.closeAllConnections?.();
            const down = await rpc(live, "eth_blockNumber");
            expect(down.body.error.message).to.match(
              /upstream|fetch failed|ECONNREFUSED/,
            );
            // Still serving.
            const acc = await rpc(live, "eth_accounts");
            expect(acc.body.result.length).to.be.greaterThan(0);
          },
        );
        expect(r.code, "no crash").to.equal(0);
      } finally {
        up.server.close();
      }
    });
  }

  for (const [script, envOf, from] of SIGNERS) {
    it(`${path.basename(script)}: only a token-bearing, same-host, non-browser JSON request is served`, async function () {
      const up = await fakeUpstream(31337);
      const tokenFile = path.join(dir, `${path.basename(script)}.token`);
      const tx = { from, to: from, value: "0x1", nonce: "0x5" };
      const send = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendTransaction",
        params: [tx],
      });
      let token = "";
      try {
        const r = await runSigner(
          script,
          { ...envOf(up.url), SIGNER_TOKEN_FILE: tokenFile },
          async (live) => {
            expect(fs.statSync(tokenFile).mode & 0o777).to.equal(0o600);
            expect(live.token).to.match(/^[0-9a-f]{64}$/);
            token = live.token;
            const refused = async (
              o: Parameters<typeof raw>[1],
              status: number,
              why: RegExp,
            ) => {
              const res = await raw(live, { body: send, ...o });
              expect(res.status, JSON.stringify(o)).to.equal(status);
              expect(res.body, JSON.stringify(o)).to.match(why);
              for (const h of Object.keys(res.headers))
                expect(h, "no CORS header").to.not.match(/^access-control-/);
            };
            await refused(
              { headers: { authorization: "" } },
              401,
              /bearer token/,
            );
            await refused(
              { headers: { authorization: `Bearer ${"0".repeat(64)}` } },
              401,
              /bearer token/,
            );
            await refused(
              { headers: { authorization: `Bearer ${live.token}x` } },
              401,
              /bearer token/,
            );
            await refused(
              { headers: { host: `attacker.example:${live.port}` } },
              403,
              /Host must be/,
            );
            await refused(
              { headers: { host: "127.0.0.1:1" } },
              403,
              /Host must be/,
            );
            await refused(
              { headers: { origin: "https://attacker.example" } },
              403,
              /Origin or Referer/,
            );
            await refused(
              { headers: { referer: "https://attacker.example/x" } },
              403,
              /Origin or Referer/,
            );
            await refused(
              { headers: { "content-type": "text/plain" } },
              415,
              /application\/json/,
            );
            await refused({ method: "OPTIONS" }, 403, /cross-origin/);
            const big = await raw(live, {
              body: "x".repeat(3 * 1024 * 1024),
            }).catch((e) => e);
            expect(
              big instanceof Error || big.status !== 200,
              "oversized body served",
            ).to.equal(true);
            const off = await rpc(live, "debug_traceTransaction", ["0x00"]);
            expect(off.body.error.message).to.contain(
              "is not allowed by this signer",
            );
            expect(up.raws, "nothing reached the chain").to.deep.equal([]);
            // The same request, properly made, is served.
            const ok = await raw(live, {
              headers: { host: `localhost:${live.port}` },
              body: send,
            });
            expect(ok.status).to.equal(200);
            expect(JSON.parse(ok.body).result).to.match(/^0x[0-9a-f]{64}$/);
            expect(up.raws.length).to.equal(1);
          },
        );
        expect(r.code, "the signer stayed up and exited on SIGTERM").to.equal(
          0,
        );
        expect(token).to.match(/^[0-9a-f]{64}$/);
        expect(r.out).to.not.contain(token);
        expect(r.out).to.contain(`token in ${tokenFile}`);
        // Task 5.17 (deep review L-6): the production signer removes its
        // token file when it exits.
        if (script.endsWith("signer.js") && script.includes("production"))
          expect(fs.existsSync(tokenFile), "token file left behind").to.equal(
            false,
          );
      } finally {
        up.server.close();
      }
    });
  }
});
