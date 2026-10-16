/**
 * @fileoverview Plan v2 Task 5.13 (Q11 = B): calls a role must make when
 * the CLI cannot sign for it (ops or the issuer admin as a multisig).
 *
 * A role is external when the config gives it as an address rather than
 * a wallet of the signer, or when its address holds code. For an external
 * role the deploy and the ceremony never send its calls: they write them
 * to a batch file per role, stop with exit code 3 (EXIT_AWAITING), and the
 * next run proves each call's EFFECT on chain before it continues. The
 * file is data for the role's owners to approve; the effect check is the
 * security boundary.
 *
 * Batch format: Safe Transaction Builder's BatchFile, as defined by
 * safe-global/safe-react-apps (branch main, commit b823488, 2025-09-26,
 * tx-builder 1.19.0) in apps/tx-builder/src/typings/models.ts (BatchFile,
 * BatchFileMeta, BatchTransaction, ContractMethod, ContractInput),
 * src/lib/checksum.ts (meta.checksum: keccak256 of a sorted-key
 * serialization with meta.name = null), src/store/
 * transactionLibraryContext.tsx (generateBatchFile writes version "1.0";
 * import refuses a value that is not a string) and src/lib/storage.ts
 * (a file with meta and transactions is one batch). A BatchTransaction has
 * no text field, so meta.description lists each call in batch order: step
 * id, contract name and address, function and arguments, purpose.
 */

const fs = require("fs");
const { ethers } = require("hardhat");

const EXIT_AWAITING = 3;
const ZERO = ethers.ZeroAddress;
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Thrown when role calls wait for their owners; exit EXIT_AWAITING. */
class RoleCallsPending extends Error {
  constructor(lines, files = []) {
    super(`paused: awaiting role transactions in ${files.join(", ")}`);
    this.name = "RoleCallsPending";
    this.lines = lines;
    this.files = files;
  }
}

/** A role the CLI does not sign for. */
function externalRole(address, label) {
  return { address: ethers.getAddress(address), external: true, label };
}

/**
 * `x` as a role: an address is external; a signer whose address holds
 * code (a contract wallet) is external too; any other signer as given.
 */
async function resolveRole(x, label) {
  if (x == null) return x;
  if (typeof x === "string") return externalRole(x, label);
  const a = await x.getAddress();
  if ((await ethers.provider.getCode(a)) === "0x") return x;
  return externalRole(a, label);
}

/** The first of `names` whose compiled code `addr` runs, else `fallback`. */
async function compiledName(addr, names, fallback) {
  const { expectedHash, maskedCodeHash } = require("./HandoverCodeHash");
  for (const n of names) {
    if ((await maskedCodeHash(addr, n)) === (await expectedHash(n))) return n;
  }
  return fallback;
}

/** "done" | "pending" | why, for an Ownable2Step accept by `to`. */
async function acceptStatus(c, dAddr, to, who) {
  const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
  if (sameAddr(owner, to) && sameAddr(pending, ZERO)) return "done";
  if (sameAddr(owner, dAddr) && sameAddr(pending, to)) return "pending";
  if (sameAddr(owner, to))
    return `${who} owns it but nominated ${pending}: ownership is moving on`;
  return `owner ${owner}, pendingOwner ${pending}: not what ${who}'s acceptOwnership leaves`;
}

/**
 * The call `step` describes ({ role, roleLabel, contract, name, fn,
 * args, purpose, id }), as the batch file and the refusals print it.
 */
async function callOf(step) {
  const f = step.contract.interface.getFunction(step.fn);
  const to = ethers.getAddress(await step.contract.getAddress());
  return {
    id: step.id,
    role: step.roleLabel,
    from: step.role.address,
    to,
    value: "0",
    data: step.contract.interface.encodeFunctionData(step.fn, step.args),
    name: step.name,
    fn: f.name,
    inputs: f.inputs.map((p, i) => ({
      internalType: p.type,
      name: p.name || `arg${i}`,
      type: p.type,
    })),
    args: step.args.map(String),
    purpose: step.purpose,
  };
}

/** One line per call: what the operator approves, and why. */
function callLine(c) {
  return `[${c.id}] ${c.name} ${c.to}.${c.fn}(${c.args.join(", ")}): ${c.purpose}`;
}

/** Safe's checksum serializer (src/lib/checksum.ts), same output. */
function serialize(json) {
  const plain = (v) =>
    JSON.stringify(v, (_, x) => (x === undefined ? null : x));
  if (Array.isArray(json)) return `[${json.map(serialize).join(",")}]`;
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    const vals = keys.map((k) => `${serialize(json[k])},`).join("");
    return `{${plain(keys)}${vals}}`;
  }
  return plain(json);
}

/** meta.checksum of `batch` (its own checksum left out, name nulled). */
function checksumOf(batch) {
  const meta = { ...batch.meta, name: null };
  delete meta.checksum;
  return ethers.keccak256(ethers.toUtf8Bytes(serialize({ ...batch, meta })));
}

/** The Safe Transaction Builder batch for `calls` (one role, in order). */
function batchFile(chainId, calls, title) {
  const [first] = calls;
  const lines = calls.map((c, i) => `${i + 1}. ${callLine(c)}`);
  const batch = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name: `${title}: ${first.role} ${first.from}`,
      description: [
        `Execute these ${calls.length} call(s) from ${first.role} ${first.from} on chain ${chainId}, in this order, as one batch. Before it continues the CLI checks these effects and the watched events; approve nothing else.`,
        ...lines,
      ].join("\n"),
      createdFromSafeAddress: first.from,
      createdFromOwnerAddress: "",
    },
    transactions: calls.map((c) => ({
      to: c.to,
      value: c.value,
      data: c.data,
      contractMethod: { inputs: c.inputs, name: c.fn, payable: false },
      contractInputsValues: Object.fromEntries(
        c.inputs.map((p, i) => [p.name, c.args[i]]),
      ),
    })),
  };
  batch.meta.checksum = checksumOf(batch);
  return batch;
}

const META_KEYS = [
  "txBuilderVersion",
  "checksum",
  "createdFromSafeAddress",
  "createdFromOwnerAddress",
  "name",
  "description",
];
const TX_KEYS = [
  "to",
  "value",
  "data",
  "contractMethod",
  "contractInputsValues",
];

/**
 * Problems with `b` as a Safe Transaction Builder batch file (the
 * models.ts types, the import's string-value rule, the checksum).
 */
function batchProblems(b) {
  if (!b || typeof b !== "object") return ["not an object"];
  const out = [];
  const isStr = (v) => typeof v === "string";
  const known = (o, keys, where) => {
    for (const k of Object.keys(o || {}))
      if (!keys.includes(k)) out.push(`${where}: unknown key "${k}"`);
  };
  known(b, ["version", "chainId", "createdAt", "meta", "transactions"], "file");
  if (!isStr(b.version)) out.push("version is not a string");
  if (!isStr(b.chainId)) out.push("chainId is not a string");
  if (typeof b.createdAt !== "number") out.push("createdAt is not a number");
  const m = b.meta || {};
  known(m, META_KEYS, "meta");
  if (!isStr(m.name)) out.push("meta.name is not a string");
  for (const k of META_KEYS)
    if (m[k] !== undefined && !isStr(m[k]))
      out.push(`meta.${k} is not a string`);
  if (!Array.isArray(b.transactions)) return [...out, "no transactions list"];
  b.transactions.forEach((t, i) => {
    const w = `transactions[${i}]`;
    known(t, TX_KEYS, w);
    if (!isStr(t.to) || !ethers.isAddress(t.to)) out.push(`${w}.to`);
    if (!isStr(t.value)) out.push(`${w}.value is not a string`);
    if (t.data != null && !ethers.isHexString(t.data)) out.push(`${w}.data`);
    const cm = t.contractMethod;
    if (cm && !(isStr(cm.name) && Array.isArray(cm.inputs)))
      out.push(`${w}.contractMethod`);
    for (const v of Object.values(t.contractInputsValues || {}))
      if (typeof v === "number") out.push(`${w}: a number input value`);
  });
  if (m.checksum !== undefined && checksumOf(b) !== m.checksum)
    out.push("meta.checksum does not match the file");
  return out;
}

const slug = (label) => label.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Write `calls` as one batch file per role, `${base}.<role>-transactions.json`
 * (temporary file, rename); returns the "awaiting" lines and the files.
 */
async function writeRoleBatches(base, calls, title) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const lines = [];
  const files = [];
  for (const role of [...new Set(calls.map((c) => c.role))]) {
    const mine = calls.filter((c) => c.role === role);
    const file = `${base}.${slug(role)}-transactions.json`;
    const tmp = `${file}.tmp-${process.pid}`;
    const text = JSON.stringify(batchFile(chainId, mine, title), null, 2);
    fs.writeFileSync(tmp, text + "\n");
    fs.renameSync(tmp, file);
    files.push(file);
    for (const c of mine) lines.push(`   📤 ${callLine(c)}`);
    const n = mine.length;
    lines.push(
      `⏸️  awaiting ${n} ${role} transaction${n === 1 ? "" : "s"}: ${file}`,
    );
  }
  return { lines, files };
}

/**
 * The steps ({ status() -> "done" | "pending" | why }) whose effect does
 * not hold: { pending, different }, each with its call and reason.
 */
async function checkEffects(steps) {
  const pending = [];
  const different = [];
  for (const s of steps) {
    const st = await s.status();
    if (st === "done") continue;
    const call = await callOf(s);
    if (st === "pending") pending.push({ call, why: "not executed" });
    else different.push({ call, why: st });
  }
  return { pending, different };
}

/**
 * After a pause: refuse (Error) when a step shows another effect than
 * its call's; when some are not executed yet, write those alone again
 * and throw RoleCallsPending; return when every effect holds.
 */
async function requireEffects(steps, base, title, opts = {}) {
  const log = opts.log || console.log;
  const { pending, different } = await checkEffects(steps);
  if (different.length) {
    const named = different.map((d) => `   ❌ ${callLine(d.call)}: ${d.why}`);
    throw new Error(
      `role transactions with another effect than exported (nothing re-exported):\n${named.join("\n")}`,
    );
  }
  if (pending.length) {
    if (!opts.fresh)
      for (const p of pending) log(`   ❌ not executed: ${callLine(p.call)}`);
    const calls = pending.map((p) => p.call);
    const { lines, files } = await writeRoleBatches(base, calls, title);
    throw new RoleCallsPending(lines, files);
  }
  if (steps.length)
    log(`   ✅ ${steps.length} role transaction effect(s) hold on chain`);
}

module.exports = {
  EXIT_AWAITING,
  acceptStatus,
  RoleCallsPending,
  externalRole,
  resolveRole,
  compiledName,
  callOf,
  callLine,
  checksumOf,
  batchFile,
  batchProblems,
  writeRoleBatches,
  checkEffects,
  requireEffects,
};
