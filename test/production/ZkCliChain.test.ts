import { expect } from "chai";
import { HDNodeWallet } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream } from "../helpers/signerProcess";

const {
  guardKey,
  refuseRpcArg,
  rpcFromEnv,
} = require("../../scripts/zk/zkChain");

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
    } finally {
      if (was === undefined) delete process.env.ZK_RPC_URL;
      else process.env.ZK_RPC_URL = was;
    }
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
});
