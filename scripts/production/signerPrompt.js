/**
 * What scripts/production/signer.js shows before it signs, and how it
 * asks (plan v2 Task 5.15; the lead's requirement after a scanner flagged
 * misleading descriptions and terminal injection in the approval prompt).
 *
 *  - Every printed field is cleaned: C0 and C1 control characters (ESC,
 *    CR, backspace, ...), ANSI/OSC sequences with them, Unicode bidi
 *    overrides and zero-width characters are shown escaped (\x1b,
 *    \u202e), never dropped silently, and each field is capped with
 *    "(truncated, N chars)".
 *  - The description comes from the transaction that is signed (chain,
 *    from, to, nonce, value, gas and fees, data) and nothing the caller
 *    labels. The call is decoded only when `to`'s runtime code is a
 *    compiled artifact's (immutables masked; SIGNER_ABI_DIR, default
 *    artifacts/contracts), else "unknown contract" and the selector.
 *    Below it, always: to (checksummed), value in ETH and wei, nonce, gas,
 *    chain, and keccak256(data) with its length, so a decoding cannot
 *    hide what is signed.
 *  - SIGNER_PROMPT=1 asks on the controlling terminal (/dev/tty), never
 *    stdin, and approves only on the exact token printed (the last four
 *    hex digits of the data's hash); anything else refuses.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Interface, formatEther, getAddress, keccak256 } = require("ethers");

const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const MAX = 160;

/** `v` as text a terminal shows literally: escaped and capped. */
function clean(v, max = MAX) {
  const s = String(v).replace(UNSAFE, (c) => {
    const n = c.codePointAt(0);
    return n <= 0xff
      ? `\\x${n.toString(16).padStart(2, "0")}`
      : `\\u${n.toString(16).padStart(4, "0")}`;
  });
  return s.length > max
    ? `${s.slice(0, max)}...(truncated, ${s.length} chars)`
    : s;
}

let artifacts = null;

/** [{ name, iface, code, masks }] for every compiled contract with code. */
function loadArtifacts(
  dir = process.env.SIGNER_ABI_DIR || "artifacts/contracts",
) {
  if (artifacts) return artifacts;
  artifacts = [];
  const infos = new Map();
  const walk = (d) => {
    for (const e of fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true })
      : []) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith(".json") && !f.endsWith(".dbg.json")) {
        try {
          const a = JSON.parse(fs.readFileSync(f, "utf8"));
          if (!a.deployedBytecode || a.deployedBytecode.length <= 2) continue;
          const dbg = JSON.parse(
            fs.readFileSync(f.replace(/\.json$/, ".dbg.json"), "utf8"),
          );
          const info = path.resolve(path.dirname(f), dbg.buildInfo);
          if (!infos.has(info))
            infos.set(info, JSON.parse(fs.readFileSync(info, "utf8")));
          const out =
            infos.get(info).output.contracts[a.sourceName][a.contractName];
          const refs = out.evm.deployedBytecode.immutableReferences || {};
          artifacts.push({
            name: a.contractName,
            iface: new Interface(a.abi),
            code: a.deployedBytecode.toLowerCase(),
            masks: Object.values(refs).flat(),
          });
        } catch {
          // not an artifact with a build info: never matched
        }
      }
    }
  };
  walk(dir);
  return artifacts;
}

/** `code` with every immutable range of `masks` zeroed (hex, 0x...). */
function masked(code, masks) {
  let s = code.toLowerCase();
  for (const { start, length } of masks) {
    const a = 2 + start * 2;
    s = s.slice(0, a) + "0".repeat(length * 2) + s.slice(a + length * 2);
  }
  return s;
}

/** The compiled contract whose runtime code `code` is, or null. */
function knownContract(code) {
  if (!code || code === "0x") return null;
  for (const a of loadArtifacts()) {
    if (
      a.code.length === code.length &&
      masked(a.code, a.masks) === masked(code, a.masks)
    )
      return a;
  }
  return null;
}

/**
 * The lines shown for the populated transaction `tx` on `chain`, `code`
 * being `tx.to`'s runtime code; and the approval token.
 */
function describeTx(tx, chain, code) {
  const data = tx.data || "0x";
  const hash = keccak256(data);
  const to = tx.to ? getAddress(tx.to) : null;
  const known = to ? knownContract(code) : null;
  let call;
  if (!to) call = "create a contract";
  else if (!known)
    call = `unknown contract: selector ${clean(data.slice(0, 10))}`;
  else {
    const t = known.iface.parseTransaction({ data });
    call = t
      ? `${clean(known.name)}.${clean(t.name)}(${t.args.map((a) => clean(a)).join(", ")})`
      : `${clean(known.name)}: selector ${clean(data.slice(0, 10))} not in its ABI`;
  }
  const value = BigInt(tx.value || 0);
  const fees = tx.maxFeePerGas
    ? `maxFee ${BigInt(tx.maxFeePerGas)} wei, tip ${BigInt(tx.maxPriorityFeePerGas || 0)} wei`
    : `gasPrice ${BigInt(tx.gasPrice || 0)} wei`;
  return {
    token: hash.slice(-4),
    lines: [
      `   ${call}`,
      `   to ${to ?? "(create)"} | value ${formatEther(value)} ETH (${value} wei) | nonce ${tx.nonce} | gas ${tx.gasLimit} | ${fees} | chain ${chain}`,
      `   from ${getAddress(tx.from)} | data keccak256 ${hash} (${(data.length - 2) / 2} bytes)`,
    ],
  };
}

/** The lines and token for a message signature by `from`. */
function describeMessage(from, data) {
  const hash = keccak256(data);
  return {
    token: hash.slice(-4),
    lines: [
      `   sign a message as ${getAddress(from)}: keccak256 ${hash} (${(data.length - 2) / 2} bytes; a claim digest is 32)`,
    ],
  };
}

/** Whether /dev/tty can be opened (SIGNER_PROMPT=1 needs it). */
function hasTty() {
  try {
    fs.closeSync(fs.openSync("/dev/tty", "r+"));
    return true;
  } catch {
    return false;
  }
}

/** Ask on /dev/tty; true only when the line typed is exactly `token`. */
function askTty(text, token) {
  const fd = fs.openSync("/dev/tty", "r+");
  try {
    fs.writeSync(
      fd,
      `${text}\n   type ${token} to sign, anything else refuses: `,
    );
    const buf = Buffer.alloc(64);
    let line = "";
    while (!line.includes("\n")) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      line += buf.toString("utf8", 0, n);
    }
    return line.split("\n")[0].trim() === token;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  clean,
  describeTx,
  describeMessage,
  knownContract,
  hasTty,
  askTty,
};
