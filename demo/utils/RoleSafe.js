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
 * The role at `addr` (`head` names it in its lines) read as a Safe: {
 * code, top, keys, notes, fails }. `top` is readSafe(addr), null when the
 * address has no code, is an EIP-7702 delegated account or reads as no
 * Safe. Breadth-first over nested multisig owners to DEPTH: `keys` the
 * owners that are keys, `notes` the ⚠️ lines for enabled modules, `fails`
 * the refusals the vet throws and the ceremony's role lines print with
 * the same words: a 7702 account, the deployer as a listed owner, and
 * (review D-1 round 2) an owner below the role whose owners cannot be
 * read (code past DEPTH, a cycle, or a contract that reads as no Safe).
 */
async function readRoleSafe(addr, deployer, head) {
  const code = await ethers.provider.getCode(addr);
  const out = { code, top: null, keys: [], notes: [], fails: [] };
  if (code === "0x") return out;
  if (is7702(code)) {
    out.fails.push(
      `${head} is an EIP-7702 delegated account: its own key acts alone, so it is no multisig; use a multisig contract`,
    );
    return out;
  }
  out.top = await readSafe(addr);
  if (!out.top) return out;
  const unread = (o, via, why) =>
    out.fails.push(
      `${head}: owner ${o}${via} is unread (${why}): the deployer's ownership of it cannot be vetted`,
    );
  let listed = false;
  const queue = [{ safe: out.top, at: addr, path: [] }];
  while (queue.length) {
    const { safe, at, path } = queue.shift();
    const via = path.length ? ` (through ${path.join(", ")})` : "";
    if (safe.modules?.length)
      out.notes.push(
        `⚠️  ${head}${at === addr ? "" : `: owner ${at}${via}`} has module(s) enabled (${safe.modules.join(", ")}): a module executes without the owners`,
      );
    for (const o of safe.owners) {
      if (sameAddr(o, deployer) && !listed) {
        listed = true;
        out.fails.push(
          `${head} lists the deployer ${deployer} as an owner${via}: the deployer holds its power`,
        );
      }
      const c = await ethers.provider.getCode(o);
      if (c === "0x" || is7702(c)) {
        out.keys.push(o);
        continue;
      }
      if (path.length >= DEPTH) {
        unread(o, via, `code past ${DEPTH} levels`);
        continue;
      }
      const inner = await readSafe(o);
      if (inner) queue.push({ safe: inner, at: o, path: [...path, o] });
      else unread(o, via, "code but no readable getOwners()");
    }
  }
  return out;
}

/**
 * Review LOW-5 (D-1: every external role, the guardian too): an external
 * role with code is read as a Safe and refused on any of readRoleSafe's
 * fails. Warned by name: a role that reads as no Safe (unchecked, Task
 * 5.13's honest scope) and an enabled module (it executes without the
 * owners). The check sees listed owners only: the operator makes sure
 * the deployer neither owns nor executes it any other way (runbook
 * section 2).
 */
async function vetRole(r, deployer, log = console.log) {
  if (!r?.external) return;
  const head = `${r.label} ${r.address}`;
  const tail = "its calls are exported for its owners, never sent here";
  const s = await readRoleSafe(r.address, deployer, head);
  if (s.fails.length) throw new Error(s.fails[0]);
  if (s.code === "0x") return log(`ℹ️  ${head} is external: ${tail}`);
  if (!s.top)
    return log(
      `⚠️  ${head} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked; ${tail}`,
    );
  for (const n of s.notes) log(n);
  log(
    `ℹ️  ${head} is a ${s.top.threshold}-of-${s.top.owners.length} multisig; the deployer is no listed owner: ${tail}`,
  );
}

/**
 * Review D-1: [label, pass] per role (ops, guardian, issuerAdmin) as
 * vetRole reads it, for the ceremony's preflight, completion and audit: a
 * key that is not the deployer, or a multisig with none of readRoleSafe's
 * fails, each failing with the vet's words. One that reads as no Safe
 * passes, named unchecked, as in vetRole.
 */
async function roleSafeLines(o) {
  const d = await addrOf(o.deployer);
  const out = [];
  for (const k of ["ops", "guardian", "issuerAdmin"]) {
    if (!o[k]) continue;
    const a = await addrOf(o[k]);
    const s = await readRoleSafe(a, d, `${k} ${a}`);
    out.push(...s.fails.map((f) => [f, false]));
    if (s.code === "0x") {
      out.push([
        `${k} ${a} is a key (no code), not the deployer`,
        !sameAddr(a, d),
      ]);
    } else if (!s.top && !s.fails.length) {
      out.push([
        `${k} ${a} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked (runbook section 2)`,
        true,
      ]);
    } else if (!s.fails.length) {
      out.push([
        `${k} ${a} is a ${s.top.threshold}-of-${s.top.owners.length} multisig; the deployer is no listed owner`,
        true,
      ]);
    }
  }
  return out;
}

module.exports = { readRoleSafe, vetRole, roleSafeLines };
