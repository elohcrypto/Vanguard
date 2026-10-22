import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { rpc, runSigner } from "../helpers/signerProcess";

const {
  fetchTarget,
  scrub,
  scrubData,
  secretsOf,
} = require("../../scripts/production/redact");
const { call } = require("../../scripts/production/rpcCheck");
const costTable = require("../../scripts/production/costTable");
const { urlReader } = require("../../scripts/production/scanCount");

/**
 * Task 5.17 slice B (deep review L-1, L-2, L-3): RPC credentials.
 *  - L-3: node's fetch refuses a URL with credentials (ethers accepts
 *    them), so with a basic-auth upstream every forwarded read failed.
 *    fetchTarget sends them as a Basic header: the signers, rpcCheck,
 *    scanCount and costTable reach such an upstream.
 *  - L-2: the secrets include that Basic credential, hex and base64 forms
 *    of each secret, and path keys of 6+ characters.
 *  - L-1: an upstream error's data is scrubbed like its message.
 */
describe("RPC credentials: Basic auth, encoded forms, error data (L-1..L-3)", function () {
  this.timeout(60_000);
  const KEY = "k3yAbCdEf0123456789";
  const USER = "vanguard";
  const PASS = "p@ss-w0rd!";
  let server: http.Server;
  let base: string;
  let url: string;
  const seen: string[] = [];

  before(async function () {
    // An upstream that answers only with the Basic credential, and whose
    // eth_getLogs error echoes the request URL's key in message and data.
    const want = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(String(req.headers.authorization));
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== want) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: "unauthorized" }));
        }
        const c = JSON.parse(body);
        const result: Record<string, unknown> = {
          eth_chainId: "0x7a69",
          eth_blockNumber: "0x10",
        };
        if (c.method === "eth_getLogs") {
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: c.id,
              error: {
                code: -32000,
                message: `bad range for /v3/${KEY}`,
                data: {
                  url: `/v3/${KEY}`,
                  hex: `0x${Buffer.from(KEY).toString("hex")}`,
                  b64: Buffer.from(KEY).toString("base64"),
                  auth: want,
                },
              },
            }),
          );
        }
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: c.id,
            result: result[c.method] ?? null,
          }),
        );
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    url = `http://${USER}:${encodeURIComponent(PASS)}@${base}/v3/${KEY}`;
  });
  after(() => server.close());

  it("fetchTarget moves the credentials to a Basic header; plain fetch of the URL is refused", async function () {
    const t = fetchTarget(url);
    expect(t.url).to.equal(`http://${base}/v3/${KEY}`);
    expect(t.headers.authorization).to.equal(
      `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`,
    );
    expect(fetchTarget(`http://${base}/x`).headers).to.deep.equal({});
    await expect(fetch(url)).to.be.rejectedWith(/credentials/);
  });

  it("rpcCheck, scanCount and costTable read a basic-auth upstream", async function () {
    expect((await call(url, "eth_chainId")).result).to.equal("0x7a69");
    expect(await urlReader(url)("eth_blockNumber", [])).to.equal("0x10");
    expect(await costTable.rpc(url, "eth_chainId")).to.equal("0x7a69");
  });

  it("the production signer forwards reads to a basic-auth upstream; error data comes back scrubbed", async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-"));
    try {
      fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
      const w = ethers.Wallet.createRandom();
      fs.writeFileSync(
        path.join(dir, "keys", "a.json"),
        await ethers.encryptKeystoreJson(
          { address: w.address, privateKey: w.privateKey },
          "a long enough test password",
          { scrypt: { N: 1 << 10 } },
        ),
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(dir, "pass"), "a long enough test password", {
        mode: 0o600,
      });
      const r = await runSigner(
        "scripts/production/signer.js",
        {
          SIGNER_UPSTREAM: url,
          SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
          SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
          SIGNER_TOKEN_FILE: path.join(dir, "token"),
          SIGNER_TEST: "1",
        },
        async (live) => {
          expect((await rpc(live, "eth_blockNumber")).body.result).to.equal(
            "0x10",
          );
          const err = (await rpc(live, "eth_getLogs", [{}])).body.error;
          const text = JSON.stringify(err);
          expect(text).to.contain("<redacted>");
          for (const leak of [
            KEY,
            Buffer.from(KEY).toString("hex"),
            Buffer.from(KEY).toString("base64").replace(/=+$/, ""),
            Buffer.from(`${USER}:${PASS}`).toString("base64"),
          ])
            expect(text, leak).to.not.contain(leak);
        },
      );
      expect(r.code, r.out).to.equal(0);
      expect(r.out).to.not.contain(KEY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task 5.17 (slice B review L-1): inside a longer base64 string the key
  // starts at byte offset 0, 1 or 2 of a group; every alignment is
  // redacted, at most the key's last two bytes' characters stay.
  it("redacts a key embedded in a longer base64 string at any byte offset", function () {
    const url = `https://rpc.example/v3/${KEY}`;
    for (const pre of ["", "a", "ab", "abc"])
      for (const post of ["", "x", "xy"]) {
        for (const enc of ["base64", "base64url"] as const) {
          const b = Buffer.from(pre + KEY + post).toString(enc);
          const t = scrub(`data ${b} end`, url);
          expect(t, `${pre}|${post} ${enc}`).to.contain("<redacted>");
          // No 8 consecutive characters of the key's own encodings left.
          const full = Buffer.from(KEY).toString(enc);
          for (let i = 0; i + 8 <= full.length - 4; i++)
            expect(t, `${pre}|${post}`).to.not.contain(full.slice(i, i + 8));
        }
      }
  });

  it("secrets include the Basic credential, hex and base64 forms, and 6+ character path keys", function () {
    const s = secretsOf(
      `https://${USER}:${encodeURIComponent(PASS)}@rpc.example/v3/ab12cd/eth`,
    );
    expect(s).to.include(
      Buffer.from(`${USER}:${PASS}`).toString("base64").replace(/=+$/, ""),
    );
    expect(s).to.include("ab12cd");
    expect(s).to.include(Buffer.from(PASS).toString("hex"));
    const shown = scrub(
      `v3 eth ab12cd ${Buffer.from("ab12cd").toString("hex")} ${Buffer.from(PASS).toString("base64url")}`,
      `https://${USER}:${encodeURIComponent(PASS)}@rpc.example/v3/ab12cd/eth`,
    );
    expect(shown).to.equal("v3 eth <redacted> <redacted> <redacted>");
    // A 5-character path key is below the documented floor (redact.js).
    expect(secretsOf("https://rpc.example/ab12c")).to.not.include("ab12c");
    expect(
      scrubData({ m: `x ${KEY}`, n: 1 }, `https://rpc.example/${KEY}`),
    ).to.deep.equal({
      m: "x <redacted>",
      n: 1,
    });
    expect(scrubData(undefined, "https://x.example/" + KEY)).to.equal(
      undefined,
    );
  });
});
