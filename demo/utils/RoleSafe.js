/**
 * @fileoverview Review D-1: a role read as a Safe (its owners, nested
 * owner Safes and modules), for the deploy's role vet and the ceremony's
 * preflight, completion and audit. Moved out of RoleCalls.js for the
 * 500-line rule; RoleCalls.js re-exports it.
 */

const { ethers } = require("hardhat");
const { addrOf } = require("./HandoverChecks");

const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
];
const DEPTH = 2; // nested multisigs read below the role
const is7702 = (code) => code.toLowerCase().startsWith("0xef0100");

/**
 * `addr` read as a Safe: { owners, threshold, modules } (modules null when
 * the contract has no getModulesPaginated), or null when unreadable.
 */
async function readSafe(addr) {
  const safe = await ethers.getContractAt(SAFE_ABI, addr);
  try {
    const [owners, threshold] = await Promise.all([
      safe.getOwners(),
      safe.getThreshold(),
    ]);
    const page = await safe
      .getModulesPaginated("0x0000000000000000000000000000000000000001", 10)
      .catch(() => null);
    return { owners: [...owners], threshold, modules: page && [...page[0]] };
  } catch {
    return null;
  }
}

/**
 * The role at `addr` (`head` names it in notes) read as a Safe: { code,
 * top, keys, deployerVia, notes }. `top` is readSafe(addr), null when the
 * address has no code, is an EIP-7702 delegated account or reads as no
 * Safe. Breadth-first over nested multisig owners to DEPTH: `keys` the
 * owners that are keys, `deployerVia` the multisigs between the role and
 * `deployer` as an owner ("" at the role itself, null when it is none),
 * `notes` the ⚠️ lines for enabled modules and owners not read.
 */
async function readRoleSafe(addr, deployer, head) {
  const code = await ethers.provider.getCode(addr);
  const out = { code, top: null, keys: [], deployerVia: null, notes: [] };
  if (code === "0x" || is7702(code)) return out;
  out.top = await readSafe(addr);
  if (!out.top) return out;
  const queue = [{ safe: out.top, at: addr, path: [] }];
  while (queue.length) {
    const { safe, at, path } = queue.shift();
    const via = path.length ? ` (through ${path.join(", ")})` : "";
    if (safe.modules?.length)
      out.notes.push(
        `⚠️  ${head}${at === addr ? "" : `: owner ${at}${via}`} has module(s) enabled (${safe.modules.join(", ")}): a module executes without the owners`,
      );
    for (const o of safe.owners) {
      if (sameAddr(o, deployer)) out.deployerVia ??= via;
      const c = await ethers.provider.getCode(o);
      if (c === "0x" || is7702(c)) {
        out.keys.push(o);
        continue;
      }
      if (path.length >= DEPTH) {
        out.notes.push(
          `⚠️  ${head}: owner ${o} (through ${path.join(", ")}) has code past ${DEPTH} levels: not read`,
        );
        continue;
      }
      const inner = await readSafe(o);
      if (inner) queue.push({ safe: inner, at: o, path: [...path, o] });
      else
        out.notes.push(
          `⚠️  ${head}: owner ${o}${via} has code but no readable getOwners(): not checked`,
        );
    }
  }
  return out;
}

/**
 * Review LOW-5 (D-1: every external role, the guardian too): an external
 * role with code is read as a Safe. Refused: an EIP-7702 delegated
 * account (its own key acts alone), or the deployer listed as an owner at
 * the role or at any of DEPTH nested multisig levels. Warned by name: an
 * unreadable multisig, an enabled module (it executes without the
 * owners), a contract owner past DEPTH. The check sees listed owners
 * only: the operator makes sure the deployer neither owns nor executes it
 * any other way (runbook section 2).
 */
async function vetRole(r, deployer, log = console.log) {
  if (!r?.external) return;
  const head = `${r.label} ${r.address}`;
  const tail = "its calls are exported for its owners, never sent here";
  const s = await readRoleSafe(r.address, deployer, head);
  if (s.code === "0x") return log(`ℹ️  ${head} is external: ${tail}`);
  if (is7702(s.code))
    throw new Error(
      `${head} is an EIP-7702 delegated account: its own key acts alone, so it is no multisig; use a multisig contract`,
    );
  if (!s.top)
    return log(
      `⚠️  ${head} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked; ${tail}`,
    );
  for (const n of s.notes) log(n);
  if (s.deployerVia !== null)
    throw new Error(
      `${head} lists the deployer ${deployer} as an owner${s.deployerVia}: the deployer neither owns nor executes a role multisig (Task 5.13)`,
    );
  log(
    `ℹ️  ${head} is a ${s.top.threshold}-of-${s.top.owners.length} multisig; the deployer is no listed owner: ${tail}`,
  );
}

/**
 * Review D-1: [label, pass] per role (ops, guardian, issuerAdmin) as
 * vetRole reads it, for the ceremony's preflight, completion and audit: a
 * key that is not the deployer, or a multisig the deployer owns at no
 * depth. One that reads as no Safe passes, named unchecked, as in vetRole.
 */
async function roleSafeLines(o) {
  const d = await addrOf(o.deployer);
  const out = [];
  for (const k of ["ops", "guardian", "issuerAdmin"]) {
    if (!o[k]) continue;
    const a = await addrOf(o[k]);
    const s = await readRoleSafe(a, d, `${k} ${a}`);
    if (s.code === "0x") {
      out.push([
        `${k} ${a} is a key (no code), not the deployer`,
        !sameAddr(a, d),
      ]);
    } else if (is7702(s.code)) {
      out.push([
        `${k} ${a} is an EIP-7702 delegated account: its own key acts alone`,
        false,
      ]);
    } else if (!s.top) {
      out.push([
        `${k} ${a} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked (runbook section 2)`,
        true,
      ]);
    } else if (s.deployerVia === null) {
      out.push([
        `${k} ${a} is a ${s.top.threshold}-of-${s.top.owners.length} multisig; the deployer is no listed owner`,
        true,
      ]);
    } else {
      out.push([
        `${k} ${a} lists the deployer ${d} as an owner${s.deployerVia}: the deployer holds its power`,
        false,
      ]);
    }
  }
  return out;
}

module.exports = { readRoleSafe, vetRole, roleSafeLines };
