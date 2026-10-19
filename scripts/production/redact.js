/**
 * RPC URLs carry provider API keys (in the userinfo, a path segment or a
 * query value), and providers echo them in error text. Everything the
 * 5.15 tools print about an RPC goes through here (plan v2 Task 5.15;
 * background reviews of rpcCheck.js): rpcCheck.js, scanCount.ts,
 * signer.js and remote-signer.js (upstream errors), RpcRetry.js (its retry
 * lines, given the URL).
 *
 *  - redactUrl: scheme://host[:port]/... only.
 *  - scrub(text, url, max): every secret form of `url` replaced by
 *    <redacted> in the FULL text, then truncated to `max` (never the other
 *    way round: a key cut at the edge would no longer match).
 *  - classify: rate-limited | range-capped | missing state | unauthorized
 *    | other; shown(text, url, max) is "[class] scrubbed".
 */
"use strict";

const { ARCHIVE_ERROR, RANGE_ERROR } = require("../../demo/utils/RpcRetry");

/** `url` safe to print: scheme://host[:port], "/..." when it had more. */
function redactUrl(url) {
  try {
    const u = new URL(String(url));
    const rest =
      u.pathname.length > 1 || u.search || u.hash || u.username ? "/..." : "";
    return `${u.protocol}//${u.host}${rest}`;
  } catch {
    return "(rpc)";
  }
}

/** x raw, percent-decoded, form-decoded, and re-encoded (both hex cases). */
const forms = (x) => {
  const out = new Set([x]);
  for (const f of [
    (y) => decodeURIComponent(y),
    (y) => decodeURIComponent(y.replace(/\+/g, " ")),
  ]) {
    try {
      out.add(f(x));
    } catch {
      // not percent-encoded text
    }
  }
  for (const y of [...out]) {
    const enc = encodeURIComponent(y);
    out.add(enc);
    out.add(enc.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()));
  }
  return [...out];
};

/**
 * Every secret form of `url`, longest first: the URL with and without its
 * credentials; username, password, the whole query, each &- or ;-separated
 * part whole and its value (names are not secrets), the fragment (3+
 * characters); the
 * whole path and each segment of 8+ characters (so "api", "eth", "v3"
 * stay); and every run of 8+ letters, digits, _ or - inside any of them
 * (a key in "ab+KEY"). Each raw, percent-decoded, form-decoded ('+' as a
 * space) and re-encoded. Matching is case-insensitive (scrub).
 */
function secretsOf(url) {
  const out = new Set([String(url)]);
  try {
    const u = new URL(String(url));
    const bare = new URL(u);
    bare.username = "";
    bare.password = "";
    out.add(bare.href);
    const q = u.search.slice(1);
    const short = [u.username, u.password, u.search, q, u.hash.slice(1)];
    for (const kv of q.split(/[&;]/)) {
      const at = kv.indexOf("=");
      short.push(kv, ...(at < 0 ? [] : [kv.slice(at + 1)]));
    }
    const long = [u.pathname, ...u.pathname.split("/")];
    const add = (x, min) => {
      for (const y of forms(x)) {
        if (y && y.length >= min) out.add(y);
        for (const run of y.match(/[A-Za-z0-9_-]{8,}/g) || []) out.add(run);
      }
    };
    for (const x of short) add(x, 3);
    for (const x of long) add(x, 8);
  } catch {
    // unparsable: the whole string only
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every secret of `url` redacted (any case), then capped. */
function scrub(text, url, max = Infinity) {
  let t = String(text);
  if (url)
    for (const x of secretsOf(url))
      t = t.replace(new RegExp(escape(x), "gi"), "<redacted>");
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** A provider error's class. */
function classify(text) {
  const t = String(text);
  if (RANGE_ERROR.test(t)) return "range-capped";
  if (
    /\b429\b|too many requests|rate.?limit|-32005|exceeded .*(capacity|quota|rate)/i.test(
      t,
    )
  )
    return "rate-limited";
  if (ARCHIVE_ERROR.test(t)) return "missing state";
  if (
    /unauthori[sz]ed|forbidden|\b40[13]\b|invalid (api )?key|invalid project|api key|auth/i.test(
      t,
    )
  )
    return "unauthorized";
  return "other";
}

/** A provider error as printed: "[class] scrubbed text", capped. */
function shown(text, url, max = 240) {
  const t = scrub(text, url);
  return `[${classify(t)}] ${t.length > max ? `${t.slice(0, max)}...` : t}`;
}

module.exports = { redactUrl, secretsOf, scrub, classify, shown };
