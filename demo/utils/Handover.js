/**
 * @fileoverview Handover ceremony: the deployer gives up every power it holds.
 * @module Handover
 * @description Plan v2 Task 2C.1 (.omc/plans/2026-09-25-zk-kyc-ownership-cleanup-v2.md).
 * One implementation shared by demo options 83c/83d/83e, scripts/handover.ts,
 * scripts/demo-smoke-handover.js and test/production/Handover.test.ts.
 *
 * Order: (1) grant ops/guardian, hand over issuers; (2) oracles to ops; (5)
 * deployer drops its roles; (3) nominate governance; (4) accept by vote.
 * Every transaction is followed by a state assertion; any mismatch throws.
 */

const { ethers } = require("hardhat");
const { advancePast } = require("./ChainTime");

const MANAGEMENT_KEY = 1;
const ECDSA_TYPE = 1;
const STATUS = [
  "Pending",
  "Active",
  "Approved",
  "Rejected",
  "Executed",
  "Cancelled",
];
const EXECUTED = 4;

const plan = (key, proposalType, label, typeName) => ({
  key,
  proposalType,
  label,
  typeName,
});
/** One acceptOwnership() vote per contract governance was nominated for. */
const ACCEPTANCE_PLAN = [
  plan("token", 3, "Token", "TokenParameters"),
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
/** [contract, label] for the five contracts governance ends up owning. */
const core = (o) => ACCEPTANCE_PLAN.map((e) => [o[e.key], e.label]);

const OWNABLE = new ethers.Interface([
  "function acceptOwnership()",
  "function setComplianceOfficer(address,bool)",
]);

async function addrOf(x) {
  if (typeof x === "string") return x;
  if (x.getAddress) return x.getAddress();
  return x.address;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const keyOf = (a) => ethers.keccak256(ethers.solidityPacked(["address"], [a]));

function check(cond, msg) {
  if (!cond) throw new Error(`Handover: ${msg}`);
}

async function send(p) {
  return (await p).wait();
}

/** True when `wallet` holds a non-revoked key of any purpose on the issuer. */
async function hasLiveKey(issuer, wallet) {
  const k = await issuer.issuerKeys(keyOf(wallet));
  return k.key !== ethers.ZeroHash && !k.revoked;
}

async function hasLiveManagementKey(issuer, wallet) {
  const k = await issuer.issuerKeys(keyOf(wallet));
  return (
    k.key !== ethers.ZeroHash &&
    Number(k.purpose) === MANAGEMENT_KEY &&
    !k.revoked
  );
}

async function issuerLabel(issuer) {
  const name = await issuer.issuerName().catch(() => "");
  return `${name || "ClaimIssuer"} (${await issuer.getAddress()})`;
}

/**
 * Plan steps 1, 2, 5, 3. Returns a report; throws on the first mismatch.
 * `registryProposals` lists InvestorTypeRegistry calls the deployer could not
 * make because governance already owns the registry: settle them by vote.
 */
async function handoverDeployerPowers(o) {
  const log = o.log || console.log;
  const d = o.deployer;
  const dAddr = await addrOf(d);
  const ops = await addrOf(o.ops);
  const guardian = await addrOf(o.guardian);
  const govAddr = await addrOf(o.governance);
  const report = { steps: [], registryProposals: [] };
  const ok = (m) => {
    report.steps.push(m);
    log(`   ✅ ${m}`);
  };

  // Governance must be bound to every contract it is about to own, or the
  // acceptOwnership vote in step 4 can never be proposed. Checked before any
  // transaction so a mis-ordered deployment leaves no partial handover.
  for (const e of ACCEPTANCE_PLAN.filter((x) => x.key !== "governance")) {
    const want = await addrOf(o[e.key]);
    const got = await o.governance.boundTarget(e.proposalType);
    check(
      same(got, want),
      `governance is not bound to ${e.label} (${want}); boundTarget(${e.proposalType}) = ${got}. ` +
        `Governance must be deployed after ${e.label}; redeploy it.`,
    );
  }
  for (const [c, label] of core(o)) {
    const owner = await c.owner();
    check(
      same(owner, dAddr),
      `deployer ${dAddr} does not own ${label} (owner ${owner}); the handover was already run or needs another key`,
    );
  }
  const ctx = { o, d, dAddr, govAddr, report, ok, log };
  // Send, read back, assert, print.
  const apply = async (tx, readBack, msg) => {
    await send(tx);
    check(await readBack(), `${msg}: state did not change`);
    ok(msg);
  };

  log("\n📝 Step 1: deployer grants ops and guardian");
  await apply(
    o.token.connect(d).addAgent(ops),
    () => o.token.isAgent(ops),
    `Token agent: ${ops}`,
  );
  await apply(
    o.identityRegistry.connect(d).addAgent(ops),
    () => o.identityRegistry.isAgent(ops),
    `IdentityRegistry agent: ${ops}`,
  );
  if (o.investorTypeRegistry) {
    await registryOfficer(ctx, ops, true);
  }
  await apply(
    o.token.connect(d).setGuardian(guardian),
    async () => same(await o.token.guardian(), guardian),
    `Token guardian: ${guardian}`,
  );
  await apply(
    o.complianceRules.connect(d).setRuleAdministrator(govAddr, true),
    () => o.complianceRules.ruleAdministrators(govAddr),
    `ComplianceRules rule administrator: governance ${govAddr}`,
  );

  for (const issuer of o.issuers || []) {
    const label = await issuerLabel(issuer);
    const isOwner = same(await issuer.owner(), dAddr);
    const hasKey = await hasLiveKey(issuer, dAddr);
    if (!isOwner && !hasKey) {
      log(`   ℹ️  deployer holds no key on ${label}: nothing to hand over`);
      continue;
    }
    check(
      isOwner,
      `deployer holds a key on ${label} but is not its owner (${await issuer.owner()}); its owner must run this issuer's handover`,
    );
    if (!(await hasLiveManagementKey(issuer, ops))) {
      await send(
        issuer.connect(d).addIssuerKey(keyOf(ops), MANAGEMENT_KEY, ECDSA_TYPE),
      );
    }
    // Ownership moves BEFORE the deployer key is revoked: onlyManagementKey
    // also admits the owner, so the owner is the last-resort manager.
    await send(issuer.connect(d).transferOwnership(ops));
    check(same(await issuer.owner(), ops), `${label} owner is not ops`);
    check(
      await hasLiveManagementKey(issuer, ops),
      `ops holds no live MANAGEMENT_KEY on ${label}; refusing to revoke the deployer key`,
    );
    if (hasKey) {
      check(
        typeof o.ops.signMessage === "function",
        `ops must be a signer to revoke the deployer key on ${label}`,
      );
      await send(issuer.connect(o.ops).revokeIssuerKey(keyOf(dAddr)));
    }
    check(
      !(await hasLiveKey(issuer, dAddr)),
      `deployer key still live on ${label}`,
    );
    ok(`${label}: owner ops, ops MANAGEMENT_KEY live, deployer key revoked`);
  }

  log("\n📝 Step 2: oracles to ops");
  for (const oracle of o.oracles || []) {
    const a = await oracle.getAddress();
    if (!same(await oracle.owner(), ops)) {
      await send(oracle.connect(d).transferOwnership(ops));
    }
    check(same(await oracle.owner(), ops), `oracle ${a} owner is not ops`);
    ok(`oracle ${a} owner: ops`);
  }

  log("\n📝 Step 5: deployer removes its own roles");
  await apply(
    o.token.connect(d).removeAgent(dAddr),
    async () => !(await o.token.isAgent(dAddr)),
    "deployer removed as Token agent",
  );
  await apply(
    o.identityRegistry.connect(d).removeAgent(dAddr),
    async () => !(await o.identityRegistry.isAgent(dAddr)),
    "deployer removed as IdentityRegistry agent",
  );
  await apply(
    o.complianceRules.connect(d).setRuleAdministrator(dAddr, false),
    async () => !(await o.complianceRules.ruleAdministrators(dAddr)),
    "deployer removed as ComplianceRules rule administrator",
  );
  if (o.investorTypeRegistry) {
    await registryOfficer(ctx, dAddr, false);
  }

  log("\n📝 Step 3: nominate governance as owner");
  for (const [c, label] of core(o)) {
    await send(c.connect(d).transferOwnership(govAddr));
    check(
      same(await c.pendingOwner(), govAddr),
      `${label} pendingOwner is not governance`,
    );
    ok(`${label}: pendingOwner = governance`);
  }
  return report;
}

/**
 * InvestorTypeRegistry.setComplianceOfficer(who, flag). Direct when the
 * deployer still owns the registry; queued as an InvestorTypeConfig proposal
 * (loudly) when governance already owns it (option 83b ran first).
 */
async function registryOfficer(ctx, who, flag) {
  const { o, d, dAddr, govAddr, report, ok, log } = ctx;
  const reg = o.investorTypeRegistry;
  const owner = await reg.owner();
  const what = `InvestorTypeRegistry compliance officer ${who} = ${flag}`;
  if (same(owner, dAddr)) {
    await send(reg.connect(d).setComplianceOfficer(who, flag));
    check(
      (await reg.isComplianceOfficer(who)) === flag,
      `${what} did not apply`,
    );
    ok(what);
  } else if (same(owner, govAddr)) {
    if ((await reg.isComplianceOfficer(who)) === flag)
      return ok(`${what} (already)`);
    report.registryProposals.push({
      label: what,
      proposalType: 0,
      target: await reg.getAddress(),
      callData: OWNABLE.encodeFunctionData("setComplianceOfficer", [who, flag]),
    });
    log(
      `   ⚠️  ${what}: governance owns the registry, queued as an InvestorTypeConfig proposal`,
    );
  } else {
    check(
      false,
      `InvestorTypeRegistry is owned by ${owner}, neither deployer nor governance`,
    );
  }
}

const vgtOf = async (g) =>
  ethers.getContractAt("GovernanceToken", await g.governanceToken());

/** Create a proposal; returns its id. Approves the creation fee first. */
async function proposeCall(
  governance,
  proposer,
  proposalType,
  target,
  callData,
  title,
) {
  const vgt = await vgtOf(governance);
  const govAddr = await governance.getAddress();
  await send(
    vgt
      .connect(proposer)
      .approve(govAddr, await governance.proposalCreationCost()),
  );
  const before = await governance.proposalCount();
  await send(
    governance
      .connect(proposer)
      .createProposal(
        proposalType,
        title,
        `${title} (handover ceremony)`,
        await addrOf(target),
        callData,
      ),
  );
  const id = await governance.proposalCount();
  check(id === before + 1n, `proposal for "${title}" was not created`);
  return Number(id);
}

async function proposeAcceptOwnership(
  governance,
  proposer,
  target,
  proposalType,
  label,
) {
  return proposeCall(
    governance,
    proposer,
    proposalType,
    target,
    OWNABLE.encodeFunctionData("acceptOwnership"),
    `Accept ownership of ${label}`,
  );
}

async function castAcceptanceVotes(governance, proposalId, voters) {
  const vgt = await vgtOf(governance);
  const govAddr = await governance.getAddress();
  const cost = await governance.votingCost();
  for (const v of voters) {
    await send(vgt.connect(v).approve(govAddr, cost));
    await send(
      governance.connect(v).castVote(proposalId, true, "Support handover"),
    );
  }
}

/**
 * Wait out voting and the execution delay, then execute. Throws (with
 * err.code "NOT_PASSED" or "NOT_EXECUTED") unless the proposal Executed.
 */
async function settleProposal(
  governance,
  proposalId,
  label = `proposal #${proposalId}`,
) {
  const [p] = await governance.getProposal(proposalId);
  await advancePast(
    p.executionTime > p.votingEnds ? p.executionTime : p.votingEnds,
    `${label}: voting period + execution delay`,
  );
  const [, , , canExecute] = await governance.getProposal(proposalId);
  const fail = (code, why) =>
    Object.assign(
      new Error(`Handover: proposal #${proposalId} (${label}) ${why}`),
      { code },
    );
  if (!canExecute) throw fail("NOT_PASSED", "did not clear quorum/approval");
  await send(governance.executeProposal(proposalId));
  const [after] = await governance.getProposal(proposalId);
  const status = Number(after.status);
  if (status !== EXECUTED) {
    throw fail("NOT_EXECUTED", `settled as ${STATUS[status]}, not Executed`);
  }
  return status;
}

/**
 * Step 4 for every ACCEPTANCE_PLAN contract nominated to governance, then
 * any queued registry proposals. `contracts` maps plan keys to contracts.
 */
async function acceptAllByVote({
  governance,
  contracts,
  proposer,
  voters,
  registryProposals = [],
  log = console.log,
}) {
  const govAddr = await governance.getAddress();
  const vote = async (id, label) => {
    await castAcceptanceVotes(governance, id, voters);
    await settleProposal(governance, id, label);
  };
  for (const e of ACCEPTANCE_PLAN) {
    const c = contracts[e.key];
    check(c, `no contract given for ${e.label}`);
    if (same(await c.owner(), govAddr)) {
      log(`   ✅ ${e.label}: already owned by governance`);
      continue;
    }
    check(
      same(await c.pendingOwner(), govAddr),
      `${e.label} has not nominated governance`,
    );
    const id = await proposeAcceptOwnership(
      governance,
      proposer,
      c,
      e.proposalType,
      e.label,
    );
    await vote(id, e.label);
    check(
      same(await c.owner(), govAddr),
      `${e.label} owner is not governance after the vote`,
    );
    log(`   ✅ ${e.label}: owned by governance (proposal #${id})`);
  }
  for (const r of registryProposals) {
    const id = await proposeCall(
      governance,
      proposer,
      r.proposalType,
      r.target,
      r.callData,
      r.label,
    );
    await vote(id, r.label);
    log(`   ✅ ${r.label} (proposal #${id})`);
  }
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
    "deployer is not an IdentityRegistry agent",
    !(await o.identityRegistry.isAgent(dAddr)),
  );
  add(
    "deployer is not a ComplianceRules rule administrator",
    !(await o.complianceRules.ruleAdministrators(dAddr)),
  );
  add("ops is a Token agent", await o.token.isAgent(ops));
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
  handoverDeployerPowers,
  proposeCall,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  acceptAllByVote,
  assertHandoverComplete,
};
