import { expect } from "chai";
import { ethers } from "ethers";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, rpc, runSigner } from "../helpers/signerProcess";

/**
 * Task 5.17 (slice B review M-1): scripts/production/signer.js records the
 * transaction it signed at each nonce before broadcasting it. A broadcast
 * that failed once (a rate limit) used to lock that nonce for good: the
 * retry (RpcRetry resends the same request) was populated with fresh fees,
 * its hash differed, and the signer refused it, then and after every
 * restart. Now the same caller fields at a recorded nonce are the same
 * transaction: re-broadcast while its fee clears the base fee, signed
 * again with fresh fees (a fee bump) when it does not; another
 * transaction there is still refused; `forget` drops a stuck entry.
 */
describe("Signer: a failed broadcast's retry, fee bumps, forget (M-1)", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  const key = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom().address;
  let dir: string;
  const tx = (to = key.address) => ({
    from: key.address,
    to,
    value: "0x1",
    nonce: "0x7",
  });

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-retry-"));
    fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
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
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = (url: string) => ({
    SIGNER_UPSTREAM: url,
    SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
    SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
    SIGNER_TOKEN_FILE: path.join(dir, "token"),
    SIGNER_PROMPT: "0",
  });

  it("a rate-limited broadcast's retry completes with one transaction", async function () {
    const up = await fakeUpstream(11155111);
    up.fault.raw = 1;
    try {
      const r = await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live) => {
          const first = await rpc(live, "eth_sendTransaction", [tx()]);
          expect(first.body.error.message).to.match(/rate limit/);
          up.fault.baseFee = "0x47868c00"; // 1.2 gwei: the recorded fee clears
          const again = await rpc(live, "eth_sendTransaction", [tx()]);
          expect(again.body.result, JSON.stringify(again.body)).to.match(
            /^0x[0-9a-f]{64}$/,
          );
        },
      );
      expect(r.code, r.out).to.equal(0);
      expect(up.raws.length).to.equal(1);
      expect(ethers.keccak256(up.raws[0])).to.equal(
        ethers.Transaction.from(up.raws[0]).hash,
      );
    } finally {
      up.server.close();
    }
  });

  it("a retry whose fee no longer clears is signed again as a fee bump", async function () {
    const up = await fakeUpstream(11155111);
    up.fault.raw = 1;
    try {
      const r = await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live) => {
          await rpc(live, "eth_sendTransaction", [tx()]);
          up.fault.baseFee = "0x12a05f200"; // 5 gwei: above the recorded maxFee
          const again = await rpc(live, "eth_sendTransaction", [tx()]);
          expect(again.body.result).to.match(/^0x[0-9a-f]{64}$/);
        },
      );
      expect(r.code, r.out).to.equal(0);
      expect(r.out).to.contain("fee bump of nonce 7, same transaction");
      expect(up.raws.length).to.equal(1);
      const t = ethers.Transaction.from(up.raws[0]);
      expect(t.nonce).to.equal(7);
      expect(t.maxFeePerGas! >= 5_000_000_000n).to.equal(true);
    } finally {
      up.server.close();
    }
  });

  it("a re-run whose gas estimate moved by one is the same transaction, signed again (slice C review L-1)", async function () {
    const up = await fakeUpstream(11155111);
    up.fault.raw = 1;
    try {
      const r = await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live) => {
          await rpc(live, "eth_sendTransaction", [{ ...tx(), gas: "0x5208" }]);
          up.fault.baseFee = "0x47868c00"; // the recorded fee still clears
          const again = await rpc(live, "eth_sendTransaction", [
            { ...tx(), gas: "0x5209" },
          ]);
          expect(again.body.result, JSON.stringify(again.body)).to.match(
            /^0x[0-9a-f]{64}$/,
          );
        },
      );
      expect(r.code, r.out).to.equal(0);
      expect(r.out).to.contain(
        "fee bump of nonce 7, same transaction (its gasLimit moved)",
      );
      expect(up.raws.length).to.equal(1);
      expect(ethers.Transaction.from(up.raws[0]).gasLimit).to.equal(0x5209n);
    } finally {
      up.server.close();
    }
  });

  it("a lower requested fee is re-signed as such, not called a fee bump (slice D review INFO-5)", async function () {
    const up = await fakeUpstream(11155111);
    try {
      const r = await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live) => {
          const fee = {
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x1",
          };
          await rpc(live, "eth_sendTransaction", [{ ...tx(), ...fee }]);
          const again = await rpc(live, "eth_sendTransaction", [
            { ...tx(), ...fee, maxFeePerGas: "0x3b9aca00" },
          ]);
          expect(again.body.result, JSON.stringify(again.body)).to.match(
            /^0x[0-9a-f]{64}$/,
          );
        },
      );
      expect(r.code, r.out).to.equal(0);
      expect(r.out).to.contain(
        "re-signed with the requested fees, nonce 7, same transaction (its maxFeePerGas moved)",
      );
      expect(r.out).to.not.contain("fee bump");
    } finally {
      up.server.close();
    }
  });

  it("another transaction at a recorded nonce is refused; forget drops the entry", async function () {
    const up = await fakeUpstream(11155111);
    try {
      await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live) => {
          expect(
            (await rpc(live, "eth_sendTransaction", [tx()])).body.result,
          ).to.match(/^0x/);
          const diff = await rpc(live, "eth_sendTransaction", [tx(other)]);
          expect(diff.body.error.message).to.match(
            /nonce 7 of 0x[0-9a-fA-F]{40} was already signed for another transaction \(its to differs\): refused; never to be mined\? run: signer\.js forget 0x[0-9a-fA-F]{40} 7/,
          );
        },
      );
      const f = spawnSync(
        process.execPath,
        ["scripts/production/signer.js", "forget", key.address, "7"],
        { env: { ...process.env, ...env(up.url) }, encoding: "utf8" },
      );
      expect(f.status, f.stderr).to.equal(0);
      expect(f.stdout).to.match(
        new RegExp(
          `signer: forgot 11155111:${key.address.toLowerCase()}:7 in .*keys/signed-nonces`,
        ),
      );
      await runSigner(
        "scripts/production/signer.js",
        env(up.url),
        async (live) => {
          const now = await rpc(live, "eth_sendTransaction", [tx(other)]);
          expect(now.body.result).to.match(/^0x[0-9a-f]{64}$/);
        },
      );
      expect(up.raws.length).to.equal(2);
    } finally {
      up.server.close();
    }
  });

  it("signer.js new warns when a name sorts before an existing keystore", function () {
    const run = (name: string) =>
      spawnSync(
        process.execPath,
        ["scripts/production/signer.js", "new", path.join(dir, "keys"), name],
        {
          env: { ...process.env, SIGNER_PASSWORD_FILE: path.join(dir, "pass") },
          encoding: "utf8",
        },
      );
    const early = run("0-claim-kyc");
    expect(early.status, early.stderr).to.equal(0);
    expect(early.stderr).to.contain(
      "warning: 0-claim-kyc.json sorts before a.json: every wallet index from it on shifts",
    );
    const late = run("b-late");
    expect(late.status).to.equal(0);
    expect(late.stderr).to.not.contain("warning");
  });
});
