/**
 * @fileoverview Review D-1: a role read as a Safe (its owners, nested
 * owner Safes and modules), for the deploy's role vet and the ceremony's
 * preflight, completion and audit. Moved out of RoleCalls.js for the
 * 500-line rule; RoleCalls.js re-exports it.
 */

const { ethers } = require("hardhat");
const { addrOf, noSuchFunction } = require("./HandoverChecks");

const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
];
const DEPTH = 2; // nested multisigs read below the role
const SENTINEL = "0x0000000000000000000000000000000000000001";
const MAX_MODULES = 100; // past it the module list is unread
const PAST = "past";
const NEUTRAL = { from: ethers.ZeroAddress };
const is7702 = (code) => code.toLowerCase().startsWith("0xef0100");

/**
 * `addr` read as a Safe: { owners, threshold, modules } (modules null when
 * the contract has no getModulesPaginated, PAST beyond MAX_MODULES), or
 * null when it has no getOwners(). Round 3: a working getOwners() makes
 * it Safe-shaped, threshold null when getThreshold() cannot be read.
 * Only noSuchFunction errors read as absent; any other error (a timeout,
 * a rate limit) propagates and fails the run like every other read.
 */
async function readSafe(addr) {
  // Round 3: an eth_call from the zero address, not the deployer, so a
  // lookalike keyed on msg.sender cannot answer the deployer differently.
  const safe = new ethers.Contract(addr, SAFE_ABI, ethers.provider);
  const none = (e) => {
    if (noSuchFunction(e)) return null;
    throw e;
  };
  const owners = await safe.getOwners(NEUTRAL).catch(none);
  if (owners === null) return null;
  const threshold = await safe.getThreshold(NEUTRAL).catch(none);
  const modules = await readModules(safe, none);
  return { owners: [...owners], threshold, modules };
}

/**
 * Every module `safe` pages (review D-1 round 3: the deployer enabled
 * first sat 11th, past a single page): PAST beyond MAX_MODULES, null
 * when the contract has no getModulesPaginated. A v1.4.1 Safe returns
 * the page's last entry as `next`; v1.3.0 the first entry after the
 * page, which the next page skips, so it is kept here.
 */
async function readModules(safe, none) {
  const mods = [];
  let start = SENTINEL;
  for (;;) {
    const page = await safe.getModulesPaginated(start, 10, NEUTRAL).catch(none);
    if (page === null) return null;
    const [list, next] = [[...page[0]], page[1]];
    const end = !list.length || sameAddr(next, SENTINEL);
    if (!end && !list.some((m) => sameAddr(m, next))) list.push(next);
    mods.push(...list);
    if (mods.length > MAX_MODULES) return PAST;
    if (end) return mods;
    start = next;
  }
}

/**
 * The role at `addr` (`head` names it in its lines) read as a Safe: {
 * code, top, keys, notes, fails }. `top` is readSafe(addr), null when the
 * address has no code, is an EIP-7702 delegated account or reads as no
 * Safe. Breadth-first over nested multisig owners to DEPTH: `keys` the
 * owners that are keys, `warns` the warnings for enabled modules, `fails`
 * the refusals the vet throws and the ceremony's role lines print with
 * the same words: a 7702 account, the deployer as a listed owner, and
 * (review D-1 round 2) an owner below the role whose owners cannot be
 * read (code past DEPTH, a cycle, or a contract that reads as no Safe)
 * and the deployer as an enabled module (it executes without owners);
 * round 3: a module list or a threshold unread, a degenerate multisig.
 */
async function readRoleSafe(addr, deployer, head) {
  const code = await ethers.provider.getCode(addr);
  const out = { code, top: null, keys: [], warns: [], fails: [] };
  if (code === "0x") return out;
  if (is7702(code)) {
    out.fails.push(
      `${head} is an EIP-7702 delegated account: its own key acts alone, so it is no multisig; use a multisig contract`,
    );
    return out;
  }
  out.top = await readSafe(addr);
  if (!out.top) {
    // Task 5.13's honest scope (MultiSigWallet has no getOwners): passed,
    // but a warning in every phase, never a ✅ (review D-1 round 2).
    out.warns.push(
      `${head} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked (runbook section 2)`,
    );
    return out;
  }
  const unread = (o, via, why) =>
    out.fails.push(
      `${head}: owner ${o}${via} is unread (${why}): the deployer's ownership of it cannot be vetted`,
    );
  let listed = false;
  const queue = [{ safe: out.top, at: addr, path: [] }];
  while (queue.length) {
    const { safe, at, path } = queue.shift();
    const via = path.length ? ` (through ${path.join(", ")})` : "";
    const above = path.slice(0, -1);
    const where =
      at === addr
        ? head
        : `${head}: owner ${at}${above.length ? ` (through ${above.join(", ")})` : ""}`;
    if (!listed && safe.owners.some((o) => sameAddr(o, deployer))) {
      listed = true;
      out.fails.push(
        `${head} lists the deployer ${deployer} as an owner${via}: the deployer holds its power`,
      );
    }
    const [t, n] = [safe.threshold, BigInt(safe.owners.length)];
    if (t === null)
      out.fails.push(
        `${where} reads as a Safe but its threshold cannot be read: it cannot be vetted as a multisig`,
      );
    else if (t < 1n || t > n)
      out.fails.push(
        `${where} is a degenerate multisig (${t}-of-${n}): it needs an owner and a threshold from 1 to its owner count`,
      );
    if (safe.modules === PAST)
      out.fails.push(
        `${where} has its module list unread past ${MAX_MODULES}: a module executes without the owners`,
      );
    // Round 3: a Safe-shaped contract whose modules cannot be read.
    if (safe.modules === null)
      out.fails.push(
        `${where} reads as a Safe but its module list cannot be read: a module executes without the owners`,
      );
    const mods = Array.isArray(safe.modules) ? safe.modules : [];
    if (mods.some((m) => sameAddr(m, deployer)))
      out.fails.push(
        `${where} has the deployer ${deployer} as an enabled module: a module executes without the owners`,
      );
    const others = mods.filter((m) => !sameAddr(m, deployer));
    if (others.length)
      out.warns.push(
        `${where} has module(s) enabled (${others.join(", ")}): a module executes without the owners`,
      );
    for (const o of safe.owners) {
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
 * fails. Warned by name, as readRoleSafe's warns: a role that reads as
 * no Safe (unchecked) and an enabled module (it executes without the
 * owners). The check sees listed owners only: the operator makes sure
 * the deployer neither owns nor executes it any other way (runbook
 * section 2).
 */
async function vetRole(r, deployer, log = console.log) {
  if (!r?.external) return;
  const head = `${r.label} ${r.address}`;
  const tail = "its calls are exported for its owners, never sent here";
  const s = await readRoleSafe(r.address, deployer, head);
  for (const w of s.warns) log(`⚠️  ${w}`);
  if (s.fails.length) throw new Error(s.fails[0]);
  if (s.code === "0x") return log(`ℹ️  ${head} is external: ${tail}`);
  if (!s.top) return;
  log(
    `ℹ️  ${head} is a ${s.top.threshold}-of-${s.top.owners.length} multisig; the deployer is no listed owner: ${tail}`,
  );
}

/**
 * Review D-1: [label, pass] per role (ops, guardian, issuerAdmin) as
 * vetRole reads it, for the ceremony's preflight, completion and audit: a
 * key that is not the deployer, or a multisig with none of readRoleSafe's
 * fails, each failing with the vet's words. Its warnings (round 2: an
 * enabled module, a role that reads as no Safe) go to `warnings` and
 * `residual`: a power the vet cannot attribute, so "the deployer holds
 * no power" is not claimed.
 */
async function roleSafeLines(o, warnings = [], residual = []) {
  const d = await addrOf(o.deployer);
  const out = [];
  for (const k of ["ops", "guardian", "issuerAdmin"]) {
    if (!o[k]) continue;
    const a = await addrOf(o[k]);
    const s = await readRoleSafe(a, d, `${k} ${a}`);
    warnings.push(...s.warns);
    residual.push(...s.warns);
    out.push(...s.fails.map((f) => [f, false]));
    if (s.code === "0x") {
      out.push([
        `${k} ${a} is a key (no code), not the deployer`,
        !sameAddr(a, d),
      ]);
    } else if (s.top && !s.fails.length) {
      out.push([
        `${k} ${a} is a ${s.top.threshold}-of-${s.top.owners.length} multisig; the deployer is no listed owner`,
        true,
      ]);
    }
  }
  return out;
}

module.exports = { readRoleSafe, vetRole, roleSafeLines, noSuchFunction };
