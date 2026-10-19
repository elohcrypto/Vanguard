#!/usr/bin/env node
/**
 * rpc-check (plan v2 Task 5.15, owner Q18 = B: one commercial provider
 * plus the owner's own Sepolia node, both checked before the deploy):
 * what the ceremony needs from an RPC, measured, for one or more URLs.
 *
 *   RPC_CHECK_URLS=<url>,<url> (or RPC_CHECK_URLS_FILE=<0600 file>) \
 *     node scripts/production/rpcCheck.js --chain 11155111
 *     [--address 0x..] [--old-block N]
 * A URL on the command line is refused (shell history, ps).
 *
 * Per URL:
 *  - chain id (refused if not --chain, which is required: Task 5.17, deep
 *    review L-7; a check that passes any chain proves nothing);
 *  - archive: eth_getBalance at --old-block (default latest - 200,000,
 *    beyond any full node's ~128 recent blocks) — every ceremony phase
 *    reads state from fromBlock on;
 *  - eth_getLogs range: the largest of 1k / 5k / 10k / 50k / 100k blocks
 *    an address-filtered scan accepts (--address, default the zero
 *    address), with the refusal's wording and whether scanLogs reads it
 *    as a range error (demo/utils/RpcRetry.js RANGE_ERROR: halves) or
 *    would stop on it;
 *  - result cap: an address-less scan of the last min(range, 10k) blocks
 *    (the R-514-5 best-effort scan): its hit count, or the cap's wording;
 *  - rate: 40 eth_blockNumber calls at once: answered, refused (429 or a
 *    rate-limit error: RpcRetry retries those), wall time;
 *  - live gas: eth_gasPrice, eth_maxPriorityFeePerGas, the base fee.
 * Exits 1 when a URL fails the chain or archive check, or no getLogs range
 * works; the rest is information for the runbook's logChunk and budget.
 * URLs are printed as scheme://host/... only and every provider error is
 * classified and scrubbed of every key form before it is cut (./redact.js):
 * provider keys live in the URL.
 */
"use strict";

const { RANGE_ERROR, isTransient } = require("../../demo/utils/RpcRetry");

const {
  classify,
  fetchTarget,
  redactUrl,
  scrub,
  secretsOf,
  shown,
  scrubKnown,
  urlsFrom,
} = require("./redact");

let nextId = 1;
/** One JSON-RPC call to `url`: { result } or { error: text, status }. */
async function call(url, method, params = []) {
  try {
    // fetch refuses a URL with credentials: Basic auth (./redact.js).
    const to = fetchTarget(url);
    const r = await fetch(to.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...to.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        error: shown(`HTTP ${r.status}: ${text}`, url, 160),
        status: r.status,
      };
    }
    if (body.error) {
      return {
        error: shown(
          `${body.error.code ?? ""} ${body.error.message ?? ""}`.trim(),
          url,
        ),
        status: r.status,
      };
    }
    return { result: body.result, status: r.status };
  } catch (e) {
    return {
      error: shown(`${e.message} (${e.cause?.code ?? "no code"})`, url),
      status: 0,
    };
  }
}

const hex = (n) => `0x${Number(n).toString(16)}`;
const gwei = (w) => `${(Number(BigInt(w)) / 1e9).toFixed(3)} gwei`;

/** Every check for `url`; { lines, ok }. */
async function checkUrl(url, opts = {}) {
  const lines = [`RPC ${redactUrl(url)}`];
  let ok = true;
  const say = (pass, text) => {
    lines.push(`   ${pass === null ? "ℹ️ " : pass ? "✅" : "❌"} ${text}`);
    if (pass === false) ok = false;
  };
  const chain = await call(url, "eth_chainId");
  if (chain.error) {
    say(false, `eth_chainId: ${chain.error}`);
    return { lines, ok };
  }
  const id = Number(chain.result);
  say(
    opts.chain === undefined || id === Number(opts.chain),
    `chain id ${id}${opts.chain !== undefined ? ` (want ${opts.chain})` : ""}`,
  );
  const head = Number((await call(url, "eth_blockNumber")).result);
  const old = opts.oldBlock ?? Math.max(0, head - 200_000);
  const bal = await call(url, "eth_getBalance", [
    "0x0000000000000000000000000000000000000000",
    hex(old),
  ]);
  say(
    !bal.error,
    bal.error
      ? `archive: state at block ${old} refused: ${bal.error}`
      : `archive: state at block ${old} served (head ${head})`,
  );
  const address = opts.address || "0x0000000000000000000000000000000000000000";
  let best = 0;
  for (const span of [1_000, 5_000, 10_000, 50_000, 100_000]) {
    const from = Math.max(0, head - span + 1);
    const r = await call(url, "eth_getLogs", [
      { address, fromBlock: hex(from), toBlock: hex(head) },
    ]);
    if (r.error) {
      const halves = RANGE_ERROR.test(r.error);
      say(
        null,
        `getLogs ${span} blocks refused: ${r.error.slice(0, 140)} (${halves ? "a range error: scanLogs halves" : isTransient({ message: r.error }) ? "transient: retried" : "NOT a recognised range error: a scan would stop"})`,
      );
      break;
    }
    best = span;
  }
  say(
    best > 0,
    best
      ? `getLogs: up to ${best} blocks per call accepted (logChunk <= ${best})`
      : "getLogs: no range accepted",
  );
  // The best-effort scan has no address: a provider may cap its results.
  const span = Math.min(best || 1_000, 10_000);
  const all = await call(url, "eth_getLogs", [
    { fromBlock: hex(Math.max(0, head - span + 1)), toBlock: hex(head) },
  ]);
  say(
    null,
    all.error
      ? `address-less scan of ${span} blocks refused: ${all.error.slice(0, 140)} (${RANGE_ERROR.test(all.error) ? "range/cap error: halved, then capped" : "would stop"})`
      : `address-less scan of ${span} blocks: ${all.result.length} logs`,
  );
  const t0 = Date.now();
  const burst = await Promise.all(
    Array.from({ length: 40 }, () => call(url, "eth_blockNumber")),
  );
  const refused = burst.filter((r) => r.error);
  const rate = refused.filter(
    (r) => r.status === 429 || isTransient({ message: r.error }),
  );
  say(
    null,
    `rate: 40 calls at once in ${Date.now() - t0} ms: ${40 - refused.length} answered, ${refused.length} refused (${rate.length} rate-limit or transient, retried by RpcRetry)`,
  );
  const gp = await call(url, "eth_gasPrice");
  const tip = await call(url, "eth_maxPriorityFeePerGas");
  const blk = await call(url, "eth_getBlockByNumber", ["latest", false]);
  say(
    null,
    `gas: gasPrice ${gp.error ? gp.error : gwei(gp.result)}, priority fee ${tip.error ? tip.error : gwei(tip.result)}, base fee ${blk.result?.baseFeePerGas ? gwei(blk.result.baseFeePerGas) : "none"}`,
  );
  return { lines, ok };
}

async function main(argv) {
  const urls = urlsFrom("RPC_CHECK_URLS", argv);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") opts.chain = Number(argv[++i]);
    else if (a === "--address") opts.address = argv[++i];
    else if (a === "--old-block") opts.oldBlock = Number(argv[++i]);
    else throw new Error(`unknown argument "${redactUrl(a)}"`);
  }
  if (!urls.length || !Number.isSafeInteger(opts.chain) || opts.chain <= 0) {
    console.error(
      "usage: RPC_CHECK_URLS=<url>,<url> (or RPC_CHECK_URLS_FILE, 0600) rpcCheck.js --chain <id> [--address 0x..] [--old-block N] (--chain is required)",
    );
    return 1;
  }
  let ok = true;
  for (const u of urls) {
    const r = await checkUrl(u, opts);
    console.log(r.lines.join("\n"));
    ok = ok && r.ok;
  }
  console.log(
    ok ? "✅ rpc-check passed" : "❌ rpc-check failed (see ❌ above)",
  );
  return ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (c) => (process.exitCode = c),
    (e) => {
      console.error(`rpc-check: ${scrubKnown(e.message)}`);
      process.exitCode = 1;
    },
  );
}
module.exports = { checkUrl, call, redactUrl, scrub, classify, secretsOf };
