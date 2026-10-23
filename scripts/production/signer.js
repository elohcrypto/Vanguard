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
 * file at start (SIGNER_TOKEN_FILE, else <tmp>/vanguard-signer-<uid>/
 * <port>.token in a 0700 directory, rpcGuard.js tokenFileFor; the CLIs
 * read the same path), the Host checked, browser requests (Origin,
 * Referer, preflight, other content types) refused, methods allowlisted.
 *
 * Every transaction and message is shown first (./signerPrompt.js: the
 * signed transaction's own fields, the call decoded only for a contract
 * whose code is a compiled artifact's, every field escaped and capped).
 * Off the dev chain it asks on the controlling terminal (/dev/tty) and
 * signs only on the exact token shown; it refuses to start without one
 * (Task 5.17: the default; SIGNER_PROMPT=0 switches it off with a loud
 * warning, =1 asks on 31337 too). A request repeating an earlier one with
 * a pinned nonce (a retry after a lost reply, demo/utils/RpcRetry.js) is
 * shown as a RETRY of it. The nonces it signed are kept beside the
 * keystores, whose directory (this user's, 0700) one signer holds at a
 * time (signerState.js), and the token file is removed on exit.
 */
"use strict";

const fs = require("fs");
const {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Transaction,
  getBytes,
  keccak256,
} = require("ethers");
const { guardedServer } = require("./rpcGuard");
const {
  clears,
  differs,
  regas,
  lowersFee,
  raisedFees,
  fieldsOf,
  promptMode,
  signedStore,
  recordFile,
  holdKeystores,
} = require("./signerState");
const { HELP, create, forgetCmd, bumpCmd } = require("./signerCommands");
const {
  PUBLISHED,
  SEPOLIA,
  guardChain,
  loadKeys,
  password,
  privateFile,
} = require("./signerKeys");
const { fetchTarget, scrub, scrubData, scrubKnown } = require("./redact");
const {
  describeClaim,
  describeMessage,
  describeTx,
  hasTty,
  askTty,
} = require("./signerPrompt");

async function serve() {
  const port = Number(process.argv[2] || 1248);
  const upstream = process.env.SIGNER_UPSTREAM;
  const dir = process.env.SIGNER_KEYSTORE_DIR;
  if (!upstream || !dir)
    throw new Error("set SIGNER_UPSTREAM and SIGNER_KEYSTORE_DIR");
  holdKeystores(dir); // review D-4: one signer per keystore directory
  const provider = new JsonRpcProvider(upstream, undefined, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  const chain = await guardChain(provider);
  // Task 5.17 (deep review L-5): asking is the default off 31337.
  const { prompt, warning } = promptMode(chain);
  if (warning) console.error(warning);
  if (prompt && !hasTty()) {
    throw new Error(
      process.env.SIGNER_PROMPT === "1"
        ? "SIGNER_PROMPT=1 needs a controlling terminal (/dev/tty) to ask on"
        : `the prompt (the default on chain ${chain}; SIGNER_PROMPT=0 switches it off) needs a controlling terminal (/dev/tty) to ask on`,
    );
  }
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
  const seen = []; // requests shown, for "RETRY of #n"
  // "addr:nonce" -> { unsigned, raw } (L-5), on disk since Task 5.17
  // (signerState.js), opened once the token file's path is known.
  let byNonce = null;
  let queue = Promise.resolve(); // one request at a time, populate included
  let signed = 0;

  const holder = (a) => {
    const w = byAddress.get(String(a).toLowerCase());
    if (!w) throw new Error(`the signer holds no key for ${a}`);
    return w;
  };
  /** `fn` after every earlier request is answered (L-5). */
  const inTurn = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };
  /**
   * Show the request (scripts/production/signerPrompt.js) and, with
   * SIGNER_PROMPT, ask for its token on /dev/tty. A request repeating an
   * earlier `key` is shown as its RETRY; a null key (a transaction with no
   * pinned nonce, review L-4) never is. Runs inside inTurn.
   */
  const approve = (key, kind, d) => {
    const k = key === null ? null : JSON.stringify(key);
    const was = k === null ? -1 : seen.indexOf(k);
    if (was < 0) seen.push(k);
    const n = was < 0 ? seen.length : was + 1;
    const head =
      was < 0
        ? `#${n} ${kind}`
        : `#${n} RETRY of #${n} (same request): ${kind}`;
    const text = [head, ...d.lines].join("\n");
    if (!prompt) return console.log(`   ${text}`);
    if (!askTty(text, d.token))
      throw new Error(`refused by the operator (#${n})`);
  };

  function sendTransaction(tx) {
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
    return inTurn(async () => {
      // What is shown is what is signed (I-1): the populated transaction,
      // populated after every earlier request was answered (L-5).
      const full = await w.populateTransaction(req);
      const d = describeTx(
        { ...full, from: w.address },
        chain,
        full.to ? await provider.getCode(full.to) : "0x",
      );
      const slot = `${w.address}:${full.nonce}`;
      const before = byNonce.get(slot);
      // Slice B review M-1: a recorded nonce takes the same transaction
      // again (re-broadcast while its fee clears, else a fee bump; signed
      // again too when the caller's gas limit or fees moved, slice C
      // review L-1), never another (signerState.js differs).
      let raw = null;
      let shown = d;
      let kind = "send";
      if (before) {
        const why = differs(before.raw, req, chain, w.address);
        if (why)
          throw new Error(
            `nonce ${full.nonce} of ${w.address} was already signed for another transaction (${why}): refused; never to be mined? run: signer.js forget ${w.address} ${full.nonce}`,
          );
        const moved = regas(before.raw, req);
        // Slice D review INFO-5: a lower fee is no bump.
        if (moved)
          kind = lowersFee(before.raw, req)
            ? `re-signed with the requested fees, nonce ${full.nonce}, same transaction (its ${moved} moved)`
            : `fee bump of nonce ${full.nonce}, same transaction (its ${moved} moved)`;
        else if (await clears(before.raw, provider)) {
          const t = fieldsOf(before.raw);
          shown = describeTx(
            t,
            chain,
            t.to ? await provider.getCode(t.to) : "0x",
          );
          raw = before.raw;
        } else kind = `fee bump of nonce ${full.nonce}, same transaction`;
      }
      approve(
        req.nonce === undefined
          ? null
          : ["tx", w.address, req.nonce, req.to, String(req.value), req.data],
        kind,
        shown,
      );
      raw ??= await w.signTransaction(full);
      if (Transaction.from(raw).unsignedHash !== shown.unsigned) {
        throw new Error("the signed transaction is not the one shown: refused");
      }
      byNonce.set(slot, { unsigned: shown.unsigned, raw });
      const sent = await provider.broadcastTransaction(raw);
      signed++;
      return sent.hash;
    });
  }
  /**
   * Slice C review L-5 (`signer.js bump`): the transaction recorded at
   * `nonce` of `address`, stuck in the mempool, signed again with higher
   * fees (signerState.js raisedFees) and sent: the same transaction.
   */
  function bump(address, nonce) {
    const w = holder(address);
    return inTurn(async () => {
      const slot = `${w.address}:${nonce}`;
      const before = byNonce.get(slot);
      if (!before)
        throw new Error(
          `no transaction recorded at nonce ${nonce} of ${w.address}: nothing to bump`,
        );
      const t = fieldsOf(before.raw);
      delete t.from;
      Object.assign(t, raisedFees(before.raw, await provider.getFeeData()));
      const shown = describeTx(
        { ...t, from: w.address },
        chain,
        t.to ? await provider.getCode(t.to) : "0x",
      );
      approve(
        ["bump", w.address, nonce],
        `fee bump of nonce ${nonce}, same transaction (signer.js bump)`,
        shown,
      );
      const raw = await w.signTransaction(t);
      byNonce.set(slot, { unsigned: Transaction.from(raw).unsignedHash, raw });
      signed++;
      return (await provider.broadcastTransaction(raw)).hash;
    });
  }
  function signMessage(address, data) {
    const w = holder(address);
    return inTurn(async () => {
      // L-3: with a prompt, only a claim whose digest this signer
      // recomputes and shows (vanguard_signClaim); never opaque bytes.
      if (prompt) {
        throw new Error(
          "personal_sign/eth_sign refused while the prompt is on (the default off chain 31337): sign claims through vanguard_signClaim",
        );
      }
      approve(
        ["msg", w.address, data],
        "sign",
        describeMessage(w.address, data),
      );
      signed++;
      return w.signMessage(getBytes(data));
    });
  }
  /**
   * vanguard_signClaim [address, { issuer, identity, topic, scheme, data,
   * uri, validTo, chainId }]: the digest ClaimIssuer.claimDigest computes,
   * recomputed here with the issuer's revocation epoch read from chain,
   * shown field by field, then signed (EIP-191) as Kyc.signClaim would.
   */
  function signClaim(address, c) {
    const w = holder(address);
    return inTurn(async () => {
      if (!c || Number(c.chainId) !== chain)
        throw new Error(
          `a claim for chain ${c && c.chainId}, not ${chain}: refused`,
        );
      const iss = new Contract(
        c.issuer,
        ["function revocationEpoch(address,uint256) view returns (uint256)"],
        provider,
      );
      const epoch = await iss.revocationEpoch(c.identity, c.topic);
      const digest = keccak256(
        AbiCoder.defaultAbiCoder().encode(
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
          [
            chain,
            c.issuer,
            epoch,
            c.identity,
            c.topic,
            c.scheme,
            c.data,
            c.uri,
            c.validTo,
          ],
        ),
      );
      approve(
        ["claim", w.address, digest],
        "sign",
        describeClaim(w.address, { ...c, epoch }, digest),
      );
      signed++;
      return w.signMessage(getBytes(digest));
    });
  }
  const OWN = {
    eth_accounts: async () => keys.map((k) => k.wallet.address),
    eth_sendTransaction: (p) => sendTransaction(p[0]),
    personal_sign: (p) => signMessage(p[1], p[0]),
    eth_sign: (p) => signMessage(p[0], p[1]),
    vanguard_signClaim: (p) => signClaim(p[0], p[1]),
    vanguard_bump: (p) => bump(p[0], Number(p[1])),
  };
  /** Any other call goes upstream as it came; a failure keeps its words. */
  async function forward(call) {
    let r;
    // Deep review L-3: fetch refuses a URL with credentials (Basic auth).
    const to = fetchTarget(upstream);
    try {
      r = await fetch(to.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...to.headers },
        body: JSON.stringify(call),
      });
    } catch (e) {
      throw new Error(`upstream: ${e.message} (${e.cause?.code ?? "no code"})`);
    }
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`upstream HTTP ${r.status}: ${text}`);
    }
  }
  async function answer(call) {
    const { id, method, params = [] } = call;
    try {
      if (!OWN[method]) {
        const out = await forward(call);
        // The upstream's error text may echo its URL's API key, in its
        // message or its data (deep review L-1).
        if (out && out.error) {
          if (out.error.message)
            out.error.message = scrub(out.error.message, upstream, 240);
          out.error.data = scrubData(out.error.data, upstream);
        }
        return out;
      }
      return { jsonrpc: "2.0", id, result: await OWN[method](params) };
    } catch (e) {
      const err = e.info?.error || e.error || {};
      // The upstream's own words (rate limit, nonce too low) reach the CLI.
      const message = scrub(
        err.message || e.shortMessage || e.message,
        upstream,
        240,
      );
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: err.code ?? -32000,
          message,
          data: scrubData(err.data, upstream),
        },
      };
    }
  }
  const { port: at, tokenFile } = await guardedServer(answer, {
    port,
    tokenFile: process.env.SIGNER_TOKEN_FILE,
  });
  // Synchronous after the await: no request is handled before it.
  byNonce = signedStore(recordFile(dir), chain);
  // Task 5.17 (deep review L-6): the token goes with the process.
  process.on("exit", () => fs.rmSync(tokenFile, { force: true }));
  // before the line: a signal sent on it still runs the exit hooks
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(`signer: ${signed} request(s) signed`);
      process.exit(0);
    });
  }
  console.log(
    `signer on 127.0.0.1:${at}: ${keys.length} key(s), chain ${chain}${prompt ? ", every request asked" : ", NOT asking"}; token in ${tokenFile}; ${byNonce.size()} signed nonce(s) remembered`,
  );
  for (const [i, k] of keys.entries())
    console.log(`   ${i} ${k.name} ${k.wallet.address}`);
}

module.exports = { privateFile, loadKeys, guardChain, PUBLISHED, SEPOLIA };

if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  const run =
    cmd === "new"
      ? create(a, process.argv.slice(4), password)
      : cmd === "forget"
        ? forgetCmd(a, b)
        : cmd === "bump"
          ? bumpCmd(a, b, c)
          : cmd === "help" || cmd === "--help"
            ? Promise.resolve(console.log(HELP))
            : serve();
  run.catch((e) => {
    console.error(`signer: ${scrubKnown(e.shortMessage || e.message)}`);
    process.exit(3);
  });
}
