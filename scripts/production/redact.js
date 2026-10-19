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

const decodings = (x) => {
  const out = [x];
  for (const f of [
    (y) => decodeURIComponent(y),
    (y) => decodeURIComponent(y.replace(/\+/g, " ")),
  ]) {
    try {
      out.push(f(x));
    } catch {
      // not percent-encoded text
    }
  }
  return out;
};

/**
 * Every secret form of `url`, longest first: the URL with and without its
 * credentials, username, password, the whole path and each segment, the
 * whole query, each &- or ;-separated part whole and as name and value,
 * the fragment; each raw, percent-decoded and form-decoded ('+' as a
 * space). Tokens under 3 characters ("v3", "1") are not secrets and stay.
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
    const parts = [
      u.username,
      u.password,
      u.pathname,
      u.search,
      q,
      u.hash.slice(1),
    ];
    parts.push(...u.pathname.split("/"));
    for (const kv of q.split(/[&;]/)) {
      const at = kv.indexOf("=");
      parts.push(kv, ...(at < 0 ? [] : [kv.slice(0, at), kv.slice(at + 1)]));
    }
    for (const x of parts)
      for (const y of decodings(x)) if (y && y.length >= 3) out.add(y);
  } catch {
    // unparsable: the whole string only
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** `text` with every secret of `url` redacted, then capped at `max`. */
function scrub(text, url, max = Infinity) {
  let t = String(text);
  if (url) for (const x of secretsOf(url)) t = t.split(x).join("<redacted>");
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
