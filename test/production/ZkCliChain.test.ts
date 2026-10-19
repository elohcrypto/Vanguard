import { expect } from "chai";
import { HDNodeWallet } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream } from "../helpers/signerProcess";

const {
  guardKey,
  keyFromEnv,
  refuseRpcArg,
  rpcFromEnv,
} = require("../../scripts/zk/zkChain");
const { describeProofs } = require("../helpers/zkProofs");
const {
  buildWhitelistRoot,
  computeCommitment,
} = require("../../scripts/zk/build-whitelist-root");

/**
 * Task 5.17 slice B (deep review L-4): the zk CLIs (attest.js,
 * build-whitelist-root.js, prove-whitelist.js, prove-attestation.js) take
 * the RPC URL from env ZK_RPC_URL (or ZK_RPC_URL_FILE), never argv, and
 * refuse a published Hardhat key in WHITELIST_OPS_KEY / WHITELIST_WALLET_KEY
 * / ATTESTOR_KEY on any chain but 31337, before anything is sent.
 */
describe("zk CLIs: RPC from env, no published key off 31337 (L-4)", function () {
  this.timeout(60_000);
  const HARDHAT0 = HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    "m/44'/60'/0'/0/0",
  ).privateKey;

  it("refuses --rpc and a URL anywhere on argv; reads ZK_RPC_URL", function () {
    expect(() => refuseRpcArg("--rpc")).to.throw(/--rpc <url> is refused/);
    expect(() => refuseRpcArg("--rpc=http://x")).to.throw(/ZK_RPC_URL/);
    expect(() => refuseRpcArg("--privacy-manager")).to.not.throw();
    const was = process.env.ZK_RPC_URL;
    try {
      process.env.ZK_RPC_URL = "http://127.0.0.1:1/k3y";
      expect(rpcFromEnv(["--in", "x"])).to.equal("http://127.0.0.1:1/k3y");
      expect(() => rpcFromEnv(["https://rpc.example/key"])).to.throw(
        /an RPC URL on the command line is refused/,
      );
      process.env.ZK_RPC_URL = "http://a.example,http://b.example";
      expect(() => rpcFromEnv([])).to.throw("ZK_RPC_URL must name one RPC URL");
      delete process.env.ZK_RPC_URL;
      expect(rpcFromEnv([])).to.equal(undefined);
      // Slice B review L-2: the file form keeps the URL out of history.
      const f = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "zkurl-")),
        "u",
      );
      fs.writeFileSync(f, "http://127.0.0.1:1/f1l3k3y\n", { mode: 0o600 });
      process.env.ZK_RPC_URL_FILE = f;
      expect(rpcFromEnv([])).to.equal("http://127.0.0.1:1/f1l3k3y");
      fs.chmodSync(f, 0o644);
      expect(() => rpcFromEnv([])).to.throw(
        /ZK_RPC_URL_FILE must be this user's own file, mode 0600/,
      );
      delete process.env.ZK_RPC_URL_FILE;
    } finally {
      if (was === undefined) delete process.env.ZK_RPC_URL;
      else process.env.ZK_RPC_URL = was;
    }
  });

  // The lead's ruling on slice B review L-2 (R-515-10): keys too have a
  // 0600-file form, so no key lands in shell history.
  it("reads each key from its 0600 file, refuses a looser one, keeps the plain form", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zkkey-"));
    const f = path.join(dir, "k");
    fs.writeFileSync(f, `${HARDHAT0}\n`, { mode: 0o600 });
    for (const name of [
      "WHITELIST_OPS_KEY",
      "WHITELIST_WALLET_KEY",
      "ATTESTOR_KEY",
    ]) {
      expect(keyFromEnv(name, { [`${name}_FILE`]: f })).to.equal(HARDHAT0);
      expect(keyFromEnv(name, { [name]: ` ${HARDHAT0} ` })).to.equal(HARDHAT0);
      expect(keyFromEnv(name, {})).to.equal(undefined);
    }
    fs.chmodSync(f, 0o640);
    expect(() => keyFromEnv("ATTESTOR_KEY", { ATTESTOR_KEY_FILE: f })).to.throw(
      "ATTESTOR_KEY_FILE must be this user's own file, mode 0600",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a published Hardhat key off 31337 only", function () {
    expect(() => guardKey(HARDHAT0, 11155111n, "WHITELIST_OPS_KEY")).to.throw(
      "WHITELIST_OPS_KEY is a published Hardhat test key: refused on chain 11155111 (anyone holds it)",
    );
    expect(() =>
      guardKey(HARDHAT0.slice(2).toUpperCase(), 1, "ATTESTOR_KEY"),
    ).to.throw(/ATTESTOR_KEY is a published Hardhat test key/);
    expect(() =>
      guardKey(HARDHAT0, 31337n, "WHITELIST_OPS_KEY"),
    ).to.not.throw();
    expect(() =>
      guardKey(HDNodeWallet.createRandom().privateKey, 11155111, "X"),
    ).to.not.throw();
  });

  it("build-whitelist-root --publish on a Sepolia RPC refuses the Hardhat key before any send", async function () {
    const up = await fakeUpstream(11155111);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zk-cli-"));
    try {
      const entries = path.join(dir, "entries.json");
      fs.writeFileSync(
        entries,
        JSON.stringify([{ identity: "0x01", commitment: "0x02" }]),
      );
      // Not spawnSync: the fake upstream answers from this process.
      const run = (args: string[], env: Record<string, string>) =>
        new Promise<{ status: number | null; stderr: string }>((ok) => {
          const p = spawn(
            process.execPath,
            ["scripts/zk/build-whitelist-root.js", ...args],
            { env: { ...process.env, ...env } },
          );
          let stderr = "";
          p.stderr.on("data", (d) => (stderr += d));
          p.on("exit", (status) => ok({ status, stderr }));
        });
      const pm = "0x000000000000000000000000000000000000dEaD";
      const r = await run(
        ["--in", entries, "--publish", "--privacy-manager", pm],
        {
          ZK_RPC_URL: up.url,
          WHITELIST_OPS_KEY: HARDHAT0,
        },
      );
      expect(r.status, r.stderr).to.equal(1);
      expect(r.stderr).to.contain(
        "WHITELIST_OPS_KEY is a published Hardhat test key: refused on chain 11155111",
      );
      expect(up.raws).to.deep.equal([]);
      // The same key from its 0600 file: read, and refused the same way.
      const kf = path.join(dir, "ops.key");
      fs.writeFileSync(kf, HARDHAT0, { mode: 0o600 });
      const viaFile = await run(
        ["--in", entries, "--publish", "--privacy-manager", pm],
        { ZK_RPC_URL: up.url, WHITELIST_OPS_KEY_FILE: kf },
      );
      expect(viaFile.status, viaFile.stderr).to.equal(1);
      expect(viaFile.stderr).to.contain(
        "WHITELIST_OPS_KEY is a published Hardhat test key: refused on chain 11155111",
      );
      const argv = await run(
        [
          "--in",
          entries,
          "--publish",
          "--rpc",
          up.url,
          "--privacy-manager",
          pm,
        ],
        { WHITELIST_OPS_KEY: HARDHAT0 },
      );
      expect(argv.status).to.equal(1);
      expect(argv.stderr).to.contain("--rpc <url> is refused");
      expect(argv.stderr).to.not.contain(up.url);
    } finally {
      up.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  // Task 5.17 (R-515-10, a security review of slice B): every zk CLI's
  // final error print scrubs every known RPC URL; prove-whitelist did not.
  describeProofs("prove-whitelist --submit: a failing upstream", function () {
    it("prints the upstream's error without the key in its URL", async function () {
      this.timeout(300_000);
      const KEY = "zkS3cretK3y0123456789abcdef";
      const http = require("http");
      // Answers the chain id; every other call is an HTTP 500 whose body
      // echoes the key (ethers then prints the request URL and the body).
      const server = http.createServer((req: any, res: any) => {
        let body = "";
        req.on("data", (c: string) => (body += c));
        req.on("end", () => {
          const c = JSON.parse(body);
          if (!Array.isArray(c) && c.method === "eth_chainId") {
            res.setHeader("content-type", "application/json");
            return res.end(
              JSON.stringify({ jsonrpc: "2.0", id: c.id, result: "0x7a69" }),
            );
          }
          res.statusCode = 500;
          res.end(`backend down for /v3/${KEY}`);
        });
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const url = `http://127.0.0.1:${server.address().port}/v3/${KEY}`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zk-submit-"));
      try {
        const w = HDNodeWallet.createRandom();
        const identity = "0x1234";
        const secret = "0x" + "11".repeat(31);
        const commitment = await computeCommitment(identity, secret);
        const root = await buildWhitelistRoot([
          { identity, commitment: commitment.toString() },
        ]);
        fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root));
        fs.writeFileSync(path.join(dir, "secret"), secret, { mode: 0o600 });
        const r = await new Promise<{ status: number | null; stderr: string }>(
          (ok) => {
            const p = spawn(
              process.execPath,
              [
                "scripts/zk/prove-whitelist.js",
                "--root",
                path.join(dir, "root.json"),
                "--identity",
                identity,
                "--wallet",
                w.address,
                "--secret-file",
                path.join(dir, "secret"),
                "--submit",
                "--privacy-manager",
                "0x000000000000000000000000000000000000dEaD",
              ],
              {
                env: {
                  ...process.env,
                  ZK_RPC_URL: url,
                  WHITELIST_WALLET_KEY: w.privateKey,
                },
              },
            );
            let stderr = "";
            p.stderr.on("data", (d) => (stderr += d));
            p.on("exit", (status) => ok({ status, stderr }));
          },
        );
        expect(r.status, r.stderr).to.equal(1);
        const last = r.stderr.trim().split("\n").pop()!;
        expect(last).to.match(/^prove-whitelist: /);
        expect(last).to.contain("<redacted>");
        expect(r.stderr).to.not.contain(KEY);
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
