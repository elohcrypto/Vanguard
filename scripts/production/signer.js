#!/usr/bin/env node
/**
 * Self-hosted multi-account signer for the Sepolia rehearsal (plan v2
 * Task 5.15, owner Q16 = A; readiness review M-1): a JSON-RPC endpoint the
 * CLIs reach as `--network remote` (SIGNER_RPC_URL), Frame style. It
 * answers eth_accounts with every key it holds, in file-name order (so a
 * handover.json wallet index is a keystore's position), signs
 * eth_sendTransaction and personal_sign / eth_sign itself, and forwards
 * every other call to SIGNER_UPSTREAM. The production-grade sibling of
 * scripts/ci/remote-signer.js (test tooling).
 *
 *   SIGNER_KEYSTORE_DIR=<dir> SIGNER_PASSWORD_FILE=<file> \
 *     SIGNER_UPSTREAM=<archive RPC> node scripts/production/signer.js [port]
 *   node scripts/production/signer.js new <dir> <name>...
 *     new random keys as encrypted keystores <dir>/<name>.json (0600);
 *     prints the addresses only
 *
 * Keys: ethers encrypted JSON keystores (scrypt), one per file, all under
 * one password, read from SIGNER_PASSWORD_FILE or asked on the terminal
 * (never an argument or a variable holding it). A keystore or password
 * file that group or others can read is refused (chmod 600), so is the
 * published Hardhat phrase's keys off the test chain. Keys and passwords
 * are never printed or logged.
 *
 * Chain guard: the upstream must be Sepolia (11155111); 31337 only with
 * SIGNER_TEST=1 (the CI drives). Listens on 127.0.0.1 only (default port
 * 1248, Frame's), behind ./rpcGuard.js: a bearer token written to a 0600
 * file at start (SIGNER_TOKEN_FILE, else /tmp/vanguard-signer-<port>.token;
 * the CLIs read the same path), the Host checked, browser requests (Origin,
 * Referer, preflight, other content types) refused, methods allowlisted.
 *
 * SIGNER_PROMPT=1: every transaction and message is shown on the
 * terminal (from, to, value, nonce, the call's selector, chain) and sent
 * only on "y". It refuses to start unless stdin and stdout are a
 * terminal. A request repeating an earlier one (same sender, nonce, call:
 * a retry after a lost reply, demo/utils/RpcRetry.js) is shown as a
 * RETRY of it, never as a new transaction.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  Wallet,
  getBytes,
} = require("ethers");
const { guardedServer } = require("./rpcGuard");

const SEPOLIA = 11155111;
const HARDHAT_PHRASE =
  "test test test test test test test test test test test junk";
const PUBLISHED = new Set(
  Array.from({ length: 20 }, (_, i) =>
    HDNodeWallet.fromPhrase(
      HARDHAT_PHRASE,
      undefined,
      `m/44'/60'/0'/0/${i}`,
    ).address.toLowerCase(),
  ),
);

/** Refuse a file group or others may read (the owner's key material). */
function privateFile(f) {
  const mode = fs.statSync(f).mode;
  if (mode & 0o077) {
    throw new Error(
      `${f} is readable by group or others (mode ${(mode & 0o777).toString(8)}): chmod 600 ${f}`,
    );
  }
}

/** The password: SIGNER_PASSWORD_FILE (0600), else asked without echo. */
async function password(question = "keystore password: ") {
  const f = process.env.SIGNER_PASSWORD_FILE;
  if (f) {
    privateFile(f);
    return fs.readFileSync(f, "utf8").replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY) {
    throw new Error("set SIGNER_PASSWORD_FILE or run on a terminal");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl._writeToOutput = (s) => {
    if (s.startsWith(question)) rl.output.write(question);
  };
  const p = await new Promise((ok) => rl.question(question, ok));
  rl.close();
  process.stdout.write("\n");
  return p;
}

/** Every keystore in `dir`, decrypted, in file-name order. */
async function loadKeys(dir, pass) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`${dir}: no keystore (*.json)`);
  const out = [];
  for (const f of files) {
    const file = path.join(dir, f);
    privateFile(file);
    const w = await Wallet.fromEncryptedJson(
      fs.readFileSync(file, "utf8"),
      pass,
    ).catch(() => {
      throw new Error(`${file}: wrong password or not a keystore`);
    });
    out.push({ name: f.replace(/\.json$/, ""), wallet: w });
  }
  return out;
}

/** `new <dir> <name>...`: fresh keys, encrypted, 0600, addresses printed. */
async function create(dir, names) {
  if (!dir || !names.length)
    throw new Error("usage: signer.js new <dir> <name>...");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pass = await password("password for the new keystores: ");
  if (pass.length < 12)
    throw new Error("use a password of 12 or more characters");
  for (const name of names) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) throw new Error(`${file} exists; not overwritten`);
    const w = Wallet.createRandom();
    fs.writeFileSync(file, await w.encrypt(pass), { mode: 0o600, flag: "wx" });
    console.log(`${name} ${w.address}`);
  }
}

let calls = null;

/**
 * What `data` calls, decoded by the compiled ABIs (SIGNER_ABI_DIR, default
 * artifacts/contracts) when one matches its selector: "call name(args)";
 * else the selector and size (review L-4).
 */
function describeCall(to, data) {
  if (!to) return `create (${(data.length - 2) / 2} bytes)`;
  if (calls === null) {
    calls = new Map();
    const walk = (d) => {
      for (const e of fs.existsSync(d)
        ? fs.readdirSync(d, { withFileTypes: true })
        : []) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith(".json") && !f.endsWith(".dbg.json")) {
          try {
            const i = new Interface(
              JSON.parse(fs.readFileSync(f, "utf8")).abi || [],
            );
            i.forEachFunction((fn) => calls.set(fn.selector, i));
          } catch {
            // not an artifact
          }
        }
      }
    };
    walk(process.env.SIGNER_ABI_DIR || "artifacts/contracts");
  }
  const i = calls.get(data.slice(0, 10));
  const t = i && i.parseTransaction({ data });
  if (!t) return `call ${data.slice(0, 10)} (${(data.length - 2) / 2} bytes)`;
  const args = t.args.map((a) => String(a)).join(", ");
  return `call ${t.name}(${args.length > 300 ? `${args.slice(0, 300)}...` : args})`;
}

/** The upstream's chain id: Sepolia, or 31337 with SIGNER_TEST=1. */
async function guardChain(provider) {
  const chain = Number((await provider.send("eth_chainId", [])).toString());
  const test = process.env.SIGNER_TEST === "1" && chain === 31337;
  if (chain !== SEPOLIA && !test) {
    throw new Error(
      `upstream is chain ${chain}: this signer serves Sepolia (${SEPOLIA}) only${chain === 31337 ? " (31337 with SIGNER_TEST=1)" : ""}`,
    );
  }
  return chain;
}

/** A terminal question answered y/N (SIGNER_PROMPT=1). */
function confirm(rl, text) {
  return new Promise((ok) =>
    rl.question(`${text}\n   approve? [y/N] `, (a) =>
      ok(/^y(es)?$/i.test(a.trim())),
    ),
  );
}

async function serve() {
  const port = Number(process.argv[2] || 1248);
  const upstream = process.env.SIGNER_UPSTREAM;
  const dir = process.env.SIGNER_KEYSTORE_DIR;
  if (!upstream || !dir)
    throw new Error("set SIGNER_UPSTREAM and SIGNER_KEYSTORE_DIR");
  const prompt = process.env.SIGNER_PROMPT === "1";
  if (prompt && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(
      "SIGNER_PROMPT=1 needs this process on a terminal (stdin and stdout)",
    );
  }
  const provider = new JsonRpcProvider(upstream, undefined, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  const chain = await guardChain(provider);
  const keys = await loadKeys(dir, await password());
  if (chain !== 31337) {
    const bad = keys.filter((k) =>
      PUBLISHED.has(k.wallet.address.toLowerCase()),
    );
    if (bad.length) {
      throw new Error(
        `keystore(s) ${bad.map((k) => k.name).join(", ")} hold a published Hardhat test key: refused off the test chain`,
      );
    }
  }
  const byAddress = new Map(
    keys.map((k) => [
      k.wallet.address.toLowerCase(),
      k.wallet.connect(provider),
    ]),
  );
  const rl = prompt
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const seen = []; // requests shown, for "RETRY of #n"
  let queue = Promise.resolve(); // one prompt at a time
  let signed = 0;

  const holder = (a) => {
    const w = byAddress.get(String(a).toLowerCase());
    if (!w) throw new Error(`the signer holds no key for ${a}`);
    return w;
  };
  /**
   * Show the request and, with SIGNER_PROMPT, ask. A request repeating an
   * earlier `key` is shown as its RETRY; a null key (a transaction with no
   * pinned nonce, review L-4) never is.
   */
  const approve = (key, text) => {
    const k = key === null ? null : JSON.stringify(key);
    const was = k === null ? -1 : seen.indexOf(k);
    if (was < 0) seen.push(k);
    const n = was < 0 ? seen.length : was + 1;
    const line =
      was < 0
        ? `#${n} ${text}`
        : `#${n} RETRY of #${n} (same request): ${text}`;
    if (!rl) return (console.log(`   ${line}`), Promise.resolve());
    const p = queue.then(() => confirm(rl, line));
    queue = p.catch(() => undefined);
    return p.then((ok) => {
      if (!ok)
        throw new Error(`refused by the operator (${line.split(":")[0]})`);
    });
  };

  async function sendTransaction(tx) {
    const w = holder(tx.from);
    const req = {
      to: tx.to || null,
      data: tx.data || tx.input || "0x",
      value: tx.value || 0,
    };
    for (const [from, to] of [
      ["gas", "gasLimit"],
      ["maxFeePerGas", "maxFeePerGas"],
      ["maxPriorityFeePerGas", "maxPriorityFeePerGas"],
      ["gasPrice", "gasPrice"],
    ]) {
      if (tx[from]) req[to] = tx[from];
    }
    if (tx.nonce !== undefined) req.nonce = Number(tx.nonce);
    await approve(
      req.nonce === undefined
        ? null
        : ["tx", w.address, req.nonce, req.to, String(req.value), req.data],
      `send from ${w.address} to ${req.to ?? "(create)"} value ${BigInt(req.value)} nonce ${req.nonce ?? "next"} ${describeCall(req.to, req.data)} on chain ${chain}`,
    );
    const sent = await w.sendTransaction(req);
    signed++;
    return sent.hash;
  }
  async function signMessage(address, data) {
    const w = holder(address);
    await approve(
      ["msg", w.address, data],
      `sign a ${(data.length - 2) / 2}-byte message (a claim digest) as ${w.address}`,
    );
    signed++;
    return w.signMessage(getBytes(data));
  }
  const OWN = {
    eth_accounts: async () => keys.map((k) => k.wallet.address),
    eth_sendTransaction: (p) => sendTransaction(p[0]),
    personal_sign: (p) => signMessage(p[1], p[0]),
    eth_sign: (p) => signMessage(p[0], p[1]),
  };
  /** Any other call goes upstream as it came; a failure keeps its words. */
  async function forward(call) {
    let r;
    try {
      r = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call),
      });
    } catch (e) {
      throw new Error(`upstream: ${e.message} (${e.cause?.code ?? "no code"})`);
    }
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`upstream HTTP ${r.status}: ${text.slice(0, 120)}`);
    }
  }
  async function answer(call) {
    const { id, method, params = [] } = call;
    try {
      if (!OWN[method]) return await forward(call);
      return { jsonrpc: "2.0", id, result: await OWN[method](params) };
    } catch (e) {
      const err = e.info?.error || e.error || {};
      // The upstream's own words (rate limit, nonce too low) reach the CLI.
      const message = err.message || e.shortMessage || e.message;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: err.code ?? -32000, message, data: err.data },
      };
    }
  }
  const { port: at, tokenFile } = await guardedServer(answer, {
    port,
    tokenFile: process.env.SIGNER_TOKEN_FILE,
  });
  console.log(
    `signer on 127.0.0.1:${at}: ${keys.length} key(s), chain ${chain}${prompt ? ", every request asked" : ""}; token in ${tokenFile}`,
  );
  for (const [i, k] of keys.entries())
    console.log(`   ${i} ${k.name} ${k.wallet.address}`);
  process.on("SIGTERM", () => {
    console.log(`signer: ${signed} request(s) signed`);
    process.exit(0);
  });
}

module.exports = { privateFile, loadKeys, guardChain, PUBLISHED, SEPOLIA };

if (require.main === module) {
  const run =
    process.argv[2] === "new"
      ? create(process.argv[3], process.argv.slice(4))
      : serve();
  run.catch((e) => {
    console.error(`signer: ${e.message}`);
    process.exit(3);
  });
}
