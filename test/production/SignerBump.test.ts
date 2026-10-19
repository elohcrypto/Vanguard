import { expect } from "chai";
import { ethers, network } from "hardhat";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { rpc, runSigner } from "../helpers/signerProcess";

const { awaitSettledNonces } = require("../../demo/utils/PendingNonces");

/**
 * Task 5.17 slice C review L-5: after its wait a CLI refused with "wait
 * for them to mine or drop", but nothing could replace a transaction
 * stuck at too low a fee. The refusal now names each stuck sender and
 * nonce and the way out, `signer.js bump <address> <nonce> [port]`: the
 * running production signer sends the transaction it recorded there
 * again with higher fees. Here the signer's upstream is this process's
 * Hardhat network with automine off, served over HTTP.
 */
describe("Signer bump: a stuck low-fee transaction replaced (L-5)", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  let dir: string;
  let server: http.Server;
  let url: string;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-bump-"));
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const c = JSON.parse(body);
        const out = await network.provider
          .request({ method: c.method, params: c.params || [] })
          .then(
            (result) => ({ jsonrpc: "2.0", id: c.id, result }),
            (e: any) => ({
              jsonrpc: "2.0",
              id: c.id,
              error: { code: -32000, message: e.message },
            }),
          );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async function () {
    await network.provider.send("evm_setAutomine", [true]);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the stuck nonce and the command; the bump mines it", async function () {
    const key = ethers.Wallet.createRandom();
    fs.mkdirSync(path.join(dir, "keys"));
    fs.writeFileSync(
      path.join(dir, "keys", "a.json"),
      await ethers.encryptKeystoreJson(
        { address: key.address, privateKey: key.privateKey },
        PASS,
        { scrypt: { N: 1 << 10 } },
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
    await network.provider.send("hardhat_setBalance", [
      key.address,
      "0xde0b6b3a7640000",
    ]);
    const nonce = await ethers.provider.getTransactionCount(key.address);
    const env = {
      SIGNER_UPSTREAM: url,
      SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
      SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
      SIGNER_TOKEN_FILE: path.join(dir, "token"),
      SIGNER_PROMPT: "0",
      SIGNER_TEST: "1",
    };
    const latest = () => ethers.provider.getTransactionCount(key.address);
    let bumped = "";
    const r = await runSigner(
      "scripts/production/signer.js",
      env,
      async (live) => {
        await network.provider.send("evm_setAutomine", [false]);
        // A low fee (priority 1 wei) and no block mined: it stays pending.
        // Not under the base fee: Hardhat's pending nonce leaves such a
        // transaction out (a geth pool counts it).
        const sent = await rpc(live, "eth_sendTransaction", [
          {
            from: key.address,
            to: key.address,
            value: "0x1",
            nonce: ethers.toQuantity(nonce),
            maxFeePerGas: "0x3b9aca00",
            maxPriorityFeePerGas: "0x1",
          },
        ]);
        expect(sent.body.result, JSON.stringify(sent.body)).to.match(/^0x/);
        await expect(
          awaitSettledNonces([key.address], "the probe", {
            timeoutS: 1,
            pollMs: 200,
            log: () => {},
          }),
        ).to.be.rejectedWith(
          `Stuck at too low a fee? The production signer sends each again with higher fees: node scripts/production/signer.js bump ${key.address} ${nonce} [port]; then re-run`,
        );
        bumped = await new Promise<string>((ok) => {
          const p = spawn(
            process.execPath,
            [
              "scripts/production/signer.js",
              "bump",
              key.address,
              String(nonce),
              String(live.port),
            ],
            { env: { ...process.env, ...env } },
          );
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (out += d));
          p.on("exit", (code) => ok(`${code} ${out}`));
        });
        await network.provider.send("evm_mine", []);
      },
    );
    expect(r.code, r.out).to.equal(0);
    expect(bumped).to.match(
      new RegExp(
        `^0 signer: nonce ${nonce} of ${key.address} sent again with higher fees: 0x[0-9a-f]{64}`,
      ),
    );
    expect(r.out).to.contain(
      `fee bump of nonce ${nonce}, same transaction (signer.js bump)`,
    );
    expect(await latest()).to.equal(nonce + 1);
    // The block took the replacement, not the stuck original.
    const hash = bumped.match(/0x[0-9a-f]{64}/)![0];
    const block = await ethers.provider.getBlock("latest");
    expect(block!.transactions).to.deep.equal([hash]);
    const mined = await ethers.provider.getTransaction(hash);
    expect(mined!.maxPriorityFeePerGas! > 1n).to.equal(true);
  });
});
