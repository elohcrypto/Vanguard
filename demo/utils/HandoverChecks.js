/**
 * @fileoverview Handover ceremony: acceptance plan, shared helpers and the
 * preflight. Split from Handover.js (plan v2 Task 2C.2) to keep both files
 * under 500 lines; Handover.js re-exports everything callers used before.
 * The completion check lives in HandoverCompletion.js and the chain-derived
 * power set in HandoverPowers.js (plan v2 Task 2F.5).
 */

const { ethers } = require("hardhat");
const {
  eligibleVotersNow,
  voterAgeRefusal,
  walletControlRefusal,
} = require("./ChainTime");

const plan = (key, proposalType, label, typeName, opts = {}) => ({
  key,
  proposalType,
  label,
  typeName,
  // Optional entries are skipped when the caller passes no contract for them.
  optional: Boolean(opts.optional),
  // Governance setter that binds the type at step 3 (factories 2F.5,
  // privacy contracts 3.3).
  bind: opts.bind,
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
  // Optional (2F.5, M4): bound at step 3, once nominated to governance.
  plan(
    "escrowWalletFactory",
    9,
    "EscrowWalletFactory",
    "EscrowFactoryParameters",
    {
      optional: true,
      bind: "setEscrowWalletFactory",
    },
  ),
  plan(
    "onchainIDFactory",
    10,
    "OnchainIDFactory",
    "IdentityFactoryParameters",
    {
      optional: true,
      bind: "setOnchainIDFactory",
    },
  ),
  // Optional (3.3, R-3R-4): the privacy contracts, bound at step 3 like
  // the factories; HandoverPrivacy.js adds their own checks.
  plan("privacyManager", 11, "PrivacyManager", "PrivacyParameters", {
    optional: true,
    bind: "setPrivacyManager",
  }),
  plan("zkVerifier", 12, "ZKVerifierIntegrated", "VerifierParameters", {
    optional: true,
    bind: "setZKVerifier",
  }),
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
 * in its ABI, or the call reverts (an oracle without the role).
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
 * The optional InvestorTypeRegistry takes part only when governance is bound
 * to it (boundTarget(0)); otherwise its acceptance vote could never be
 * proposed. Returns `o` without it, recorded as `skippedRegistry` (warning
 * once via `log`). Preflight refuses the skip when the Token enforces that
 * registry; the completion check keeps a line for it.
 */
async function withBoundRegistry(o, log) {
  const reg = o.investorTypeRegistry;
  if (!reg) return o;
  const a = await addrOf(reg);
  if (same(await o.governance.boundTarget(0), a)) return o;
  if (log) {
    log(
      `   ⚠️  governance is not bound to InvestorTypeRegistry (${a}): left out of this handover (no vote can target it)`,
    );
  }
  return { ...o, investorTypeRegistry: undefined, skippedRegistry: reg };
}

/** True when the Token enforces `reg` (its investorTypeRegistry()). */
const liveOnToken = async (o, reg) =>
  same(await o.token.investorTypeRegistry(), await addrOf(reg));

/** ComplianceRules.WhitelistMode names, in enum order (Task 3.4). */
const MODE = ["OracleOnly", "ZkOnly", "Either"];

/**
 * VGT's whitelist mode name in the config's ComplianceRules, or null when
 * that ComplianceRules predates Task 3.4 (no getter). Only a revert means
 * "no getter"; anything else (an RPC failure) is rethrown.
 */
async function vgtWhitelistMode(o) {
  const vgt = await addrOf(o.governanceToken);
  try {
    return MODE[Number(await o.complianceRules.whitelistMode(vgt))];
  } catch (e) {
    if (e.code !== "CALL_EXCEPTION" && !/revert/i.test(e.message)) throw e;
    return null;
  }
}

/**
 * Review B-M2: one refusal per token whose compliance() is not the config's
 * ComplianceRules (empty when both match).
 */
async function complianceMismatches(o) {
  const rules = await addrOf(o.complianceRules);
  const out = [];
  for (const [label, t] of [
    ["Token (VSC)", o.token],
    ["GovernanceToken (VGT)", o.governanceToken],
  ]) {
    const used = await t.compliance();
    if (same(used, rules)) continue;
    out.push(
      `${label} ${await addrOf(t)} enforces ComplianceRules ${used} (compliance()), but the config names ComplianceRules ${rules}: name the one the token enforces, or move the token back by its owner (setCompliance) before the ceremony`,
    );
  }
  return out;
}

/**
 * Every precondition, read-only, before the ceremony's first transaction
 * (plan v2 Task 2E.2): refuse to start rather than stop halfway. Returns
 * { governanceOwned }: plan keys governance already owns (step 3 skips them).
 * `acceptOnly` (HANDOVER_PHASE=accept): only what the acceptance votes need.
 */
async function preflight(o, { acceptOnly = false } = {}) {
  const dAddr = await addrOf(o.deployer);
  const ops = await addrOf(o.ops);
  const guardian = await addrOf(o.guardian);
  const govAddr = await addrOf(o.governance);
  // A skipped registry the Token enforces would stay the deployer's: the
  // report would say "no power" while the deployer sets every holding cap.
  if (o.skippedRegistry && (await liveOnToken(o, o.skippedRegistry))) {
    fail(
      `governance is not bound to InvestorTypeRegistry ${await addrOf(o.skippedRegistry)}, which the Token enforces: ` +
        `redeploy governance after the registry, or point the Token at the registry governance is bound to (setInvestorTypeRegistry)`,
    );
  }
  // Distinct roles (review H1/H2): the ceremony strips the deployer's roles
  // and makes governance the owner, so a role held by either is lost or
  // silently kept.
  if (!acceptOnly) {
    for (const [role, who, other, why] of [
      [
        "guardian",
        guardian,
        dAddr,
        "the deployer would keep the power to pause VSC",
      ],
      ["ops", ops, dAddr, "step 5 would strip the roles it was just granted"],
      ["ops", ops, govAddr, "governance cannot sign as ops"],
      ["guardian", guardian, govAddr, "governance cannot sign as guardian"],
    ]) {
      if (same(who, other)) {
        const name = other === dAddr ? "deployer" : "governance";
        fail(
          `${role} ${who} is the ${name}: ${why}; configure a separate ${role} wallet`,
        );
      }
    }
  }
  if (await o.governanceToken.paused()) {
    fail(
      "VGT is paused: every acceptance vote would revert; the owner must unpause first",
    );
  }
  // Review B-M2: both tokens must enforce the ComplianceRules the ceremony
  // hands to governance, or governance would own a contract no token reads.
  for (const c of await complianceMismatches(o)) fail(c);
  // D23: a listed governance fails every VGT fee transfer (proposal and
  // vote fees, refunds), so no blacklist oracle may gate VGT.
  const vgtAddr = await addrOf(o.governanceToken);
  const vgtBlacklist = await o.complianceRules.blacklistOracle(vgtAddr);
  if (!same(vgtBlacklist, ethers.ZeroAddress)) {
    fail(
      `a blacklist oracle (${vgtBlacklist}) is bound to GovernanceToken: D23 forbids it (listing governance halts every fee flow); the ComplianceRules owner must setBlacklistOracle(VGT, 0) first`,
    );
  }
  // D33 (a), review B-M1: the same rule by another route. In ZkOnly or
  // Either every fee transfer needs a live whitelist binding, so the list
  // operator (ops after the handover) could halt governance by publishing
  // one root, and the acceptance votes below would revert halfway.
  const vgtMode = await vgtWhitelistMode(o);
  if (vgtMode === null) {
    fail(
      `ComplianceRules ${await addrOf(o.complianceRules)} has no whitelistMode(token) (predates Task 3.4): redeploy it before the ceremony`,
    );
  }
  if (vgtMode !== "OracleOnly") {
    fail(
      `GovernanceToken ${vgtAddr} is in whitelist mode ${vgtMode}: D33 allows only OracleOnly on VGT (in a ZK mode every vote and proposal fee needs a whitelist binding, so the list operator, ops after the handover, could halt every governance fee flow by publishing one root); the ComplianceRules owner must setWhitelistMode(VGT, 0) (OracleOnly) before the ceremony`,
    );
  }
  // Governance must be bound to every contract it is about to own, or the
  // acceptOwnership vote in step 4 can never be proposed. Factories are
  // bound at step 3 (HandoverPowers.js checks them).
  for (const e of planFor(o).filter((x) => x.key !== "governance" && !x.bind)) {
    const want = await addrOf(o[e.key]);
    const got = await o.governance.boundTarget(e.proposalType);
    if (!same(got, want)) {
      fail(
        `governance is not bound to ${e.label} (${want}); boundTarget(${e.proposalType}) = ${got}. ` +
          `Governance must be deployed after ${e.label}; redeploy it.`,
      );
    }
  }
  // D21: the acceptance votes pull VGT fees into governance. A pre-D21 or
  // half-deployed governance would revert them after step 1 already ran.
  // Trust is per token since Task 4.1 (G5): governance needs it on VGT.
  const vgt = await addrOf(o.governanceToken);
  if (
    !(await o.complianceRules["isTrustedContract(address,address)"](
      vgt,
      govAddr,
    ))
  ) {
    fail(
      `governance ${govAddr} is not a trusted contract on VGT ${vgt}: the ComplianceRules owner must addTrustedContract(VGT, governance) first`,
    );
  }
  if (!same(await o.identityRegistry.identity(govAddr), ethers.ZeroAddress)) {
    fail(
      `governance ${govAddr} has a registry identity: a registry agent must deleteIdentity(governance) first; governance holds fees as a trusted contract, D21`,
    );
  }
  const governanceOwned = new Set();
  if (acceptOnly) {
    // An interrupted step 3 leaves contracts un-nominated: their votes would
    // be paid for and then fail, and a full re-run is refused.
    const missing = [];
    for (const e of planFor(o)) {
      const c = o[e.key];
      if (same(await c.owner(), govAddr)) continue;
      if (!same(await c.pendingOwner(), govAddr)) missing.push(e.label);
    }
    if (missing.length) {
      fail(
        `accept phase: governance is not nominated on ${missing.join(", ")}; step 3 did not run for them (run the full phase, or nominate as their owner)`,
      );
    }
    return { governanceOwned };
  }
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
  // Review 3.9 L3: a stray rule administrator is refused while the
  // deployer can still revoke it in one transaction (completion checks it
  // again). Required here, not at the top: HandoverScans requires this file.
  const { liveRuleAdministrators } = require("./HandoverScans");
  const stray = (await liveRuleAdministrators(o, [dAddr])).filter(
    ({ account: a }) => !same(a, dAddr) && !same(a, ops) && !same(a, govAddr),
  );
  if (stray.length) {
    const list = stray.map((x) => `${x.account} on ${x.token}`).join(", ");
    fail(
      `ComplianceRules rule administrator(s) ${list} besides the deployer, ops and governance: after the handover they could set that token's jurisdiction rule (and lapse every private jurisdiction record); the ComplianceRules owner must setRuleAdministrator(<token>, <address>, false) first`,
    );
  }
  // Issuers the deployer holds go to issuerAdmin, never ops (D25 b).
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
    if (typeof o.issuerAdmin?.signMessage !== "function") {
      fail(`issuerAdmin must be a signer to accept ownership of ${label}`);
    }
    // addIssuerKey reverts "Key already exists" for any issuerAdmin key that
    // is not a live MANAGEMENT_KEY, after step 1 has already sent transactions.
    const admin = await addrOf(o.issuerAdmin);
    const k = await issuer.issuerKeys(keyOf(admin));
    const liveManagement = Number(k.purpose) === MANAGEMENT_KEY && !k.revoked;
    if (k.key !== ethers.ZeroHash && !liveManagement) {
      fail(
        `issuerAdmin ${admin} already holds a ${k.revoked ? "revoked" : `purpose-${k.purpose}`} key on ${label}; ` +
          `a revoked or other-purpose key cannot be re-added as MANAGEMENT_KEY, so use a different issuerAdmin key or a new issuer`,
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

/**
 * The proposer and every voter must be able to pay for `count` proposals
 * before step 1 sends anything: verified, not frozen, and enough free VGT
 * (proposalCreationCost each for the proposer, votingCost each per voter).
 */
async function checkVoters(o, proposer, voters, count) {
  if (count === 0) return;
  const n = BigInt(count);
  const pAddr = await addrOf(proposer);
  const vAddrs = await Promise.all(voters.map(addrOf));
  const dup = vAddrs.find((a, i) => vAddrs.findIndex((b) => same(a, b)) !== i);
  if (dup) fail(`voter ${dup} is listed twice; each wallet votes once`);
  // Quorum as on chain: votes * 10000 >= eligible (aged identities, D25) * quorum.
  const eligible = await eligibleVotersNow(o.governance, o.identityRegistry);
  for (const e of planFor(o)) {
    const q = (await o.governance.proposalThresholds(e.proposalType))
      .quorumPercentage;
    if (BigInt(vAddrs.length) * 10000n < eligible * q) {
      fail(
        `${vAddrs.length} voter(s) cannot reach the ${e.typeName} quorum (${Number(q) / 100}% of ${eligible} registered identities old enough to vote); add voters`,
      );
    }
  }
  // A whitelist oracle on VGT gates the fee transfers of every party.
  const wl = await o.complianceRules.whitelistOracle(
    await addrOf(o.governanceToken),
  );
  const wlOracle = same(wl, ethers.ZeroAddress)
    ? null
    : await ethers.getContractAt(
        ["function isWhitelisted(address) view returns (bool)"],
        wl,
      );
  const need = [
    [pAddr, "proposer", (await o.governance.proposalCreationCost()) * n],
  ];
  const vote = (await o.governance.votingCost()) * n;
  for (const a of vAddrs) {
    if (same(a, pAddr))
      fail(
        `voter ${a} is the proposer; a proposer cannot vote on its own proposal`,
      );
    need.push([a, "voter", vote]);
  }
  const vgt = o.governanceToken;
  for (const [a, role, amount] of need) {
    if (wlOracle && !(await wlOracle.isWhitelisted(a))) {
      fail(
        `${role} ${a} is not on the whitelist oracle bound to VGT (${wl}); its fee transfer would fail`,
      );
    }
    if (!(await o.identityRegistry.isVerified(a))) {
      fail(
        `${role} ${a} is not verified in the IdentityRegistry; governance refuses its ${role === "voter" ? "vote" : "proposal"}`,
      );
    }
    const why =
      (await voterAgeRefusal(o.governance, o.identityRegistry, a)) ||
      (await walletControlRefusal(o.identityRegistry, a));
    if (why) fail(`${role} ${a} ${why}`);
    if (await vgt.isFrozen(a)) fail(`${role} ${a} is frozen on VGT`);
    const free = await vgt.getFreeBalance(a);
    if (free < amount) {
      fail(
        `${role} ${a} holds ${ethers.formatEther(free)} free VGT; ${count} proposal(s) need ${ethers.formatEther(amount)}`,
      );
    }
  }
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
  withBoundRegistry,
  preflight,
  checkVoters,
  liveOnToken,
  MODE,
  vgtWhitelistMode,
  complianceMismatches,
  fail,
};
