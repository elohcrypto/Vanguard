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
 *  - fetchTarget: a URL with credentials as fetch() sends it (Basic auth).
 *  - scrubData: a JSON-RPC error's data scrubbed as scrub does text.
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
 * characters); the whole path and each segment of PATH_MIN+ characters;
 * and every run of 8+ letters, digits, _ or - inside any of them (a key in
 * "ab+KEY"). Each raw, percent-decoded, form-decoded ('+' as a space) and
 * re-encoded. Task 5.17 (deep review L-2): also the Basic credential
 * fetchTarget sends (base64 of user:password) and every secret of
 * PATH_MIN+ characters hex- and base64-encoded (an upstream may echo a request in
 * error.data as hex or base64). Matching is case-insensitive (scrub).
 *
 * PATH_MIN = 6 (was 8): a provider key as short as 6 characters in a path
 * segment is redacted; route words of 6+ letters ("sepolia", "mainnet")
 * are too, an over-redaction on the safe side, while "api", "eth", "v3",
 * "rpc" stay readable. A path key under 6 characters is not protected:
 * at most 64^5 (about 10^9) values, it guards nothing a reader of the
 * error text could not guess.
 */
const PATH_MIN = 6;
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
    for (const x of long) add(x, PATH_MIN);
    if (u.username || u.password) {
      const basic = fetchTarget(u.href).headers.authorization.slice(6);
      out.add(basic);
      out.add(basic.replace(/=+$/, ""));
    }
  } catch {
    // unparsable: the whole string only
  }
  for (const x of [...out].filter((y) => y.length >= PATH_MIN)) {
    const b = Buffer.from(x);
    out.add(b.toString("hex"));
    out.add(b.toString("base64").replace(/=+$/, ""));
    out.add(b.toString("base64url"));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * `url` as fetch() can send it: node's fetch refuses a URL carrying
 * credentials (ethers accepts them), so the userinfo moves to a Basic
 * Authorization header. { url, headers } (deep review L-3: every place a
 * tool fetches an RPC URL itself goes through this).
 */
function fetchTarget(url) {
  const u = new URL(String(url));
  const headers = {};
  if (u.username || u.password) {
    const who = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    headers.authorization = `Basic ${Buffer.from(who).toString("base64")}`;
    u.username = "";
    u.password = "";
  }
  return { url: u.href, headers };
}

/**
 * `data` (a JSON-RPC error's data: a string, an object or anything) with
 * every secret of `url` scrubbed, kept in its shape (deep review L-1:
 * the signers forwarded it unscrubbed).
 */
function scrubData(data, url) {
  if (data === undefined || data === null) return data;
  if (typeof data === "string") return scrub(data, url);
  try {
    return JSON.parse(scrub(JSON.stringify(data), url));
  } catch {
    return scrub(JSON.stringify(data), url);
  }
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

/** RPC URLs this process may know: hardhat's network and the tools' env. */
function knownUrls(extra = []) {
  const env = process.env;
  const urls = [...extra];
  for (const k of ["SIGNER_UPSTREAM", "SEPOLIA_RPC_URL", "MAINNET_RPC_URL"])
    if (env[k]) urls.push(env[k]);
  for (const k of ["SCAN_RPC_URLS", "RPC_CHECK_URLS", "COST_RPC_URL"]) {
    try {
      urls.push(...urlsFrom(k));
    } catch {
      // an unreadable file: its own error says so
    }
  }
  try {
    urls.push(require("hardhat").network.config.url);
  } catch {
    // not under hardhat
  }
  return urls.filter((u) => typeof u === "string" && /^[a-z]+:\/\//i.test(u));
}

/**
 * `text` scrubbed of every known RPC URL (final review L-3): every CLI's
 * top-level error print goes through this.
 */
function scrubKnown(text, extra = []) {
  let t = String(text);
  for (const u of knownUrls(extra)) t = scrub(t, u);
  return t;
}

/**
 * RPC URLs for a tool from `name` (comma-separated) or `${name}_FILE` (a
 * file this user owns, mode 0600, one per line or comma-separated), never
 * the command line (final review L-4: argv lands in shell history and
 * ps). Throws when `argv` carries a URL.
 */
function urlsFrom(name, argv = []) {
  const fs = require("fs");
  if (argv.some((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(a)))) {
    throw new Error(
      `an RPC URL on the command line is refused (shell history, ps): set ${name} or ${name}_FILE (0600)`,
    );
  }
  let text = process.env[name] || "";
  const file = process.env[`${name}_FILE`];
  if (file) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077)
      throw new Error(`${name}_FILE must be this user's own file, mode 0600`);
    text = fs.readFileSync(file, "utf8");
  }
  return text.split(/[\s,]+/).filter(Boolean);
}

module.exports = {
  fetchTarget,
  scrubData,
  urlsFrom,
  redactUrl,
  secretsOf,
  scrub,
  scrubKnown,
  classify,
  shown,
};
