import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, rpc, runSigner } from "../helpers/signerProcess";

const { promptMode } = require("../../scripts/production/signerState");

/**
 * Task 5.17 slice B (deep review L-5, L-6): scripts/production/signer.js
 *  - asks by default off the dev chain (SIGNER_PROMPT unset), refuses to
 *    start there without a terminal, and warns loudly on SIGNER_PROMPT=0;
 *  - remembers the nonces it signed across a restart (beside the keystores),
 *    so a restarted signer refuses another transaction at a signed nonce;
 *  - removes its token file when it exits.
 */
describe("Signer state: prompt default, signed nonces, token file (L-5, L-6)", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  const key = ethers.Wallet.createRandom();
  let dir: string;

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-state-"));
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
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = (url: string, extra: Record<string, string> = {}) => ({
    SIGNER_UPSTREAM: url,
    SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
    SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
    SIGNER_TOKEN_FILE: path.join(dir, "token"),
    ...extra,
  });

  it("promptMode: asks off 31337 unless SIGNER_PROMPT=0 (with a warning)", function () {
    expect(promptMode(11155111, undefined)).to.deep.equal({ prompt: true });
    expect(promptMode(11155111, "")).to.deep.equal({ prompt: true });
    expect(promptMode(31337, undefined)).to.deep.equal({ prompt: false });
    expect(promptMode(31337, "1")).to.deep.equal({ prompt: true });
    expect(promptMode(31337, "0")).to.deep.equal({ prompt: false });
    const off = promptMode(11155111, "0");
    expect(off.prompt).to.equal(false);
    expect(off.warning).to.contain(
      "SIGNER_PROMPT=0 on chain 11155111: EVERY REQUEST IS SIGNED WITHOUT ASKING",
    );
    expect(() => promptMode(1, "yes")).to.throw(
      'SIGNER_PROMPT must be 1, 0 or unset, got "yes"',
    );
  });

  it("off 31337 with SIGNER_PROMPT unset it refuses to start without a terminal", async function () {
    const up = await fakeUpstream(11155111);
    try {
      const r = await runSigner("scripts/production/signer.js", env(up.url));
      expect(r.code).to.equal(3);
      expect(r.out).to.contain(
        "the prompt (the default on chain 11155111; SIGNER_PROMPT=0 switches it off) needs a controlling terminal (/dev/tty)",
      );
    } finally {
      up.server.close();
    }
  });

  it("a restarted signer still refuses another transaction at a nonce it signed; the token file goes on exit", async function () {
    const up = await fakeUpstream(11155111);
    const tokenFile = path.join(dir, "token");
    const tx = {
      from: key.address,
      to: key.address,
      value: "0x1",
      nonce: "0x7",
    };
    try {
      const first = await runSigner(
        "scripts/production/signer.js",
        env(up.url, { SIGNER_PROMPT: "0" }),
        async (live) => {
          const a = await rpc(live, "eth_sendTransaction", [tx]);
          expect(a.body.result).to.match(/^0x[0-9a-f]{64}$/);
        },
      );
      expect(first.code, first.out).to.equal(0);
      expect(first.out).to.contain("EVERY REQUEST IS SIGNED WITHOUT ASKING");
      expect(fs.existsSync(tokenFile), "token file left behind").to.equal(
        false,
      );
      const record = path.join(dir, "keys", "signed-nonces");
      expect(fs.statSync(record).mode & 0o777).to.equal(0o600);
      const second = await runSigner(
        "scripts/production/signer.js",
        env(up.url, { SIGNER_PROMPT: "0" }),
        async (live) => {
          const other = await rpc(live, "eth_sendTransaction", [
            { ...tx, value: "0x2" },
          ]);
          expect(other.body.error.message).to.match(
            /nonce 7 of 0x[0-9a-fA-F]{40} was already signed for another transaction/,
          );
          // The same transaction again is its recorded signature, resent.
          const same = await rpc(live, "eth_sendTransaction", [tx]);
          expect(same.body.result).to.match(/^0x[0-9a-f]{64}$/);
        },
      );
      expect(second.code, second.out).to.equal(0);
      expect(second.out).to.contain("1 signed nonce(s) remembered");
      expect(up.raws.length).to.equal(2);
      expect(up.raws[1]).to.equal(up.raws[0]);
    } finally {
      up.server.close();
    }
  });
});
