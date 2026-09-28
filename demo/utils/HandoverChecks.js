/**
 * @fileoverview Handover ceremony: acceptance plan, shared helpers and the
 * read-only completion check. Split from Handover.js (plan v2 Task 2C.2) to
 * keep both files under 500 lines; Handover.js re-exports everything callers
 * used before, so no caller changes.
 */

const { ethers } = require("hardhat");

const plan = (key, proposalType, label, typeName, opts = {}) => ({
  key,
  proposalType,
  label,
  typeName,
  // Optional entries are skipped when the caller passes no contract for them.
  optional: Boolean(opts.optional),
});
/** One acceptOwnership() vote per contract governance was nominated for. */
const ACCEPTANCE_PLAN = [
  plan("token", 3, "Token", "TokenParameters"),
  plan("governanceToken", 8, "GovernanceToken", "GovernanceTokenParameters"),
  plan("identityRegistry", 7, "IdentityRegistry", "IdentityRegistryParameters"),
  plan("complianceRules", 1, "ComplianceRules", "ComplianceRules"),
  plan("oracleManager", 2, "OracleManager", "OracleParameters"),
  // Demo option 84; absent in deployments that never ran it (plan 2D.1).
  plan("dynamicListManager", 6, "DynamicListManager", "ListUpdate", {
    optional: true,
  }),
  // Optional; option 83b may already have handed it to governance (2E.2).
  plan(
    "investorTypeRegistry",
    0,
    "InvestorTypeRegistry",
    "InvestorTypeConfig",
    {
      optional: true,
    },
  ),
  plan("governance", 4, "VanguardGovernance", "SystemParameters"),
];
// Steps 1 and 5 call these as their owner, so the deployer must still own them.
const DEPLOYER_CALLED = [
  "token",
  "governanceToken",
  "identityRegistry",
  "complianceRules",
];
/** The plan entries that apply to `o`: optional ones only when given. */
const planFor = (o) =>
  ACCEPTANCE_PLAN.filter((e) => !(e.optional && o[e.key] == null));
/** [contract, label] for every contract governance ends up owning. */
const core = (o) => planFor(o).map((e) => [o[e.key], e.label]);

async function addrOf(x) {
  if (typeof x === "string") return x;
  if (x.getAddress) return x.getAddress();
  return x.address;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const MANAGEMENT_KEY = 1;
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

function fail(msg) {
  throw new Error(`Handover: ${msg}`);
}

/**
 * An oracle's list-manager writer, or null when it has none: no listManager
 * in its ABI, or the call reverts (ConsensusOracle behind an inline ABI).
 * Anything else (an RPC failure) is rethrown, never read as "no role".
 */
async function listManagerOf(oracle) {
  if (typeof oracle.listManager !== "function") return null;
  return oracle.listManager().catch((e) => {
    // ethers v6 on a public RPC reports CALL_EXCEPTION; a Hardhat node
    // reports "Transaction reverted: function selector was not recognized".
    if (e.code === "CALL_EXCEPTION" || /revert/i.test(e.message)) return null;
    throw e;
  });
}

/**
 * Every precondition, read-only, before the ceremony's first transaction
 * (plan v2 Task 2E.2): refuse to start rather than stop halfway. Returns
 * { governanceOwned }: plan keys governance already owns (step 3 skips them).
 */
async function preflight(o) {
  const dAddr = await addrOf(o.deployer);
  const ops = await addrOf(o.ops);
  const govAddr = await addrOf(o.governance);
  const opsSigns = typeof o.ops.signMessage === "function";
  // Governance must be bound to every contract it is about to own, or the
  // acceptOwnership vote in step 4 can never be proposed.
  for (const e of planFor(o).filter((x) => x.key !== "governance")) {
    const want = await addrOf(o[e.key]);
    const got = await o.governance.boundTarget(e.proposalType);
    if (!same(got, want)) {
      fail(
        `governance is not bound to ${e.label} (${want}); boundTarget(${e.proposalType}) = ${got}. ` +
          `Governance must be deployed after ${e.label}; redeploy it.`,
      );
    }
  }
  const governanceOwned = new Set();
  for (const e of planFor(o)) {
    const owner = await o[e.key].owner();
    if (same(owner, dAddr)) continue;
    const deployerNeeded =
      DEPLOYER_CALLED.includes(e.key) ||
      (e.key === "dynamicListManager" &&
        !same(await o.dynamicListManager.governanceContract(), govAddr));
    if (!same(owner, govAddr) || deployerNeeded) {
      fail(
        `deployer ${dAddr} does not own ${e.label} (owner ${owner}); the handover was already run or needs another key`,
      );
    }
    governanceOwned.add(e.key);
  }
  for (const issuer of o.issuers || []) {
    const label = await issuerLabel(issuer);
    const owner = await issuer.owner();
    const hasKey = await hasLiveKey(issuer, dAddr);
    if (hasKey && !same(owner, dAddr)) {
      fail(
        `deployer holds a key on ${label} but is not its owner (${owner}); its owner must run this issuer's handover`,
      );
    }
    if (!hasKey && !same(owner, dAddr)) continue;
    if (!opsSigns) {
      fail(`ops must be a signer to accept ownership of ${label}`);
    }
    // addIssuerKey reverts "Key already exists" for any ops key that is not
    // a live MANAGEMENT_KEY, after step 1 has already sent transactions.
    const k = await issuer.issuerKeys(keyOf(ops));
    const liveManagement = Number(k.purpose) === MANAGEMENT_KEY && !k.revoked;
    if (k.key !== ethers.ZeroHash && !liveManagement) {
      fail(
        `ops ${ops} already holds a ${k.revoked ? "revoked" : `purpose-${k.purpose}`} key on ${label}; ` +
          `a revoked or other-purpose ops key cannot be re-added as MANAGEMENT_KEY, so use a different ops key or a new issuer`,
      );
    }
  }
  for (const oracle of o.oracles || []) {
    const a = await oracle.getAddress();
    const owner = await oracle.owner();
    if (!same(owner, dAddr) && !same(owner, ops)) {
      fail(`oracle ${a} is owned by ${owner}, neither deployer nor ops`);
    }
    const lm = await listManagerOf(oracle);
    if (lm && same(lm, dAddr) && !same(owner, dAddr)) {
      fail(`oracle ${a} listManager is the deployer and only ops can clear it`);
    }
  }
  return { governanceOwned };
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
  if (o.dynamicListManager) {
    add(
      "DynamicListManager governanceContract is governance",
      same(await o.dynamicListManager.governanceContract(), govAddr),
    );
  }
  add(
    "GovernanceToken has no guardian",
    same(await o.governanceToken.guardian(), ethers.ZeroAddress),
  );
  if (o.investorTypeRegistry) {
    const reg = o.investorTypeRegistry;
    add(
      "ops is an InvestorTypeRegistry compliance officer",
      await reg.isComplianceOfficer(ops),
    );
    add(
      "deployer is not an InvestorTypeRegistry compliance officer",
      !(await reg.isComplianceOfficer(dAddr)),
    );
    if (typeof reg.isGovernor === "function") {
      add(
        "deployer is not an InvestorTypeRegistry governor",
        !(await reg.isGovernor(dAddr)),
      );
    }
  }
  for (const oracle of o.oracles || []) {
    const a = await oracle.getAddress();
    add(`oracle ${a} owned by ops`, same(await oracle.owner(), ops));
    const lm = await listManagerOf(oracle);
    if (lm)
      add(`oracle ${a} listManager is not the deployer`, !same(lm, dAddr));
  }
  const rules = o.complianceRules;
  add(
    "deployer is not a trusted contract",
    !(await rules.isTrustedContract(dAddr)),
  );
  // Residue from runs before 2E.1, when a wallet could be trusted. Scanned
  // in chunks: public RPCs cap the eth_getLogs block range.
  const chunk = o.logChunk || 5000;
  const latest = await ethers.provider.getBlockNumber();
  const added = [];
  for (let b = o.fromBlock || 0; b <= latest; b += chunk) {
    const to = Math.min(b + chunk - 1, latest);
    added.push(
      ...(await rules.queryFilter(rules.filters.TrustedContractAdded(), b, to)),
    );
  }
  const trusted = [...new Set(added.map((ev) => ev.args[0]))];
  let clean = true;
  for (const a of trusted) {
    if (!(await rules.isTrustedContract(a))) continue;
    if ((await ethers.provider.getCode(a)) !== "0x") continue;
    clean = false;
    add(`trusted address ${a} has code`, false);
  }
  if (clean) add("every trusted contract has code", true);
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
  planFor,
  core,
  addrOf,
  same,
  keyOf,
  hasLiveKey,
  issuerLabel,
  listManagerOf,
  preflight,
  assertHandoverComplete,
};
