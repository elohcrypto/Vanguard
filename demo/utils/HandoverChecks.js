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
  const opsSigns = typeof o.ops.signMessage === "function";
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
  // D23: a listed governance fails every VGT fee transfer (proposal and
  // vote fees, refunds), so no blacklist oracle may gate VGT.
  const vgtAddr = await addrOf(o.governanceToken);
  const vgtBlacklist = await o.complianceRules.blacklistOracle(vgtAddr);
  if (!same(vgtBlacklist, ethers.ZeroAddress)) {
    fail(
      `a blacklist oracle (${vgtBlacklist}) is bound to GovernanceToken: D23 forbids it (listing governance halts every fee flow); the ComplianceRules owner must setBlacklistOracle(VGT, 0) first`,
    );
  }
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
  // D21: the acceptance votes pull VGT fees into governance. A pre-D21 or
  // half-deployed governance would revert them after step 1 already ran.
  if (!(await o.complianceRules.isTrustedContract(govAddr))) {
    fail(
      `governance ${govAddr} is not a trusted contract: the ComplianceRules owner must addTrustedContract(governance) first`,
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
  // Quorum as the contract counts it: votes * 10000 >= eligible * quorum,
  // eligible = registered identities (the proposer cannot vote).
  const eligible = await o.identityRegistry.registeredIdentityCount();
  for (const e of planFor(o)) {
    const q = (await o.governance.proposalThresholds(e.proposalType))
      .quorumPercentage;
    if (BigInt(vAddrs.length) * 10000n < eligible * q) {
      fail(
        `${vAddrs.length} voter(s) cannot reach the ${e.typeName} quorum (${Number(q) / 100}% of ${eligible} registered identities); add voters`,
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
    if (await vgt.isFrozen(a)) fail(`${role} ${a} is frozen on VGT`);
    const free = await vgt.getFreeBalance(a);
    if (free < amount) {
      fail(
        `${role} ${a} holds ${ethers.formatEther(free)} free VGT; ${count} proposal(s) need ${ethers.formatEther(amount)}`,
      );
    }
  }
}

/** Read-only verification. Returns { ok, failures, checks }; never pauses. */
async function assertHandoverComplete(o) {
  o = await withBoundRegistry(o);
  const dAddr = await addrOf(o.deployer);
  const ops = await addrOf(o.ops);
  const guardian = await addrOf(o.guardian);
  const govAddr = await addrOf(o.governance);
  const checks = [];
  const add = (label, pass) => checks.push({ label, ok: Boolean(pass) });
  if (o.skippedRegistry) {
    add(
      "InvestorTypeRegistry is not live on Token or is owned by governance",
      !(await liveOnToken(o, o.skippedRegistry)) ||
        same(await o.skippedRegistry.owner(), govAddr),
    );
  }

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
  add(
    "Token guardian is not the deployer",
    !same(await o.token.guardian(), dAddr),
  );
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
  add(
    "no blacklist oracle bound to GovernanceToken (D23)",
    same(
      await o.complianceRules.blacklistOracle(await addrOf(o.governanceToken)),
      ethers.ZeroAddress,
    ),
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
  // D21: governance holds VGT fees as a trusted contract, never as an
  // identity (a contract identity's claims lapse and ops could delete it).
  add(
    "governance is a trusted contract",
    await rules.isTrustedContract(govAddr),
  );
  add(
    "governance has no registry identity",
    same(await o.identityRegistry.identity(govAddr), ethers.ZeroAddress),
  );
  // Residue from runs before 2E.1, when a wallet could be trusted. Scanned
  // in chunks: public RPCs cap the eth_getLogs block range, so a range error
  // halves the chunk (floor 100) and retries; any other error is rethrown.
  let chunk = o.logChunk || 5000;
  const latest = await ethers.provider.getBlockNumber();
  const added = [];
  for (let b = o.fromBlock || 0; b <= latest;) {
    const to = Math.min(b + chunk - 1, latest);
    try {
      added.push(
        ...(await rules.queryFilter(
          rules.filters.TrustedContractAdded(),
          b,
          to,
        )),
      );
      b = to + 1;
    } catch (e) {
      // Block-range refusals only; a rate limit is rethrown, not halved.
      const rangeError =
        /block range|range too large|exceeds.*(range|limit)|too many (blocks|results)|query returned more than/i;
      if (chunk <= 100 || !rangeError.test(e.message)) throw e;
      chunk = Math.max(100, Math.floor(chunk / 2));
    }
  }
  const trusted = [...new Set(added.map((ev) => ev.args[0]))];
  let clean = true;
  for (const a of trusted) {
    if (!(await rules.isTrustedContract(a))) continue;
    const code = await ethers.provider.getCode(a);
    // An EIP-7702 delegation indicator (0xef0100 || address, 23 bytes) is a
    // wallet, not a contract: treat it the same as no code.
    const delegated = code.length === 48 && /^0xef0100/i.test(code);
    if (code !== "0x" && !delegated) continue;
    clean = false;
    add(`trusted address ${a} is a wallet or delegated wallet`, false);
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
  withBoundRegistry,
  preflight,
  checkVoters,
  assertHandoverComplete,
};
