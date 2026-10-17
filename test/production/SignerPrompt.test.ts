import { expect } from "chai";
import { ethers } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, Live, rpc, runSigner } from "../helpers/signerProcess";

const { clean, describeTx } = require("../../scripts/production/signerPrompt");

/**
 * Task 5.15 (the lead's prompt-spoofing requirement): what
 * scripts/production/signer.js shows before it signs is the signed
 * transaction's own fields, every field escaped and capped; the call is
 * decoded only for a contract whose code is a compiled artifact's; and
 * SIGNER_PROMPT=1 signs only on the exact token typed on the controlling
 * terminal (here a pty made by script(1)).
 */
describe("Signer prompt (signerPrompt.js)", function () {
  this.timeout(120_000);
  const PASS = "a long enough test password";
  const key = ethers.Wallet.createRandom();
  const ESC = "\x1b[2K\r   \u2705 APPROVED by the operator";
  const BIDI = "pay \u202eLIVE\u202c";
  const gov = JSON.parse(
    fs.readFileSync(
      "artifacts/contracts/governance/VanguardGovernance.sol/VanguardGovernance.json",
      "utf8",
    ),
  );
  const data = new ethers.Interface(gov.abi).encodeFunctionData(
    "createProposal",
    [4, ESC, BIDI + "x".repeat(10_000), key.address, "0x8da5cb5b"],
  );
  let dir: string;

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-"));
    fs.mkdirSync(path.join(dir, "keys"));
    const json = await ethers.encryptKeystoreJson(
      { address: key.address, privateKey: key.privateKey },
      PASS,
      { scrypt: { N: 1 << 10 } },
    );
    fs.writeFileSync(path.join(dir, "keys", "a.json"), json, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("escapes controls, ANSI, bidi and zero-width characters, and caps each field", function () {
    const shown = clean(`${ESC}${BIDI}\u200b`);
    expect(shown).to.not.match(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b]/,
    );
    expect(shown).to.contain("\\x1b[2K\\x0d");
    expect(shown).to.contain("\\u202eLIVE\\u202c");
    expect(shown).to.contain("\\u200b");
    expect(clean("y".repeat(10_000))).to.match(
      /\.\.\.\(truncated, 10000 chars\)$/,
    );
  });

  it("decodes only against a compiled artifact's code; always shows the signed fields", function () {
    const tx = {
      from: key.address,
      to: key.address.toLowerCase(),
      value: 10n ** 18n,
      nonce: 7,
      gasLimit: 90_000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
      data,
    };
    const unknown = describeTx(tx, 11155111, "0x6000");
    expect(unknown.lines[0]).to.contain("unknown contract: selector 0x");
    const known = describeTx(tx, 11155111, gov.deployedBytecode).lines.join(
      "\n",
    );
    expect(known).to.contain("VanguardGovernance.createProposal(4, ");
    expect(known).to.not.match(/[\u001b\r\u202e]/);
    expect(known).to.contain("\\x1b[2K\\x0d");
    expect(known).to.contain("(truncated, ");
    for (const want of [
      `to ${key.address}`,
      "value 1.0 ETH (1000000000000000000 wei)",
      "nonce 7",
      "gas 90000",
      "chain 11155111",
      `data keccak256 ${ethers.keccak256(data)} (${(data.length - 2) / 2} bytes)`,
    ])
      expect(known).to.contain(want);
  });

  it("SIGNER_PROMPT=1 signs only on the exact token typed on the terminal", async function () {
    const up = await fakeUpstream(11155111, gov.deployedBytecode);
    const tokenFile = path.join(dir, "token");
    const env = {
      ...process.env,
      SIGNER_UPSTREAM: up.url,
      SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
      SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
      SIGNER_TOKEN_FILE: tokenFile,
      SIGNER_PROMPT: "1",
    };
    // script(1) gives the signer a controlling terminal; our writes to its
    // stdin are what the operator types there.
    const p = spawn(
      "script",
      ["-qfec", "node scripts/production/signer.js 0", "/dev/null"],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    const waitFor = async (re: RegExp, from = 0) => {
      for (let i = 0; i < 300; i++) {
        const m = text.slice(from).match(re);
        if (m) return m;
        await new Promise((ok) => setTimeout(ok, 100));
      }
      throw new Error(`no ${re} in ${text.slice(-500)}`);
    };
    try {
      const port = Number((await waitFor(/signer on 127\.0\.0\.1:(\d+)/))[1]);
      const live: Live = {
        url: `http://127.0.0.1:${port}`,
        port,
        token: fs.readFileSync(tokenFile, "utf8").trim(),
      };
      const tx = { from: key.address, to: key.address, data, nonce: "0x7" };
      const answer = async (typed: (t: string) => string) => {
        const at = text.length;
        const reply = rpc(live, "eth_sendTransaction", [tx]);
        const m = await waitFor(/type ([0-9a-f]{4}) to sign/, at);
        p.stdin.write(`${typed(m[1])}\n`);
        return { reply: await reply, shown: text.slice(at) };
      };
      const wrong = await answer((t) => (t === "0000" ? "1111" : "0000"));
      expect(wrong.reply.body.error.message).to.match(
        /refused by the operator/,
      );
      expect(up.raws.length).to.equal(0);
      expect(wrong.shown).to.contain("VanguardGovernance.createProposal(");
      expect(wrong.shown).to.contain("\\x1b[2K\\x0d");
      expect(wrong.shown).to.not.contain("\x1b[2K");
      const yes = await answer((t) => t);
      expect(yes.shown).to.contain("RETRY of #1 (same request)");
      expect(yes.reply.body.result).to.match(/^0x[0-9a-f]{64}$/);
      expect(up.raws.length).to.equal(1);
    } finally {
      p.kill("SIGTERM");
      up.server.close();
    }
  });

  it("refuses to start SIGNER_PROMPT=1 without a controlling terminal", async function () {
    const up = await fakeUpstream(11155111);
    try {
      const r = await runSigner("scripts/production/signer.js", {
        SIGNER_UPSTREAM: up.url,
        SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
        SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
        SIGNER_TOKEN_FILE: path.join(dir, "t2"),
        SIGNER_PROMPT: "1",
      });
      expect(r.code).to.equal(3);
      expect(r.out).to.contain(
        "SIGNER_PROMPT=1 needs a controlling terminal (/dev/tty)",
      );
    } finally {
      up.server.close();
    }
  });
});
