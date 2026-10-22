/**
 * Task 5.17 slice B (deep review L-5): two of scripts/production/signer.js's
 * decisions, kept here so signer.js stays under the line limit.
 *
 *  - promptMode: the prompt is the default off the dev chain. SIGNER_PROMPT
 *    unset asks on every request unless the upstream is 31337; "1" always
 *    asks; "0" never does, and off 31337 says so loudly at start (an
 *    operator who switches the prompt off on Sepolia should see it).
 *  - signedStore: the per-nonce "already signed" record (signer.js L-5:
 *    one nonce signed for one transaction only) kept on disk beside the
 *    keystores (recordFile: <SIGNER_KEYSTORE_DIR>/signed-nonces, this
 *    user's own, 0600, written atomically; review D-4: not under the temp
 *    directory nor keyed by port, so a reboot, a tmp cleanup or another
 *    port keeps it), so a restarted signer still refuses another
 *    transaction at a nonce it signed before. It holds raw signed
 *    transactions only (public once sent), keyed by chain, signer address
 *    and nonce. No .json suffix: loadKeys reads every *.json as a key.
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
 *  - holdKeystores (review D-4 rounds 2 and 3): the keystore directory is
 *    this user's own, mode 0700, and one signer's. Two signers on one
 *    directory would each keep the record in memory and both sign the
 *    same nonce, so <dir>/signer.lock names its holder in one JSON line,
 *    {pid, host, boot, ns, start}: os.hostname(), the kernel's boot id,
 *    the PID namespace (readlink /proc/self/ns/pid) and the start time
 *    (field 22 of /proc/self/stat; a reused pid has another). It is taken
 *    by link() of a fully written private file, atomic and never empty
 *    (Node's fs has no flock). A second start is refused while the holder
 *    runs. A lock that is empty or unparsable, or written on another
 *    host, boot or PID namespace (where its holder cannot be checked), is
 *    refused with its rm, never taken over. A dead holder's lock is taken
 *    over under <dir>/signer.lock.takeover (link() too): another's lock is
 *    removed only while holding it, after re-reading that the lock is
 *    still the one judged dead, so a lock another starter made since is
 *    never removed; a takeover file left by a killed start is refused with
 *    its rm. Without /proc (macOS) boot, ns and start are null and the pid
 *    alone is checked: a reused pid reads as a live holder (refused, rm by
 *    hand). On exit a holder removes the lock only while it is its own,
 *    byte for byte. The record's temporary file is created exclusively
 *    too, so a path planted there is refused, never written through.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEV_CHAIN = 31337;

/** The signed-nonce record of the keystores in `dir`. */
const recordFile = (dir) => path.join(dir, "signed-nonces");

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

/** `fn()`, or null when it throws. */
function orNull(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Start time of process `pid` (field 22 of /proc/<pid>/stat), or null. */
function startOf(pid) {
  return orNull(() => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  });
}

/** This process as a lock's holder; start null where /proc is unusable. */
function whoami() {
  // a /proc of another PID namespace would name other processes' pids
  const proc = orNull(() => fs.readlinkSync("/proc/self")) === `${process.pid}`;
  return {
    pid: process.pid,
    host: os.hostname(),
    boot: orNull(() =>
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    ),
    ns: orNull(() => fs.readlinkSync("/proc/self/ns/pid")),
    start: proc ? startOf(process.pid) : null,
  };
}

/** The holder a lock's `text` names, or null when it names none. */
function holderOf(text) {
  const h = orNull(() => JSON.parse(text));
  const str = (x) => x === null || typeof x === "string";
  const ok =
    h !== null &&
    typeof h === "object" &&
    Number.isInteger(h.pid) &&
    h.pid > 0 &&
    typeof h.host === "string" &&
    [h.boot, h.ns, h.start].every(str);
  return ok ? h : null;
}

/** Whether holder `h`, of this host, boot and PID namespace, runs. */
function runs(h, me) {
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false; // EPERM: it runs, as another user
  }
  if (h.start === null || me.start === null) return true;
  const now = startOf(h.pid);
  return now === null || now === h.start; // unreadable: it may still run
}

/** Throw unless lock `file`'s `text` names a holder that is gone. */
function refuseUnlessDead(file, text, me) {
  const h = holderOf(text);
  if (!h) {
    throw new Error(
      `${file} is not a signer lock (empty or unparsable): refusing to start; if no signer runs on these keystores, rm ${file}`,
    );
  }
  if (h.host !== me.host || h.boot !== me.boot || h.ns !== me.ns) {
    const q = JSON.stringify;
    throw new Error(
      `${file} is held by pid ${h.pid} on host ${q(h.host)} (boot ${q(h.boot)}, ${q(h.ns)}), another host, boot or PID namespace than this signer's, where it cannot be checked: refusing to start; if no signer runs there, rm ${file}`,
    );
  }
  if (runs(h, me)) {
    throw new Error(
      `${file} is held by pid ${h.pid} (a signer running on these keystores): refusing to start a second one; if none runs, rm ${file}`,
    );
  }
}

/** Create `file` holding `text`, atomically; false when it exists. */
function take(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** Lock `file`'s text, or null when there is none. */
function readLock(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Hold keystore directory `dir` for this process; released on exit. */
function holdKeystores(dir) {
  const st = fs.statSync(dir);
  const mode = st.mode & 0o777;
  if (!st.isDirectory() || st.uid !== process.getuid() || mode !== 0o700) {
    throw new Error(
      `${dir} must be this user's own directory, mode 0700 (it is ${mode.toString(8)}): chmod 700 ${dir}`,
    );
  }
  const lock = path.join(dir, "signer.lock");
  const takeover = `${lock}.takeover`;
  const me = whoami();
  const mine = JSON.stringify(me) + "\n";
  for (let tries = 0; !take(lock, mine); tries++) {
    // a dangling link there reads as absent on every turn
    if (tries === 9) {
      throw new Error(
        `${lock} keeps changing while this signer starts: refusing to start; if no signer runs on these keystores, rm ${lock}`,
      );
    }
    const seen = readLock(lock);
    if (seen === null) continue; // its holder released it meanwhile
    refuseUnlessDead(lock, seen, me);
    if (!take(takeover, mine)) {
      throw new Error(
        `${takeover} exists: another signer is taking over ${lock}, or was killed doing so: refusing to start; if none is starting, rm ${takeover}`,
      );
    }
    try {
      if (readLock(lock) === seen) fs.unlinkSync(lock);
    } finally {
      fs.unlinkSync(takeover);
    }
  }
  process.on("exit", () => {
    if (orNull(() => readLock(lock)) === mine) fs.unlinkSync(lock);
  });
}

/** `all` to the record at `file`: an exclusive temporary file, renamed. */
function writeRecord(file, all) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    throw new Error(
      `${tmp} exists: refusing to write the signed-nonce record through it (remove it if no signer runs)`,
    );
  }
  fs.renameSync(tmp, file);
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
      const next = { ...all, [key(slot)]: entry };
      writeRecord(file, next); // on disk before it counts
      all = next;
    },
    size: () =>
      Object.keys(all).filter((k) => k.startsWith(`${chain}:`)).length,
  };
}

const same = (a, b) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Why the request `req` (signer.js's: to, data, value) from `from` on
 * `chain` is not the transaction `raw` recorded at its nonce, or null
 * when it is. Gas limit and fees are not what a transaction does (slice C
 * review L-1: hardhat-ethers sets gas from a fresh estimateGas, which can
 * move by one between a run and its re-run): see regas.
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
  const bad = checks.find(([, ok]) => !ok);
  return bad ? `its ${bad[0]} differs` : null;
}

/**
 * The gas limit or fee the caller of `req` set that differs from the
 * recorded `raw`'s, or null: the same transaction then is signed again
 * with them (a fee bump), not re-broadcast as recorded.
 */
function regas(raw, req) {
  const { Transaction } = require("ethers");
  const t = Transaction.from(raw);
  return (
    ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "gasPrice"].find(
      (k) => req[k] !== undefined && BigInt(t[k] ?? 0) !== BigInt(req[k]),
    ) ?? null
  );
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

/** Whether a fee the caller of `req` set is below recorded `raw`'s. */
function lowersFee(raw, req) {
  const { Transaction } = require("ethers");
  const t = Transaction.from(raw);
  return ["maxFeePerGas", "maxPriorityFeePerGas", "gasPrice"].some(
    (k) => req[k] !== undefined && BigInt(req[k]) < BigInt(t[k] ?? 0),
  );
}

/**
 * Slice C review L-5: the fees of a replacement for recorded `raw` (stuck
 * in the mempool): each at least 1/8 above the recorded one (nodes
 * replace a pending transaction only for a 10% higher fee) and at least
 * the market's `fee` (provider.getFeeData()).
 */
function raisedFees(raw, fee) {
  const { Transaction } = require("ethers");
  const t = Transaction.from(raw);
  const up = (old, market) => {
    const x = (BigInt(old ?? 0) * 9n) / 8n + 1n;
    return market != null && BigInt(market) > x ? BigInt(market) : x;
  };
  return t.maxFeePerGas != null
    ? {
        maxFeePerGas: up(t.maxFeePerGas, fee.maxFeePerGas),
        maxPriorityFeePerGas: up(
          t.maxPriorityFeePerGas,
          fee.maxPriorityFeePerGas,
        ),
      }
    : { gasPrice: up(t.gasPrice, fee.gasPrice) };
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
  writeRecord(file, all);
  return gone;
}

module.exports = {
  recordFile,
  holdKeystores,
  promptMode,
  signedStore,
  differs,
  regas,
  lowersFee,
  raisedFees,
  clears,
  fieldsOf,
  forget,
};
