// Review D-4, round 2 (ported from the swarm's attack-u2-signer S1 and
// S4, inverted): one signer per keystore directory. A second signer on
// the same directory refuses to start while the first runs (each would
// keep the signed-nonce record in memory and both sign nonce 7); a lock
// left by a killed signer is taken over. The directory must be this
// user's, mode 0700, and the record's temporary file is created
// exclusively, so a path planted there is refused, never written through.
import { expect } from "chai";
import { ethers } from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, rpc, Live } from "../helpers/signerProcess";

describe("D-4 one signer per keystore directory", function () {
  this.timeout(180_000);
  const PASS = "a long enough test password";
  const key = ethers.Wallet.createRandom();
  let dir: string;
  let n = 0;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "d4-lock-"));
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A keystore directory (0700) holding the test key. */
  async function keystores() {
    const keys = path.join(dir, `keys-${++n}`);
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
    return keys;
  }

  type Up = { p: ChildProcess; live: Live; stop: () => Promise<void> };
  /** signer.js on `keys`: up (its live endpoint) or the output it exited with. */
  function start(keys: string, upstream: string): Promise<Up | string> {
    const tokenFile = path.join(dir, `token-${++n}`);
    const env = {
      ...process.env,
      SIGNER_UPSTREAM: upstream,
      SIGNER_KEYSTORE_DIR: keys,
      SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
      SIGNER_PROMPT: "0",
      SIGNER_TOKEN_FILE: tokenFile,
    } as Record<string, string>;
    return new Promise((ok) => {
      const p = spawn(process.execPath, ["scripts/production/signer.js", "0"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      let up = false;
      const stop = () =>
        new Promise<void>((r) => {
          p.once("exit", () => r());
          p.kill("SIGTERM");
        });
      const add = (d: Buffer) => {
        text += d;
        const m = text.match(/signer on 127\.0\.0\.1:(\d+)/);
        if (!m || up) return;
        up = true;
        const port = Number(m[1]);
        const token = fs.readFileSync(tokenFile, "utf8").trim();
        ok({ p, live: { url: `http://127.0.0.1:${port}`, port, token }, stop });
      };
      p.stdout.on("data", add);
      p.stderr.on("data", add);
      p.on("exit", () => up || ok(text));
    });
  }
  const tx = (value: string) => ({
    from: key.address,
    to: key.address,
    value,
    nonce: "0x7",
  });

  it("S1: a second signer on a running signer's keystores refuses to start", async function () {
    const up = await fakeUpstream(11155111);
    const keys = await keystores();
    const A = (await start(keys, up.url)) as Up;
    expect(A, "the first signer starts").to.have.property("live");
    try {
      const B = await start(keys, up.url);
      if (typeof B !== "string") await B.stop();
      expect(B, "the second signer").to.be.a("string");
      expect(B).to.match(
        new RegExp(
          `signer: ${keys}/signer\\.lock is held by pid ${A.p.pid} \\(a signer running on these keystores\\): refusing to start`,
        ),
      );
      const a = await rpc(A.live, "eth_sendTransaction", [tx("0x1")]);
      expect(a.body.result).to.match(/^0x[0-9a-f]{64}$/);
      expect(up.raws).to.have.length(1);
    } finally {
      await A.stop();
      up.server.close();
    }
  });

  it("a lock left by a killed signer is taken over", async function () {
    const up = await fakeUpstream(11155111);
    const keys = await keystores();
    const A = (await start(keys, up.url)) as Up;
    expect(A).to.have.property("live");
    await new Promise<void>((r) => {
      A.p.once("exit", () => r());
      A.p.kill("SIGKILL");
    });
    expect(fs.existsSync(path.join(keys, "signer.lock"))).to.equal(true);
    const B = (await start(keys, up.url)) as Up;
    try {
      expect(B, "a dead holder's lock is taken over").to.have.property("live");
    } finally {
      if (typeof B !== "string") await B.stop();
      up.server.close();
    }
    expect(fs.existsSync(path.join(keys, "signer.lock"))).to.equal(false);
  });

  it("S4: a keystore directory others can enter is refused at start", async function () {
    const up = await fakeUpstream(11155111);
    const keys = await keystores();
    fs.chmodSync(keys, 0o777);
    try {
      const s = await start(keys, up.url);
      if (typeof s !== "string") await s.stop();
      expect(s).to.match(
        new RegExp(
          `signer: ${keys} must be this user's own directory, mode 0700 \\(it is 777\\): chmod 700 ${keys}`,
        ),
      );
    } finally {
      up.server.close();
    }
  });

  it("S4: a path planted at the record's temporary file is refused, not written through", async function () {
    const up = await fakeUpstream(11155111);
    const keys = await keystores();
    const s = (await start(keys, up.url)) as Up;
    expect(s).to.have.property("live");
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    fs.symlinkSync(victim, path.join(keys, `signed-nonces.tmp-${s.p.pid}`));
    try {
      const a = await rpc(s.live, "eth_sendTransaction", [tx("0x1")]);
      expect(a.body.error?.message, JSON.stringify(a.body)).to.match(
        /signed-nonces\.tmp-\d+ exists: refusing to write the signed-nonce record through it/,
      );
      expect(fs.readFileSync(victim, "utf8")).to.equal("precious\n");
      expect(up.raws, "nothing signed is sent").to.have.length(0);
    } finally {
      await s.stop();
      up.server.close();
    }
  });
});
