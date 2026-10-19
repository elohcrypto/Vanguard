import { expect } from "chai";
import { ethers } from "ethers";
import { spawnSync } from "child_process";
import * as http from "http";
import { AddressInfo } from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, rpc, runSigner } from "../helpers/signerProcess";

/**
 * Task 5.15 (Q16 = A, readiness review M-1): scripts/production/signer.js,
 * the self-hosted multi-account signer, against a fake upstream (an
 * ephemeral 127.0.0.1 port; the signer itself listens on port 0). Its
 * keystores are made here at runtime with a fast scrypt cost. Who may
 * call it: test/production/SignerGuard.test.ts.
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

  /** The signer on `chain`, `use` while it listens; exit code, output, raws. */
  async function signer(
    chain: number,
    env: Record<string, string>,
    use?: Parameters<typeof runSigner>[2],
  ) {
    const up = await fakeUpstream(chain);
    try {
      const r = await runSigner(
        "scripts/production/signer.js",
        {
          SIGNER_UPSTREAM: up.url,
          SIGNER_KEYSTORE_DIR: path.join(dir, "ok"),
          SIGNER_PASSWORD_FILE: passFile,
          SIGNER_TOKEN_FILE: path.join(dir, "token"),
          // Task 5.17 (L-5): asking is the default off 31337; these
          // runs have no terminal.
          SIGNER_PROMPT: "0",
          SIGNER_TEST: "",
          ...env,
        },
        use,
      );
      return { ...r, raws: up.raws };
    } finally {
      up.server.close();
    }
  }

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
      "SIGNER_PROMPT=1 needs a controlling terminal (/dev/tty)",
    );
  });

  it("answers every key in file-name order, signs, shows a repeat as a retry, logs no secret", async function () {
    let accounts: string[] = [];
    let sig = "";
    let token = "";
    const msg = ethers.hexlify(ethers.randomBytes(32));
    const tx = {
      from: keys[1].address,
      to: keys[0].address,
      value: "0x1",
      nonce: "0x7",
    };
    const r = await signer(11155111, {}, async (live) => {
      token = live.token;
      accounts = (await rpc(live, "eth_accounts")).body.result;
      sig = (await rpc(live, "personal_sign", [msg, keys[0].address])).body
        .result;
      for (let i = 0; i < 2; i++) await rpc(live, "eth_sendTransaction", [tx]);
      const data = new ethers.Interface([
        "function transfer(address,uint256)",
      ]).encodeFunctionData("transfer", [keys[0].address, 5]);
      const unpinned = { from: keys[1].address, to: keys[0].address, data };
      for (let i = 0; i < 2; i++)
        await rpc(live, "eth_sendTransaction", [unpinned]);
      const other = await rpc(live, "eth_sendTransaction", [
        { ...tx, from: ethers.ZeroAddress },
      ]);
      expect(other.body.error.message).to.contain("holds no key");
      expect((await rpc(live, "eth_blockNumber")).body.result).to.equal("0x10");
    });
    expect(accounts).to.deep.equal(keys.map((k) => k.address));
    expect(ethers.verifyMessage(ethers.getBytes(msg), sig)).to.equal(
      keys[0].address,
    );
    expect(r.raws.length).to.equal(4);
    expect(ethers.Transaction.from(r.raws[0]).nonce).to.equal(7);
    // The signed fields (scripts/production/signerPrompt.js); no artifact
    // runs at the fake chain's addresses, so no call is decoded.
    expect(r.out).to.match(
      /#2 send\n\s+unknown contract: selector 0x\n\s+to 0x[0-9a-fA-F]{40} \| value 0\.000000000000000001 ETH \(1 wei\) \| nonce 7 \|/,
    );
    expect(r.out).to.match(/#2 RETRY of #2 \(same request\): send/);
    // No pinned nonce: never a retry (review L-4).
    expect(r.out).to.match(
      /#\d+ send\n\s+unknown contract: selector 0xa9059cbb\n\s+to .* nonce 5 \|/,
    );
    expect(r.out.match(/RETRY/g)?.length).to.equal(1);
    for (const k of keys) expect(r.out).to.not.contain(k.privateKey.slice(2));
    expect(r.out).to.not.contain(PASS);
    expect(r.out).to.not.contain(token);
  });

  it("a startup failure echoing the upstream's key never reaches stderr", async function () {
    const KEY = "STARTUPKEY4455667";
    const srv = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: `invalid project ${KEY} for ${req.url}`,
          },
        }),
      );
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v3/${KEY}`;
      const r = await runSigner("scripts/production/signer.js", {
        SIGNER_UPSTREAM: url,
        SIGNER_KEYSTORE_DIR: path.join(dir, "ok"),
        SIGNER_PASSWORD_FILE: passFile,
        SIGNER_TOKEN_FILE: path.join(dir, "token-startup"),
      });
      expect(r.code).to.equal(3);
      expect(r.out).to.match(/^signer: /m);
      expect(r.out).to.not.contain(KEY);
    } finally {
      srv.close();
    }
  });
});
