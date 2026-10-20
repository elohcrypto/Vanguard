import { expect } from "chai";
import { ethers } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, Live, rpc, runSigner } from "../helpers/signerProcess";

const {
  ascii,
  clean,
  describeTx,
} = require("../../scripts/production/signerPrompt");

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
    expect(known).to.contain(
      'VanguardGovernance.createProposal(proposalType: uint8 = "4", ',
    );
    expect(known).to.not.match(/[\u001b\r\u202e]/);
    expect(known).to.contain("\\u001b[2K\\r");
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
        const m = await waitFor(/type ([0-9a-f]{6}) to sign/, at);
        p.stdin.write(`${typed(m[1])}\n`);
        return { reply: await reply, shown: text.slice(at) };
      };
      const wrong = await answer((t) => (t === "000000" ? "111111" : "000000"));
      expect(wrong.reply.body.error.message).to.match(
        /refused by the operator/,
      );
      expect(up.raws.length).to.equal(0);
      expect(wrong.shown).to.contain("VanguardGovernance.createProposal(");
      expect(wrong.shown).to.contain("\\u001b[2K\\r");
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

  it("tokens bind the whole unsigned transaction; decoded args are ASCII and typed (M-1, L-1, L-2)", function () {
    const base = {
      from: key.address,
      to: key.address,
      value: 1n,
      nonce: 1,
      gasLimit: 21_000n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
      chainId: 11155111n,
      type: 2,
      data: "0x",
    };
    const a = describeTx(base, 11155111, "0x");
    const b = describeTx({ ...base, value: 5n * 10n ** 18n }, 11155111, "0x");
    const c = describeTx({ ...base, to: ethers.ZeroAddress }, 11155111, "0x");
    expect(a.token).to.match(/^[0-9a-f]{6}$/);
    expect(new Set([a.token, b.token, c.token]).size).to.equal(3);
    expect(a.unsigned).to.equal(
      ethers.Transaction.from({ ...base, from: undefined }).unsignedHash,
    );
    for (const ch of [
      "\u00ad",
      "\u3164",
      "\u034f",
      "\ufe0f",
      "\u{e0041}",
      "\u115f",
    ])
      expect(ascii(`x${ch}y`)).to.match(/^x\\u\{[0-9a-f]+\}y$/);
    const arrays = new ethers.Interface([
      "function f(address[] a, address[] b)",
    ]);
    const [x, y] = [key.address, ethers.ZeroAddress];
    const art = {
      abi: arrays.fragments
        .map((f) => f.format("json"))
        .map((j) => JSON.parse(j)),
    };
    void art;
    const two = arrays.encodeFunctionData("f", [[x, y], []]);
    const one = arrays.encodeFunctionData("f", [[x], [y]]);
    const show = (data: string) => {
      const t = arrays.parseTransaction({ data })!;
      return t.fragment.inputs
        .map(
          (p, i) =>
            `${p.name}: ${p.type} = ${JSON.stringify(t.args.toArray(true)[i])}`,
        )
        .join(", ");
    };
    expect(show(two)).to.not.equal(show(one));
    expect(show(two)).to.contain(
      `a: address[] = ["${x}","${y}"], b: address[] = []`,
    );
    // describeTx renders the same form for a known contract.
    const known = describeTx(
      {
        ...base,
        data: new ethers.Interface(gov.abi).encodeFunctionData(
          "createProposal",
          [4, "t", "d", x, "0x8da5cb5b"],
        ),
      },
      11155111,
      gov.deployedBytecode,
    ).lines[0];
    expect(known).to.match(
      /createProposal\(proposalType: uint8 = "4", title: string = "t", description: string = "d", target: address = "0x[0-9a-fA-F]{40}", callData: bytes = "0x8da5cb5b"\)/,
    );
  });

  it("typed-ahead input never approves a later prompt; personal_sign is refused with a prompt (M-1, L-3, L-5)", async function () {
    const up = await fakeUpstream(11155111, gov.deployedBytecode);
    const tokenFile = path.join(dir, "token-ahead");
    const p = spawn(
      "script",
      ["-qfec", "node scripts/production/signer.js 0", "/dev/null"],
      {
        env: {
          ...process.env,
          SIGNER_UPSTREAM: up.url,
          SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
          SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
          SIGNER_TOKEN_FILE: tokenFile,
          SIGNER_PROMPT: "1",
        },
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
      throw new Error(`no ${re} in ${text.slice(-400)}`);
    };
    try {
      const port = Number((await waitFor(/signer on 127\.0\.0\.1:(\d+)/))[1]);
      const live: Live = {
        url: `http://127.0.0.1:${port}`,
        port,
        token: fs.readFileSync(tokenFile, "utf8").trim(),
      };
      const tx = {
        from: key.address,
        to: key.address,
        value: "0x1",
        nonce: "0x7",
      };
      // Approve the first prompt, typing its token twice.
      let at = text.length;
      const first = rpc(live, "eth_sendTransaction", [tx]);
      const t1 = (await waitFor(/type ([0-9a-f]{6}) to sign/, at))[1];
      p.stdin.write(`${t1}\n${t1}\n`);
      expect((await first).body.result).to.match(/^0x[0-9a-f]{64}$/);
      // The retry has the same token; the typed-ahead line must not answer
      // it. Task 5.17: asserted on the signer's state, not on 800 ms of
      // wall time. The "type <token>" line shows only after the signer
      // discarded typed-ahead input (askTty), so the answer typed once it
      // shows is the one read: the operator's refusal, while the stale
      // second copy of t1 (the same token) would have signed and sent.
      at = text.length;
      const second = rpc(live, "eth_sendTransaction", [tx]);
      const t2 = (
        await waitFor(/RETRY of #1[\s\S]*type ([0-9a-f]{6}) to sign/, at)
      )[1];
      expect(t2).to.equal(t1);
      p.stdin.write("nope\n");
      const answer = (await second).body;
      expect(answer.result, "the typed-ahead line answered the retry").to.equal(
        undefined,
      );
      expect(answer.error.message).to.match(/refused by the operator/);
      expect(up.raws.length).to.equal(1);
      // Slice A review L-4: a PARTIAL line typed ahead (no Enter) is
      // discarded too. Without that, its first three characters would
      // prefix the rest typed after the prompt and read as the token.
      p.stdin.write(t1.slice(0, 3));
      at = text.length;
      const third = rpc(live, "eth_sendTransaction", [tx]);
      const t3 = (
        await waitFor(/RETRY of #1[\s\S]*type ([0-9a-f]{6}) to sign/, at)
      )[1];
      expect(t3).to.equal(t1);
      p.stdin.write(`${t1.slice(3)}\n`);
      const reply = (await third).body;
      expect(
        reply.result,
        "a partial typed-ahead line made the token",
      ).to.equal(undefined);
      expect(reply.error.message).to.match(/refused by the operator/);
      expect(up.raws.length).to.equal(1);
      // Another transaction at a signed nonce is refused before any prompt.
      const other = await rpc(live, "eth_sendTransaction", [
        { ...tx, value: "0x2" },
      ]);
      expect(other.body.error.message).to.match(
        /nonce 7 of 0x[0-9a-fA-F]{40} was already signed for another transaction/,
      );
      const msg = await rpc(live, "personal_sign", [
        ethers.hexlify(ethers.randomBytes(32)),
        key.address,
      ]);
      expect(msg.body.error.message).to.match(
        /refused while the prompt is on \(the default off chain 31337\): sign claims through vanguard_signClaim/,
      );
      expect(up.raws.length).to.equal(1);
    } finally {
      p.kill("SIGTERM");
      up.server.close();
    }
  });

  it("vanguard_signClaim recomputes and shows the claim digest, then signs it (L-3)", async function () {
    const up = await fakeUpstream(11155111);
    const tokenFile = path.join(dir, "token-claim");
    try {
      const claim = {
        issuer: ethers.Wallet.createRandom().address,
        identity: ethers.Wallet.createRandom().address,
        topic: 6,
        scheme: 1,
        data: ethers.hexlify(ethers.toUtf8Bytes("kyc:\u202eevil")),
        uri: "",
        validTo: 99,
        chainId: 11155111,
      };
      let sig = "";
      const r = await runSigner(
        "scripts/production/signer.js",
        {
          SIGNER_UPSTREAM: up.url,
          SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
          SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
          SIGNER_TOKEN_FILE: tokenFile,
          SIGNER_PROMPT: "0", // shown, not asked (no terminal here)
        },
        async (live) => {
          sig = (await rpc(live, "vanguard_signClaim", [key.address, claim]))
            .body.result;
          const wrong = await rpc(live, "vanguard_signClaim", [
            key.address,
            { ...claim, chainId: 1 },
          ]);
          expect(wrong.body.error.message).to.match(
            /a claim for chain 1, not 11155111/,
          );
        },
      );
      const digest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          [
            "uint256",
            "address",
            "uint256",
            "address",
            "uint256",
            "uint256",
            "bytes",
            "string",
            "uint256",
          ],
          [11155111, claim.issuer, 0, claim.identity, 6, 1, claim.data, "", 99],
        ),
      );
      expect(ethers.verifyMessage(ethers.getBytes(digest), sig)).to.equal(
        key.address,
      );
      expect(r.out).to.contain(`digest (recomputed) ${digest}`);
      expect(r.out).to.contain("topic 6");
    } finally {
      up.server.close();
    }
  });
});
