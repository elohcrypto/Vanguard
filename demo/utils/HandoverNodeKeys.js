/**
 * @fileoverview The role keys a node may not hold (Task 5.17, deep review
 * M-5, D25 b: a node is a key of its own), moved out of HandoverNodes.js
 * for the 500-line rule when slice C review L-2 widened the list.
 */

const { ethers } = require("hardhat");
const { addrOf, same } = require("./HandoverChecks");
const { readRoleSafe } = require("./RoleCalls");
const { noSuchFunction } = require("./RoleSafe");

// A read with no such function is `v` (review D-1 round 3); any other
// error, a timeout too, is rethrown. An address read reads as the zero
// address, "not that role" (round 4: null threw in same()).
const or = (v) => (e) => {
  if (noSuchFunction(e)) return v;
  throw e;
};

const ROLES = [
  ["ops", "ops"],
  ["guardian", "the guardian"],
  ["issuerAdmin", "the issuer admin"],
];

/**
 * M-5 (D25 b): the role `a` holds besides being a node, or null: ops,
 * the guardian, the issuer admin or an owner key of one that is a
 * multisig (review D-8), the proposer or a voter (`o.voterWallets`,
 * the proposer first), a claim signer (`o.claimSigners`), the
 * OracleManager operator, an InvestorTypeRegistry governor or compliance
 * officer (slice D review LOW-4), an IdentityRegistry,
 * VGT or VSC agent, or a management or claim key of a ClaimIssuer
 * (`o.issuers`; slice C review L-2). The deployer has its own row. Shared
 * with scripts/production/postCeremonyVotes.ts.
 */
async function roleOf(o, a) {
  for (const [k, role] of ROLES) {
    if (o[k] && same(await addrOf(o[k]), a)) return role;
  }
  // Review D-8: nor an owner key of a role multisig, at any depth read.
  for (const [k, role] of ROLES) {
    if (!o[k]) continue;
    const r = await addrOf(o[k]);
    const { keys } = await readRoleSafe(r, ethers.ZeroAddress, role);
    if (keys.some((x) => same(x, a)))
      return `an owner key of ${role} (multisig ${r})`;
  }
  const vw = o.voterWallets || [];
  for (const [i, v] of vw.entries()) {
    if (same(await addrOf(v), a)) return i === 0 ? "the proposer" : "a voter";
  }
  for (const [k, role] of [["claimSigners", "a claim signer"]]) {
    for (const x of o[k] || []) if (same(await addrOf(x), a)) return role;
  }
  const om = o.oracleManager;
  if (om && same(await om.operator().catch(or(ethers.ZeroAddress)), a))
    return "the OracleManager operator";
  for (const [k, role] of [
    ["identityRegistry", "an IdentityRegistry agent"],
    ["governanceToken", "a VGT agent"],
    ["token", "a VSC agent"],
  ]) {
    const c = o[k];
    if (c && (await c.isAgent(a).catch(or(false)))) return role;
  }
  // Slice D review LOW-4: InvestorTypeRegistry's governors and
  // compliance officers.
  const itr = o.investorTypeRegistry;
  if (itr) {
    const r = await ethers.getContractAt(
      [
        "function isGovernor(address) view returns (bool)",
        "function isComplianceOfficer(address) view returns (bool)",
      ],
      await addrOf(itr),
    );
    if (await r.isGovernor(a).catch(or(false)))
      return "an InvestorTypeRegistry governor";
    if (await r.isComplianceOfficer(a).catch(or(false)))
      return "an InvestorTypeRegistry compliance officer";
  }
  const key = ethers.keccak256(ethers.solidityPacked(["address"], [a]));
  for (const iss of o.issuers || []) {
    const at = await addrOf(iss);
    const c = await ethers.getContractAt(
      [
        "function owner() view returns (address)",
        "function getKeysByPurpose(uint256) view returns (bytes32[])",
      ],
      at,
    );
    if (same(await c.owner().catch(or(ethers.ZeroAddress)), a))
      return `the owner of ClaimIssuer ${at}`;
    for (const [purpose, what] of [
      [1, "management"],
      [3, "claim"],
    ]) {
      const keys = await c.getKeysByPurpose(purpose).catch(or([]));
      if (keys.some((k) => same(k, key)))
        return `a ${what} key of ClaimIssuer ${at}`;
    }
  }
  return null;
}

module.exports = { roleOf };
