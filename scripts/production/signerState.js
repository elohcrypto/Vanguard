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

module.exports = { promptMode, signedStore };
