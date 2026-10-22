// Review D-4 (ported from the reviewer's P-D-4.test.ts, inverted): the
// signer's "already signed at this nonce" record lives beside the
// keystores, so a restart on another port, or after the temp directory
// is cleaned, still refuses a different transaction at a signed nonce.
import { expect } from "chai";
import { ethers } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, rpc } from "../helpers/signerProcess";

describe("D-4 the signer's signed-nonce record survives a restart", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  const key = ethers.Wallet.createRandom();
  let dir: string;
  let tmp: string; // plays /tmp for the signer (TMPDIR)
  let keys: string;

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-"));
    keys = path.join(dir, "keys");
    fs.mkdirSync(keys, { mode: 0o700 });
    fs.writeFileSync(
      path.join(keys, "a.json"),
      await ethers.encryptKeystoreJson(
        { address: key.address, privateKey: key.privateKey },
        PASS,
        { scrypt: { N: 1 << 10 } },
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
    tmp = path.join(dir, "tmp");
    fs.mkdirSync(tmp, { mode: 0o700 });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stateDir = () => path.join(tmp, `vanguard-signer-${process.getuid!()}`);

  /** The real signer.js on an ephemeral port, the token at its default place. */
  async function signer(
    upUrl: string,
    use: (u: { url: string; port: number; token: string }) => Promise<void>,
  ) {
    const env = {
      ...process.env,
      TMPDIR: tmp,
      SIGNER_UPSTREAM: upUrl,
      SIGNER_KEYSTORE_DIR: keys,
      SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
      SIGNER_PROMPT: "0",
    } as Record<string, string>;
    delete env.SIGNER_TOKEN_FILE;
    return new Promise<{ code: number | null; out: string }>((ok, ko) => {
      const p = spawn(process.execPath, ["scripts/production/signer.js", "0"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      let started = false;
      const add = (d: Buffer) => {
        text += d;
        const m = text.match(/signer on 127\.0\.0\.1:(\d+)/);
        if (!m || started) return;
        started = true;
        const token = fs
          .readFileSync(path.join(stateDir(), `${m[1]}.token`), "utf8")
          .trim();
        use({
          url: `http://127.0.0.1:${m[1]}`,
          port: Number(m[1]),
          token,
        }).then(
          () => p.kill("SIGTERM"),
          (e) => (p.kill("SIGTERM"), ko(e)),
        );
      };
      p.stdout.on("data", add);
      p.stderr.on("data", add);
      p.on("exit", (code) => ok({ code, out: text }));
    });
  }

  it("another port, or a cleaned temp directory, still refuses a different transaction at a signed nonce", async function () {
    const up = await fakeUpstream(11155111);
    const tx = {
      from: key.address,
      to: key.address,
      value: "0x1",
      nonce: "0x7",
    };
    const other = { ...tx, value: "0x2" };
    const refused =
      /nonce 7 of 0x[0-9a-fA-F]{40} was already signed for another transaction/;
    const remembered = (out: string) =>
      (out.match(/(\d+) signed nonce\(s\) remembered/) || [])[1];
    try {
      let r = await signer(up.url, async (live) => {
        const a = await rpc(live, "eth_sendTransaction", [tx]);
        expect(a.body.result).to.match(/^0x[0-9a-f]{64}$/);
      });
      expect(r.code, r.out).to.equal(0);
      const records = fs.readdirSync(keys).filter((f) => f !== "a.json");
      expect(records, "the record beside the keystores").to.have.length(1);
      expect(fs.statSync(path.join(keys, records[0])).mode & 0o777).to.equal(
        0o600,
      );
      expect(up.raws.length).to.equal(1);

      // a restart on another (ephemeral) port
      r = await signer(up.url, async (live) => {
        const a = await rpc(live, "eth_sendTransaction", [other]);
        expect(a.body.error?.message, JSON.stringify(a.body)).to.match(refused);
      });
      expect(remembered(r.out)).to.equal("1");
      expect(up.raws.length).to.equal(1);

      // the temp directory cleaned (tmpfs /tmp after a reboot, tmpfiles age cleanup)
      fs.rmSync(stateDir(), { recursive: true, force: true });
      r = await signer(up.url, async (live) => {
        const a = await rpc(live, "eth_sendTransaction", [other]);
        expect(a.body.error?.message, JSON.stringify(a.body)).to.match(refused);
      });
      expect(remembered(r.out)).to.equal("1");
      expect(up.raws.length).to.equal(1);
    } finally {
      up.server.close();
    }
  });
});
