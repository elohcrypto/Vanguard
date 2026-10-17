import { expect } from "chai";
import { ethers } from "ethers";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";

/**
 * Task 5.15 (Q16 = A, readiness review M-1): scripts/production/signer.js,
 * the self-hosted multi-account signer, against a fake upstream (an
 * ephemeral 127.0.0.1 port; the signer itself listens on port 0). Its
 * keystores are made here at runtime with a fast scrypt cost.
 */
describe("Production signer (scripts/production/signer.js)", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  const PHRASE = "test test test test test test test test test test test junk";
  let dir: string;
  let passFile: string;
  const keys = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];

  async function keystore(
    file: string,
    w: ethers.Wallet | ethers.HDNodeWallet,
    mode = 0o600,
  ) {
    const json = await ethers.encryptKeystoreJson(
      { address: w.address, privateKey: w.privateKey },
      PASS,
      { scrypt: { N: 1 << 10 } },
    );
    fs.writeFileSync(file, json, { mode });
    fs.chmodSync(file, mode);
  }
  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-"));
    for (const d of ["ok", "open", "published"])
      fs.mkdirSync(path.join(dir, d));
    // File-name order is wallet-index order: "b" sorts after "a".
    await keystore(path.join(dir, "ok", "b-second.json"), keys[1]);
    await keystore(path.join(dir, "ok", "a-first.json"), keys[0]);
    await keystore(path.join(dir, "open", "a.json"), keys[0], 0o644);
    await keystore(
      path.join(dir, "published", "a.json"),
      ethers.HDNodeWallet.fromPhrase(PHRASE, undefined, "m/44'/60'/0'/0/0"),
    );
    passFile = path.join(dir, "pass");
    fs.writeFileSync(passFile, `${PASS}\n`, { mode: 0o600 });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A fake upstream on chain `chain`; records the raw transactions sent. */
  async function upstream(chain: number) {
    const raws: string[] = [];
    const answers: Record<string, (p: any[]) => unknown> = {
      eth_chainId: () => ethers.toQuantity(chain),
      eth_getTransactionCount: () => "0x5",
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_maxPriorityFeePerGas: () => "0x3b9aca00",
      eth_blockNumber: () => "0x10",
      eth_getBlockByNumber: () => ({
        number: "0x10",
        hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        parentHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        nonce: "0x0000000000000000",
        difficulty: "0x0",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        miner: ethers.ZeroAddress,
        extraData: "0x",
        baseFeePerGas: "0x3b9aca00",
        timestamp: "0x1",
        transactions: [],
      }),
      eth_sendRawTransaction: (p) => {
        raws.push(p[0]);
        return ethers.keccak256(p[0]);
      },
      eth_getTransactionByHash: () => null,
    };
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const one = (c: any) =>
          answers[c.method]
            ? {
                jsonrpc: "2.0",
                id: c.id,
                result: answers[c.method](c.params || []),
              }
            : {
                jsonrpc: "2.0",
                id: c.id,
                error: { code: -32601, message: `no ${c.method}` },
              };
        const call = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(Array.isArray(call) ? call.map(one) : one(call)),
        );
      });
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return {
      s,
      raws,
      url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    };
  }

  /**
   * Start the signer; `use(url)` runs while it listens (url null when it
   * exited first). Resolves to its exit code and output.
   */
  async function signer(
    chain: number,
    env: Record<string, string>,
    use?: (url: string) => Promise<void>,
  ) {
    const up = await upstream(chain);
    try {
      const out = await new Promise<{ code: number | null; out: string }>(
        (ok, ko) => {
          const p = spawn(
            process.execPath,
            ["scripts/production/signer.js", "0"],
            {
              env: {
                ...process.env,
                SIGNER_UPSTREAM: up.url,
                SIGNER_KEYSTORE_DIR: path.join(dir, "ok"),
                SIGNER_PASSWORD_FILE: passFile,
                SIGNER_PROMPT: "",
                SIGNER_TEST: "",
                ...env,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let text = "";
          let started = false;
          const add = (d: Buffer) => {
            text += d;
            const m = text.match(/signer on 127\.0\.0\.1:(\d+)/);
            if (m && !started) {
              started = true;
              (use ? use(`http://127.0.0.1:${m[1]}`) : Promise.resolve()).then(
                () => p.kill("SIGTERM"),
                (e) => (p.kill("SIGTERM"), ko(e)),
              );
            }
          };
          p.stdout.on("data", add);
          p.stderr.on("data", add);
          p.on("exit", (code) => ok({ code, out: text }));
        },
      );
      return { ...out, raws: up.raws };
    } finally {
      up.s.close();
    }
  }
  const call = async (url: string, method: string, params: unknown[] = []) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return r.json();
  };

  it("new: makes encrypted 0600 keystores, prints addresses only, never overwrites", async function () {
    const d = path.join(dir, "made");
    const run = () =>
      spawnSync(
        process.execPath,
        ["scripts/production/signer.js", "new", d, "00-deployer"],
        {
          env: { ...process.env, SIGNER_PASSWORD_FILE: passFile },
          encoding: "utf8",
        },
      );
    const r = run();
    expect(r.status, r.stderr).to.equal(0);
    const [, address] = r.stdout.trim().split(" ");
    const file = path.join(d, "00-deployer.json");
    expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
    const w = await ethers.Wallet.fromEncryptedJson(
      fs.readFileSync(file, "utf8"),
      PASS,
    );
    expect(w.address).to.equal(address);
    expect(r.stdout + r.stderr).to.not.contain(w.privateKey.slice(2));
    const again = run();
    expect(again.status).to.equal(3);
    expect(again.stderr).to.contain("exists; not overwritten");
  });

  it("serves Sepolia only (31337 with SIGNER_TEST=1)", async function () {
    for (const [chain, env] of [
      [1, {}],
      [31337, {}],
      [5, { SIGNER_TEST: "1" }],
    ] as const) {
      const r = await signer(chain, env);
      expect(r.code, String(chain)).to.equal(3);
      expect(r.out).to.contain("this signer serves Sepolia (11155111) only");
    }
  });

  it("refuses a keystore or password file others can read, and the Hardhat keys off the test chain", async function () {
    const open = await signer(11155111, {
      SIGNER_KEYSTORE_DIR: path.join(dir, "open"),
    });
    expect(open.code).to.equal(3);
    expect(open.out).to.match(
      /a\.json is readable by group or others \(mode 644\): chmod 600/,
    );
    const loose = path.join(dir, "loose");
    fs.writeFileSync(loose, PASS, { mode: 0o640 });
    fs.chmodSync(loose, 0o640);
    const pw = await signer(11155111, { SIGNER_PASSWORD_FILE: loose });
    expect(pw.code).to.equal(3);
    expect(pw.out).to.contain("readable by group or others");
    const pub = await signer(11155111, {
      SIGNER_KEYSTORE_DIR: path.join(dir, "published"),
    });
    expect(pub.code).to.equal(3);
    expect(pub.out).to.contain("hold a published Hardhat test key");
    const wrong = path.join(dir, "wrong");
    fs.writeFileSync(wrong, "not the password", { mode: 0o600 });
    const bad = await signer(11155111, { SIGNER_PASSWORD_FILE: wrong });
    expect(bad.code).to.equal(3);
    expect(bad.out).to.contain("wrong password or not a keystore");
  });

  it("refuses SIGNER_PROMPT=1 off a terminal", async function () {
    const r = await signer(11155111, { SIGNER_PROMPT: "1" });
    expect(r.code).to.equal(3);
    expect(r.out).to.contain(
      "SIGNER_PROMPT=1 needs this process on a terminal",
    );
  });

  it("answers every key in file-name order, signs, shows a repeat as a retry, logs no secret", async function () {
    let accounts: string[] = [];
    let sig = "";
    const msg = ethers.hexlify(ethers.randomBytes(32));
    const tx = {
      from: keys[1].address,
      to: keys[0].address,
      value: "0x1",
      nonce: "0x7",
    };
    const r = await signer(11155111, {}, async (url) => {
      accounts = (await call(url, "eth_accounts")).result;
      sig = (await call(url, "personal_sign", [msg, keys[0].address])).result;
      for (let i = 0; i < 2; i++) await call(url, "eth_sendTransaction", [tx]);
      const other = await call(url, "eth_sendTransaction", [
        { ...tx, from: ethers.ZeroAddress },
      ]);
      expect(other.error.message).to.contain("holds no key");
      expect((await call(url, "eth_blockNumber")).result).to.equal("0x10");
      const raw = await call(url, "eth_signTransaction", [tx]);
      expect(raw.error.message).to.contain("refused");
    });
    expect(accounts).to.deep.equal(keys.map((k) => k.address));
    expect(ethers.verifyMessage(ethers.getBytes(msg), sig)).to.equal(
      keys[0].address,
    );
    expect(r.raws.length).to.equal(2);
    expect(ethers.Transaction.from(r.raws[0]).nonce).to.equal(7);
    expect(r.out).to.match(
      /#2 send from 0x[0-9a-fA-F]{40} to 0x[0-9a-fA-F]{40} value 1 nonce 7/,
    );
    expect(r.out).to.match(/#2 RETRY of #2 \(same request\): send from/);
    for (const k of keys) {
      expect(r.out).to.not.contain(k.privateKey.slice(2));
    }
    expect(r.out).to.not.contain(PASS);
  });
});
