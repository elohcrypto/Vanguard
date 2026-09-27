/**
 * @fileoverview Handover ceremony: acceptance plan, shared helpers and the
 * read-only completion check. Split from Handover.js (plan v2 Task 2C.2) to
 * keep both files under 500 lines; Handover.js re-exports everything callers
 * used before, so no caller changes.
 */

const { ethers } = require("hardhat");

const plan = (key, proposalType, label, typeName) => ({
  key,
  proposalType,
  label,
  typeName,
});
/** One acceptOwnership() vote per contract governance was nominated for. */
const ACCEPTANCE_PLAN = [
  plan("token", 3, "Token", "TokenParameters"),
  plan("governanceToken", 11, "GovernanceToken", "GovernanceTokenParameters"),
  plan(
    "identityRegistry",
    10,
    "IdentityRegistry",
    "IdentityRegistryParameters",
  ),
  plan("complianceRules", 1, "ComplianceRules", "ComplianceRules"),
  plan("oracleManager", 2, "OracleManager", "OracleParameters"),
  plan("governance", 4, "VanguardGovernance", "SystemParameters"),
];
/** [contract, label] for the six contracts governance ends up owning. */
const core = (o) => ACCEPTANCE_PLAN.map((e) => [o[e.key], e.label]);

async function addrOf(x) {
  if (typeof x === "string") return x;
  if (x.getAddress) return x.getAddress();
  return x.address;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const keyOf = (a) => ethers.keccak256(ethers.solidityPacked(["address"], [a]));

/** True when `wallet` holds a non-revoked key of any purpose on the issuer. */
async function hasLiveKey(issuer, wallet) {
  const k = await issuer.issuerKeys(keyOf(wallet));
  return k.key !== ethers.ZeroHash && !k.revoked;
}

async function issuerLabel(issuer) {
  const name = await issuer.issuerName().catch(() => "");
  return `${name || "ClaimIssuer"} (${await issuer.getAddress()})`;
}

/** Read-only verification. Returns { ok, failures, checks }; never pauses. */
async function assertHandoverComplete(o) {
  const dAddr = await addrOf(o.deployer);
  const ops = await addrOf(o.ops);
  const guardian = await addrOf(o.guardian);
  const govAddr = await addrOf(o.governance);
  const checks = [];
  const add = (label, pass) => checks.push({ label, ok: Boolean(pass) });

  for (const [c, label] of core(o)) {
    add(`${label} owned by governance`, same(await c.owner(), govAddr));
  }
  add("deployer is not a Token agent", !(await o.token.isAgent(dAddr)));
  add(
    "deployer is not a GovernanceToken agent",
    !(await o.governanceToken.isAgent(dAddr)),
  );
  add(
    "deployer is not an IdentityRegistry agent",
    !(await o.identityRegistry.isAgent(dAddr)),
  );
  add(
    "deployer is not a ComplianceRules rule administrator",
    !(await o.complianceRules.ruleAdministrators(dAddr)),
  );
  add("ops is a Token agent", await o.token.isAgent(ops));
  add("ops is a GovernanceToken agent", await o.governanceToken.isAgent(ops));
  add(
    "ops is an IdentityRegistry agent",
    await o.identityRegistry.isAgent(ops),
  );
  add("guardian set on Token", same(await o.token.guardian(), guardian));
  if (o.investorTypeRegistry) {
    const reg = o.investorTypeRegistry;
    add(
      "InvestorTypeRegistry owned by governance (option 83b)",
      same(await reg.owner(), govAddr),
    );
    add(
      "ops is an InvestorTypeRegistry compliance officer",
      await reg.isComplianceOfficer(ops),
    );
    add(
      "deployer is not an InvestorTypeRegistry compliance officer",
      !(await reg.isComplianceOfficer(dAddr)),
    );
  }
  for (const oracle of o.oracles || []) {
    add(
      `oracle ${await oracle.getAddress()} owned by ops`,
      same(await oracle.owner(), ops),
    );
  }
  for (const issuer of o.issuers || []) {
    const label = await issuerLabel(issuer);
    add(`deployer does not own ${label}`, !same(await issuer.owner(), dAddr));
    add(
      `deployer holds no live key on ${label}`,
      !(await hasLiveKey(issuer, dAddr)),
    );
  }
  const failures = checks.filter((c) => !c.ok).map((c) => c.label);
  return { ok: failures.length === 0, failures, checks };
}

module.exports = {
  ACCEPTANCE_PLAN,
  core,
  addrOf,
  same,
  keyOf,
  hasLiveKey,
  issuerLabel,
  assertHandoverComplete,
};
