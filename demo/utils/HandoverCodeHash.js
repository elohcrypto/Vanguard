/**
 * @fileoverview Handover ceremony, review 3.3 MEDIUM-1/2 (R-3R-4): the
 * privacy contracts are pinned by runtime code hash. testingMode(),
 * owner() and pendingOwner() are self-reported, so a look-alike wrapper or
 * an always-true circuit verifier swapped in before the ceremony passes
 * them. Each contract's keccak256(getCode) must equal the keccak256 of the
 * compiled artifact's deployedBytecode.
 *
 * ZKVerifierIntegrated's only immutable is testingMode. Solc leaves an
 * immutable as a zero word in the artifact, and a `false` immutable is a
 * zero word at runtime, so a real-mode wrapper matches exactly and a
 * testingMode one does not (test/production/HandoverCodeHash.test.ts
 * proves it from the build info's immutableReferences). PrivacyManager and
 * the five circuit verifiers have no immutables.
 */

const { execFileSync } = require("child_process");
const { ethers, artifacts } = require("hardhat");
const { addrOf } = require("./HandoverChecks");

/** Wrapper getter -> artifact; getVerifierAddresses() omits the blacklist. */
const VERIFIERS = [
  ["whitelistVerifier", "WhitelistMembershipVerifier"],
  ["blacklistVerifier", "BlacklistMembershipVerifier"],
  ["jurisdictionVerifier", "JurisdictionProofVerifier"],
  ["accreditationVerifier", "AccreditationProofVerifier"],
  ["complianceVerifier", "ComplianceAggregationVerifier"],
];
const WRAPPER_ABI = VERIFIERS.map(
  ([g]) => `function ${g}() view returns (address)`,
);

async function expectedHash(name) {
  return ethers.keccak256(
    (await artifacts.readArtifact(name)).deployedBytecode,
  );
}

async function codeHash(addr) {
  return ethers.keccak256(await ethers.provider.getCode(addr));
}

const rangeCache = new Map();
/**
 * Task 4.13: the byte ranges solc fills with immutables in `name`'s
 * runtime code (the build info's immutableReferences; empty for a
 * contract without immutables), cached per artifact.
 */
async function immutableRanges(name) {
  if (rangeCache.has(name)) return rangeCache.get(name);
  const art = await artifacts.readArtifact(name);
  const info = await artifacts.getBuildInfo(
    `${art.sourceName}:${art.contractName}`,
  );
  const refs =
    info?.output.contracts[art.sourceName]?.[art.contractName]?.evm
      ?.deployedBytecode?.immutableReferences || {};
  const ranges = Object.values(refs).flat();
  rangeCache.set(name, ranges);
  return ranges;
}

/**
 * keccak256 of `addr`'s runtime code with `name`'s immutable ranges
 * zeroed, so it equals expectedHash(name) for an honest deployment
 * whatever its constructor arguments were. The privacy pins above stay
 * exact: ZKVerifierIntegrated's only immutable is testingMode, whose
 * honest value is the artifact's zero (HandoverCodeHash.test.ts).
 */
async function maskedCodeHash(addr, name, read) {
  const code = ethers.getBytes(read ?? (await ethers.provider.getCode(addr)));
  for (const r of await immutableRanges(name)) {
    if (r.start + r.length <= code.length) {
      code.fill(0, r.start, r.start + r.length);
    }
  }
  return ethers.keccak256(code);
}

/**
 * Review U2 round 6 (G4): `code` (read at a new address) is `name`'s
 * runtime code, its immutables aside. The exact match needs no build info,
 * so only a contract with immutables pays for reading it.
 */
async function isCodeOf(code, name) {
  const { deployedBytecode } = await artifacts.readArtifact(name);
  if (code.toLowerCase() === deployedBytecode.toLowerCase()) return true;
  const masked = await maskedCodeHash(null, name, code);
  return masked === ethers.keccak256(deployedBytecode);
}

/**
 * Masked pins for [{ label, addr, name }] (an entry without an address
 * is skipped): [{ label, addr, name, actual, expected, ok }], the shape
 * codeHashLabel and codeHashRefusal print.
 */
async function pinChecks(entries) {
  const out = [];
  for (const { label, addr, name } of entries) {
    if (!addr) continue;
    const a = await addrOf(addr);
    const hasCode = (await ethers.provider.getCode(a)) !== "0x";
    const actual = hasCode ? await maskedCodeHash(a, name) : "0x(no code)";
    const expected = await expectedHash(name);
    out.push({
      label,
      addr: a,
      name,
      actual,
      expected,
      ok: actual === expected,
    });
  }
  return out;
}

/**
 * One entry per pinned contract: { label, addr, name, actual, expected, ok }.
 * `pm` and each of `wrappers` may be a contract, an address or empty. A
 * wrapper's five verifiers are read only once its own code matched (a
 * look-alike's getters prove nothing).
 */
async function codeHashChecks(pm, wrappers = []) {
  const out = [];
  const pin = async (label, addr, name) => {
    const [actual, expected] = [await codeHash(addr), await expectedHash(name)];
    const ok = actual === expected;
    out.push({ label, addr, name, actual, expected, ok });
    return ok;
  };
  if (pm) await pin("PrivacyManager", await addrOf(pm), "PrivacyManager");
  const seen = [];
  for (const w of wrappers) {
    if (!w) continue;
    const a = await addrOf(w);
    if (seen.includes(a.toLowerCase())) continue;
    seen.push(a.toLowerCase());
    if (!(await pin("ZKVerifierIntegrated", a, "ZKVerifierIntegrated"))) {
      continue;
    }
    const v = await ethers.getContractAt(WRAPPER_ABI, a);
    for (const [getter, name] of VERIFIERS) {
      const label = `ZKVerifierIntegrated ${a} ${getter}`;
      await pin(label, await v[getter](), name);
    }
  }
  return out;
}

/** Completion line label for a check. */
function codeHashLabel(c) {
  return `${c.label} ${c.addr} code matches the compiled ${c.name}`;
}

/** Preflight refusal message for a mismatch: names both hashes. */
function codeHashRefusal(c) {
  return `${c.label} ${c.addr} runtime code hash ${c.actual} is not the compiled ${c.name} (${c.expected}): redeploy it from this build, or vote the compiled contract in, before the handover`;
}

/**
 * Review 3.3 follow-up LOW-A: the pins prove "same code as this checkout",
 * nothing more, so the completion report names the checkout. { commit,
 * dirty } from git; commit "unknown" and dirty null outside a git tree.
 */
function buildIdentity() {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const commit = git("rev-parse", "--short", "HEAD");
  const status = git("status", "--porcelain", "--untracked-files=no");
  return {
    commit: commit || "unknown",
    dirty: status === null ? null : status.length > 0,
  };
}

/** Completion line text for the checkout the pins were compiled from. */
function buildIdentityLabel({ commit, dirty }) {
  const state =
    dirty === null
      ? "not a git checkout"
      : dirty
        ? "DIRTY TREE: run the ceremony from the reviewed commit"
        : "clean tree";
  return `code-hash pins compiled from commit ${commit} (${state})`;
}

module.exports = {
  VERIFIERS,
  codeHash,
  expectedHash,
  immutableRanges,
  maskedCodeHash,
  isCodeOf,
  pinChecks,
  codeHashChecks,
  codeHashLabel,
  codeHashRefusal,
  buildIdentity,
  buildIdentityLabel,
};
