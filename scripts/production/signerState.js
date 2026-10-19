/**
 * Task 5.17 slice B (deep review L-5): two of scripts/production/signer.js's
 * decisions, kept here so signer.js stays under the line limit.
 *
 *  - promptMode: the prompt is the default off the dev chain. SIGNER_PROMPT
 *    unset asks on every request unless the upstream is 31337; "1" always
 *    asks; "0" never does, and off 31337 says so loudly at start (an
 *    operator who switches the prompt off on Sepolia should see it).
 *  - signedStore: the per-nonce "already signed" record (signer.js L-5:
 *    one nonce signed for one transaction only) kept on disk next to the
 *    token file (<token file>.signed.json, this user's own, 0600, written
 *    atomically), so a restarted signer still refuses another transaction
 *    at a nonce it signed before. It holds raw signed transactions only
 *    (public once sent), keyed by chain, signer address and nonce.
 *  - differs / clears (slice B review M-1): a request at a recorded nonce
 *    is the SAME transaction when every field the caller controls (chain,
 *    from, to, value, data, and the gas limit and fees it set itself)
 *    matches the recorded one: a retry after a lost or failed broadcast,
 *    or a fee bump. The signer re-broadcasts the recorded transaction
 *    while its fee still clears the base fee, else signs it again with
 *    fresh fees; only a different transaction is refused. Before this a
 *    broadcast that failed once (a 429) locked the nonce for good: the
 *    retry was populated with fresh fees, its hash differed, and every
 *    later request and restart was refused.
 *  - forget (`signer.js forget <address> <nonce>`): drops a stuck entry
 *    from the record, logged; the operator's way out.
 */
"use strict";

const fs = require("fs");

const DEV_CHAIN = 31337;

/** { prompt, warning } for `chain` and SIGNER_PROMPT (`value`). */
function promptMode(chain, value = process.env.SIGNER_PROMPT) {
  if (value === "") value = undefined;
  if (value !== undefined && value !== "0" && value !== "1") {
    throw new Error(`SIGNER_PROMPT must be 1, 0 or unset, got "${value}"`);
  }
  if (value === "1") return { prompt: true };
  if (value === "0") {
    return chain === DEV_CHAIN
      ? { prompt: false }
      : {
          prompt: false,
          warning: `⚠️  SIGNER_PROMPT=0 on chain ${chain}: EVERY REQUEST IS SIGNED WITHOUT ASKING. The prompt is the default off the dev chain; unset SIGNER_PROMPT to be asked.`,
        };
  }
  return { prompt: chain !== DEV_CHAIN };
}

/** Refuse a record file that is not this user's own plain 0600 file. */
function own(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077) {
    throw new Error(
      `${file} must be this user's own file, mode 0600: refusing (the signer's signed-nonce record)`,
    );
  }
}

/**
 * The signed-nonce record at `file` for `chain`: get(slot) and
 * set(slot, { unsigned, raw }), slot "<address>:<nonce>"; every set is
 * written through before it returns.
 */
function signedStore(file, chain) {
  let all = {};
  if (fs.existsSync(file)) {
    own(file);
    all = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!all || typeof all !== "object" || Array.isArray(all)) {
      throw new Error(`${file}: not a signed-nonce record`);
    }
  }
  const key = (slot) => `${chain}:${slot.toLowerCase()}`;
  return {
    get: (slot) => all[key(slot)],
    set(slot, entry) {
      all[key(slot)] = entry;
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 1) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    },
    size: () =>
      Object.keys(all).filter((k) => k.startsWith(`${chain}:`)).length,
  };
}

const same = (a, b) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Why the request `req` (signer.js's: to, data, value, and gasLimit /
 * fees only when the caller set them) from `from` on `chain` is not the
 * transaction `raw` recorded at its nonce, or null when it is.
 */
function differs(raw, req, chain, from) {
  const { Transaction } = require("ethers");
  const t = Transaction.from(raw);
  const big = (x) => BigInt(x ?? 0);
  const checks = [
    ["chain", Number(t.chainId) === Number(chain)],
    ["from", same(t.from, from)],
    ["to", same(t.to, req.to)],
    ["value", big(t.value) === big(req.value)],
    ["data", same(t.data, req.data || "0x")],
  ];
  for (const k of [
    "gasLimit",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "gasPrice",
  ])
    if (req[k] !== undefined) checks.push([k, big(t[k]) === big(req[k])]);
  const bad = checks.find(([, ok]) => !ok);
  return bad ? `its ${bad[0]} differs` : null;
}

/** Recorded `raw` as the plain populated transaction describeTx shows. */
function fieldsOf(raw) {
  const { Transaction } = require("ethers");
  const t = Transaction.from(raw);
  const out = { from: t.from };
  for (const k of [
    "type",
    "chainId",
    "nonce",
    "to",
    "value",
    "data",
    "gasLimit",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "accessList",
  ])
    if (t[k] !== null && t[k] !== undefined) out[k] = t[k];
  return out;
}

/** Whether recorded `raw`'s fee still clears the latest block's base fee. */
async function clears(raw, provider) {
  const { Transaction } = require("ethers");
  const t = Transaction.from(raw);
  const base = (await provider.getBlock("latest")).baseFeePerGas;
  if (base === null || base === undefined) return true;
  return (t.maxFeePerGas ?? t.gasPrice ?? 0n) >= base;
}

/**
 * `forget <address> <nonce>`: drop that entry (on every chain) from the
 * record at `file`; returns the keys removed.
 */
function forget(file, address, nonce) {
  if (!fs.existsSync(file)) throw new Error(`${file}: no signed-nonce record`);
  own(file);
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  const tail = `:${String(address).toLowerCase()}:${Number(nonce)}`;
  const gone = Object.keys(all).filter((k) => k.endsWith(tail));
  for (const k of gone) delete all[k];
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return gone;
}

module.exports = {
  promptMode,
  signedStore,
  differs,
  clears,
  fieldsOf,
  forget,
};
