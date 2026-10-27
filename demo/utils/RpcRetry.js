/**
 * @fileoverview Bounded retry for a long run against a public RPC (plan v2
 * Task 5.15, readiness review M-3). One rate-limit answer or dropped
 * connection used to abort a ceremony phase that runs for days.
 *
 * `installRetry(provider)` hooks a Hardhat provider's request and send (as
 * deployRecord.ts and PostCeremony.guardDeployerKey do) and sits BELOW any
 * hook installed after it (the deploy record keeps its own intent and
 * adoption rules on top). Reads are retried with exponential backoff on a
 * transient error only: a rate limit (HTTP 429 once Hardhat's own retries
 * are spent, -32005 or a rate-limit wording), a dropped or timed-out
 * connection, a 502/503/504. Never retried: a revert, a block-range or
 * result-cap refusal (scanLogs halves the range on those: RANGE_ERROR), a
 * missing-state (archive) refusal, anything else.
 *
 * eth_sendTransaction is never sent twice. Its nonce is pinned (the
 * sender's pending count) before the first attempt, so a retry can only
 * replace or repeat the same nonce. After a transient error the outcome is
 * unknown: if the nonce is used by then, or the retry is answered "nonce
 * too low" / "already known", the transaction mined at that nonce is
 * adopted only when it is this one in every field (from, nonce, to, value,
 * data); any other transaction there is a refusal, and nothing is resent.
 */

"use strict";

/** Block-range and result-cap refusals (scanLogs halves the range). */
const RANGE_ERROR =
  /block range|range too large|exceeds.*(range|limit)|too many (blocks|results)|query returned more than|response size (is )?(exceeded|too large)|log response size|limited to a \d+ block range|up to a \d+k? block range/i;
/** The node cannot serve historical state (an archive is needed). */
const ARCHIVE_ERROR =
  /missing trie node|header not found|state (is )?not available|historical state|state histor|pruned|required archive|archive node|unknown block|block not found/i;
const TRANSIENT =
  /ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|socket hang up|other side closed|UND_ERR|fetch failed|network timeout|NETWORK_TIMEOUT|HH108|timed? ?out|too many requests|rate.?limit|request limit|limit exceeded|exceeded .*(capacity|quota|rate)|-32005|(status|http|code)( code)?:? ?(429|50[234])\b|bad gateway|service unavailable|gateway timeout/i;
/** Hardhat's HttpProvider error number for a refused connection. */
const REFUSED = require("hardhat/internal/core/errors-list").ERRORS.NETWORK
  .NODE_IS_NOT_RUNNING.number;
/** A repeated nonce: the first attempt may have been accepted. */
const NONCE_USED =
  /nonce too low|already known|known transaction|nonce has already been used|replacement transaction underpriced|NONCE_EXPIRED|transaction already imported/i;

/** Every message and code an error carries, nested causes included. */
function textOf(e, depth = 0) {
  if (!e || depth > 4) return "";
  const parts = [e.code, e.message, e.shortMessage, e.reason];
  if (e.data && typeof e.data === "object") parts.push(e.data.message);
  for (const k of ["cause", "error", "parent"]) {
    if (e[k] && typeof e[k] === "object") parts.push(textOf(e[k], depth + 1));
  }
  if (e.info?.error) parts.push(textOf(e.info.error, depth + 1));
  return parts.filter((x) => x !== undefined && x !== null).join(" | ");
}

/** True when `e` is worth a retry (see the file header). */
function isTransient(e) {
  const t = textOf(e);
  if (/revert/i.test(t) || RANGE_ERROR.test(t) || ARCHIVE_ERROR.test(t)) {
    return false;
  }
  return TRANSIENT.test(t);
}

const same = (a, b) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const big = (x) => BigInt(x ?? 0);
const hexData = (tx) => String(tx.data ?? tx.input ?? "0x").toLowerCase();

/** The URL of the network hardhat runs on, if any (never printed). */
function hardhatUrl() {
  try {
    return require("hardhat").network.config.url;
  } catch {
    return undefined;
  }
}

/**
 * Hook `provider` (request and send). Options: url (scrubbed from log
 * lines; default the hardhat network's), retries (6), baseMs (500),
 * maxMs (30000), waitMs (600000: how long a sent nonce may take to mine
 * before an adoption gives up), log, sleep. Returns the uninstaller.
 */
function installRetry(provider, opts = {}) {
  const retries = opts.retries ?? 6;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 30000;
  const waitMs = opts.waitMs ?? 600000;
  // Retry lines carry provider error text, which may echo the RPC URL's
  // API key: scrubbed of every form of the URL (scripts/production/
  // redact.js), the connected network's own by default.
  const url = opts.url ?? hardhatUrl();
  // Task 5.17 (deep review L-1): every RPC URL this process knows, not
  // only its own (a signer's upstream may echo in e.data.message).
  const { scrubKnown } = require("../../scripts/production/redact");
  const print = opts.log ?? console.log;
  const log = (m) => print(scrubKnown(m, url ? [url] : []));
  const sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const p = provider;
  const request = p.request.bind(p);
  const send = typeof p.send === "function" ? p.send.bind(p) : null;
  const raw = (method, params = []) => request({ method, params });
  let retried = 0;

  async function withRetry(what, fn) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!isTransient(e) || i >= retries) throw e;
        const ms = Math.min(maxMs, baseMs * 2 ** i);
        retried++;
        log(
          `   ↻ ${what}: ${textOf(e).split("\n")[0].slice(0, 120)}; retry ${i + 1}/${retries} in ${ms} ms`,
        );
        await sleep(ms);
      }
    }
  }
  const read = (method, params) => withRetry(method, () => raw(method, params));

  /** The transaction mined from `from` at `nonce` since block `start`. */
  async function adopt(tx, nonce, start) {
    const from = tx.from;
    const t0 = Date.now();
    while (
      Number(await read("eth_getTransactionCount", [from, "latest"])) <= nonce
    ) {
      if (Date.now() - t0 > waitMs) {
        throw new Error(
          `${from} nonce ${nonce}: the send's outcome is unknown and nothing mined at that nonce within ${waitMs / 1000} s; not resent: check the chain, then re-run`,
        );
      }
      await sleep(Math.min(maxMs, 2000));
    }
    const head = Number(await read("eth_blockNumber", []));
    for (let b = start; b <= head; b++) {
      const blk = await read("eth_getBlockByNumber", [
        `0x${b.toString(16)}`,
        true,
      ]);
      for (const t of blk?.transactions ?? []) {
        if (!same(t.from, from) || Number(t.nonce) !== nonce) continue;
        const ours =
          same(t.to, tx.to ?? null) &&
          big(t.value) === big(tx.value) &&
          String(t.input).toLowerCase() === hexData(tx);
        if (!ours) {
          throw new Error(
            `${from} nonce ${nonce} went to another transaction (${t.hash}) after an unknown send outcome: refusing, nothing resent`,
          );
        }
        log(
          `   ↪️  nonce ${nonce} of ${from}: mined as ${t.hash}; adopted (not resent)`,
        );
        return t.hash;
      }
    }
    throw new Error(
      `${from} nonce ${nonce} is used but no transaction at it was found since block ${start}: refusing, nothing resent`,
    );
  }

  async function sendTx(params) {
    const tx = { ...params[0] };
    if (tx.nonce === undefined) {
      tx.nonce = await read("eth_getTransactionCount", [tx.from, "pending"]);
    }
    const nonce = Number(tx.nonce);
    // Review L-2: a pending count behind the mined one (a lagging node
    // behind a load balancer) would let an unknown outcome adopt an
    // earlier identical transaction; such a nonce is refused unsent.
    const mined = Number(
      await read("eth_getTransactionCount", [tx.from, "latest"]),
    );
    if (mined > nonce) {
      throw new Error(
        `${tx.from} nonce ${nonce} is already mined (${mined} mined): the RPC's pending count is stale; not sent`,
      );
    }
    const start = Number(await read("eth_blockNumber", []));
    let unsure = false;
    try {
      return await attempts();
    } catch (e) {
      // U2 round 12 (R12-C6): after an unknown outcome the send may be
      // out, so what leaves here never reads as a refusal (a numeric code
      // or Hardhat's refused-connection number): same message, the cause
      // kept.
      if (!unsure) throw e;
      throw Object.assign(new Error(e?.message ?? String(e)), { cause: e });
    }
    async function attempts() {
      for (let i = 0; ; i++) {
        try {
          return await raw("eth_sendTransaction", [tx, ...params.slice(1)]);
        } catch (e) {
          const t = textOf(e);
          if (unsure && NONCE_USED.test(t)) return adopt(tx, nonce, start);
          if (!isTransient(e) || i >= retries) throw e;
          // A refused connection reached nothing: no unknown outcome.
          if (e?.number !== REFUSED) unsure = true;
          retried++;
          const ms = Math.min(maxMs, baseMs * 2 ** i);
          log(
            `   ↻ eth_sendTransaction nonce ${nonce}: ${t.split("\n")[0].slice(0, 120)}; outcome unknown, retry ${i + 1}/${retries} in ${ms} ms (same nonce)`,
          );
          await sleep(ms);
          const used =
            Number(await read("eth_getTransactionCount", [tx.from, "latest"])) >
            nonce;
          if (used) return adopt(tx, nonce, start);
        }
      }
    }
  }

  const handle = (method, params = []) =>
    method === "eth_sendTransaction" ? sendTx(params) : read(method, params);
  p.request = (a) => handle(a.method, a.params ?? []);
  if (send) p.send = (m, a) => handle(m, a ?? []);
  const uninstall = () => {
    p.request = request;
    if (send) p.send = send;
  };
  uninstall.retried = () => retried;
  return uninstall;
}

module.exports = {
  installRetry,
  isTransient,
  textOf,
  RANGE_ERROR,
  ARCHIVE_ERROR,
};
