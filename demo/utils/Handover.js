/**
 * @fileoverview Handover ceremony: the deployer gives up every power it holds.
 * @module Handover
 * @description Plan v2 Task 2C.1 (.omc/plans/2026-09-25-zk-kyc-ownership-cleanup-v2.md).
 * One implementation shared by demo options 83c/83d/83e, scripts/handover.ts,
 * scripts/demo-smoke-handover.js and test/production/Handover.test.ts.
 * Task 2C.2 adds GovernanceToken (VGT); the plan and the read-only check
 * live in HandoverChecks.js.
 *
 * Order: (1) grant ops/guardian, hand over issuers; (2) oracles to ops; (5)
 * deployer drops its roles; (3) nominate governance; (4) accept by vote.
 * Task 2E.2: preflight (HandoverChecks.js) checks every precondition before
 * the first transaction; step 1 clears any VGT guardian and step 2 moves an
 * oracle list-manager role off the deployer (to the DynamicListManager, else
 * zero). Every transaction is followed by a state assertion; any mismatch throws.
 * Task 2F.5: the power set is read from chain (HandoverPowers.js), issuers go
 * to issuerAdmin (never ops, D25 b), both factories are nominated, bound and
 * accepted, and the completion check is HandoverCompletion.js.
 * Task 3.3: PrivacyManager and ZKVerifierIntegrated join the same way
 * (types 11, 12; HandoverPrivacy.js), ops becomes PrivacyManager's
 * listOperator.
 */

const { ethers } = require("hardhat");
const {
  ACCEPTANCE_PLAN,
  planFor,
  addrOf,
  same,
  listManagerOf,
  withBoundRegistry,
  preflight,
} = require("./HandoverChecks");
const {
  withDerivedPowers,
  checkIssuerAdmin,
  preflightPowers,
  handOverIssuers,
  bindFactory,
  factorySteps,
} = require("./HandoverPowers");
const { assertHandoverComplete } = require("./HandoverCompletion");
const { preflightPrivacy, privacySteps } = require("./HandoverPrivacy");
const { preflightKeyManager } = require("./HandoverKeys");
const { preflightRegistrars } = require("./HandoverRegistrars");
const { preflightOracles, oracleSteps } = require("./HandoverOracles");
const { withDerivedContracts, preflightLinks } = require("./HandoverDerive");
const { preflightHolders } = require("./HandoverHolders");
const { preflightRoles } = require("./HandoverRoles");
const { preflightTrust } = require("./HandoverTrust");
const { preflightNodes, nodeSteps } = require("./HandoverNodes");
const { preflightParams, paramSteps } = require("./HandoverParams");
const { snapshotFacts, preflightSnapshots } = require("./HandoverSnapshot");
const { preflightEscrow } = require("./HandoverEscrow");
const { recordingSigner } = require("./HandoverWindow");
const { roleStrays } = require("./HandoverRoles");
const { trustStrays } = require("./HandoverTrust");
const { nodeStrays } = require("./HandoverNodes");
const {
  proposeCall,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  acceptAllByVote,
  checkVoters,
} = require("./HandoverVotes");

const OWNABLE = new ethers.Interface([
  "function setComplianceOfficer(address,bool)",
  "function setGovernor(address,bool,uint256)",
]);

function check(cond, msg) {
  if (!cond) throw new Error(`Handover: ${msg}`);
}

async function send(p) {
  return (await p).wait();
}

/**
 * Plan steps 1, 2, 5, 3. Returns a report; throws on the first mismatch.
 * `registryProposals` lists InvestorTypeRegistry calls the deployer could not
 * make because governance already owns the registry: settle them by vote.
 */
async function handoverDeployerPowers(o) {
  const given = o; // M-1: the caller's object carries the snapshot afterwards
  const log = o.log || console.log;
  // Task 4.17 (review B-1, B-3): the window starts here, before any
  // read: the block and the deployer's nonce at it. Completion scans the
  // events after this block and counts the deployer's transactions.
  const preflightBlock = await ethers.provider.getBlockNumber();
  const preflightNonce = await ethers.provider.getTransactionCount(
    await addrOf(o.deployer),
    preflightBlock,
  );
  // Task 4.13: every contract derived from governance; a config address
  // is an assertion (HandoverDerive.js).
  o = await withDerivedContracts(o, log);
  o = await withBoundRegistry(o, log);
  // Oracles and issuers bound on chain; a config list must equal that set.
  o = await withDerivedPowers(o, log);
  await checkIssuerAdmin(o);
  let d = o.deployer;
  const dAddr = await addrOf(d);
  const ops = await addrOf(o.ops);
  const guardian = await addrOf(o.guardian);
  const govAddr = await addrOf(o.governance);
  const report = { steps: [], registryProposals: [] };
  const ok = (m) => {
    report.steps.push(m);
    log(`   ✅ ${m}`);
  };

  // Read-only; throws before any transaction when a precondition fails.
  const { governanceOwned } = await preflight(o);
  // Task 4.16 (D47): a whitelist oracle bound to VSC must list every holder.
  await preflightHolders(o, (w) => log(`   ⚠️  ${w}`));
  await preflightLinks(o); // Task 4.13: A1 H2/H3, M1, D56
  await preflightPowers(o, { governanceOwned });
  await preflightRoles(o); // Task 4.13: exact role sets (A1 H1)
  await preflightPrivacy(o);
  await preflightKeyManager(o);
  await preflightRegistrars(o); // Task 4.3
  await preflightTrust(o); // Task 4.13: trusted contracts by provenance
  await preflightOracles(o); // Task 4.4
  await preflightNodes(o); // Task 4.13: nodes, designations, list oracles
  await preflightParams(o); // Task 4.13: floors, proposals, fee sink, pins
  await preflightEscrow(o); // Task 4.17: escrow investors, fee wallet
  // Task 4.13: what the preflight found; completion compares with it.
  report.preflightBlock = preflightBlock;
  report.snapshot = await snapshotFacts(o);
  given.snapshot = report.snapshot;
  preflightSnapshots.set(govAddr.toLowerCase(), report.snapshot);
  // Task 4.17 (BF-3): every transaction the ceremony sends from here is
  // recorded; completion refuses window activity that is not among them.
  report.snapshot.block = preflightBlock;
  report.snapshot.nonce = preflightNonce;
  report.snapshot.ceremonyTxs = [];
  d = recordingSigner(d, report.snapshot.ceremonyTxs);
  o = { ...o, deployer: d };
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
  // No guardian on VGT: halting governance is not the guardian's power (D19).
  if (!same(await o.governanceToken.guardian(), ethers.ZeroAddress)) {
    await apply(
      o.governanceToken.connect(d).setGuardian(ethers.ZeroAddress),
      async () => same(await o.governanceToken.guardian(), ethers.ZeroAddress),
      "VGT guardian cleared: no guardian may pause the vote token; " +
        "a VGT pause blocks every vote until ops or a pre-voted unpause releases it",
    );
  }
  await apply(
    o.governanceToken.connect(d).addAgent(ops),
    () => o.governanceToken.isAgent(ops),
    `GovernanceToken agent: ${ops}`,
  );
  const regSteps = o.investorTypeRegistry
    ? registrySteps(o.investorTypeRegistry, dAddr, ops)
    : [];
  if (regSteps.length) await registryCall(ctx, regSteps[0]);
  await apply(
    o.token.connect(d).setGuardian(guardian),
    async () => same(await o.token.guardian(), guardian),
    `Token guardian: ${guardian}`,
  );
  // Rule administrators are per token since Task 4.1 (G5).
  const ruleTokens = [
    ["VSC", await addrOf(o.token)],
    ["VGT", await addrOf(o.governanceToken)],
  ];
  for (const [label, t] of ruleTokens) {
    await apply(
      o.complianceRules.connect(d).setRuleAdministrator(t, govAddr, true),
      () => o.complianceRules.ruleAdministrators(t, govAddr),
      `ComplianceRules rule administrator on ${label}: governance ${govAddr}`,
    );
  }
  // The manager's writes by vote need governance as its governanceContract.
  const dlm = o.dynamicListManager;
  if (dlm && !same(await dlm.governanceContract(), govAddr)) {
    await apply(
      dlm.connect(d).setGovernanceContract(govAddr),
      async () => same(await dlm.governanceContract(), govAddr),
      `DynamicListManager governanceContract: governance ${govAddr}`,
    );
  }

  await handOverIssuers(ctx);

  log("\n📝 Step 2: oracles to ops");
  for (const oracle of o.oracles || []) {
    const a = await oracle.getAddress();
    // The deployer must not keep the list-writer role once ops owns the oracle.
    if (same((await listManagerOf(oracle)) || ethers.ZeroAddress, dAddr)) {
      const to = dlm ? await dlm.getAddress() : ethers.ZeroAddress;
      await apply(
        oracle.connect(d).setListManager(to),
        async () => same(await oracle.listManager(), to),
        `oracle ${a} listManager moved off the deployer to ${to}`,
      );
    }
    if (!same(await oracle.owner(), ops)) {
      await send(oracle.connect(d).transferOwnership(ops));
    }
    check(same(await oracle.owner(), ops), `oracle ${a} owner is not ops`);
    ok(`oracle ${a} owner: ops`);
  }
  await oracleSteps(ctx); // Task 4.4: ops is OracleManager's operator

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
    o.governanceToken.connect(d).removeAgent(dAddr),
    async () => !(await o.governanceToken.isAgent(dAddr)),
    "deployer removed as GovernanceToken agent",
  );
  for (const [label, t] of ruleTokens) {
    await apply(
      o.complianceRules.connect(d).setRuleAdministrator(t, dAddr, false),
      async () => !(await o.complianceRules.ruleAdministrators(t, dAddr)),
      `deployer removed as ComplianceRules rule administrator on ${label}`,
    );
  }
  await factorySteps(ctx);
  await privacySteps(ctx);
  await nodeSteps(ctx); // Task 4.13: deployer-era emergency designations
  await paramSteps(ctx); // Task 4.13: factory feeRecipient to ops (D54)
  for (const step of regSteps.slice(1)) await registryCall(ctx, step);

  log("\n📝 Step 3: nominate governance as owner");
  for (const e of planFor(o)) {
    const [c, label] = [o[e.key], e.label];
    if (governanceOwned.has(e.key)) {
      ok(`${label}: already owned by governance`);
      continue;
    }
    await send(c.connect(d).transferOwnership(govAddr));
    check(
      same(await c.pendingOwner(), govAddr),
      `${label} pendingOwner is not governance`,
    );
    ok(`${label}: pendingOwner = governance`);
    // Factories: bound to their type now, while the deployer owns governance.
    if (e.bind) await bindFactory(ctx, e);
  }
  return report;
}

/**
 * The InvestorTypeRegistry calls of the ceremony, in order: ops becomes a
 * compliance officer (step 1), the deployer stops being one and stops being
 * a governor (step 5). `done()` is true once the call has taken effect.
 */
function registrySteps(reg, dAddr, ops) {
  const officer = (who, flag) => ({
    what: `InvestorTypeRegistry compliance officer ${who} = ${flag}`,
    done: async () => (await reg.isComplianceOfficer(who)) === flag,
    fn: "setComplianceOfficer",
    args: [who, flag],
  });
  const steps = [officer(ops, true), officer(dAddr, false)];
  if (typeof reg.isGovernor === "function") {
    steps.push({
      what: `InvestorTypeRegistry governor ${dAddr} = false`,
      done: async () => !(await reg.isGovernor(dAddr)),
      fn: "setGovernor",
      args: [dAddr, false, 0],
    });
  }
  return steps;
}

/** A registry step as an InvestorTypeConfig (type 0) proposal. */
const registryProposal = async (reg, step) => ({
  label: step.what,
  proposalType: 0,
  target: await reg.getAddress(),
  callData: OWNABLE.encodeFunctionData(step.fn, step.args),
});

/**
 * The registry proposals still needed for `o` (HANDOVER_PHASE=accept, after
 * a partial run): every registry step whose `done()` does not hold yet.
 */
async function pendingRegistryProposals(o) {
  o = await withBoundRegistry(await withDerivedContracts(o));
  const reg = o.investorTypeRegistry;
  if (!reg) return [];
  const steps = registrySteps(
    reg,
    await addrOf(o.deployer),
    await addrOf(o.ops),
  );
  const pending = [];
  for (const step of steps) {
    if (!(await step.done())) pending.push(await registryProposal(reg, step));
  }
  return pending;
}

/**
 * One registry step unless `done()` already holds. Direct when the deployer
 * owns the registry; queued (loudly) as an InvestorTypeConfig proposal when
 * governance does (preflight allows no other owner).
 */
async function registryCall(ctx, step) {
  const { o, d, dAddr, report, ok, log } = ctx;
  const reg = o.investorTypeRegistry;
  const { what, done, fn, args } = step;
  if (await done()) return ok(`${what} (already)`);
  if (same(await reg.owner(), dAddr)) {
    await send(reg.connect(d)[fn](...args));
    check(await done(), `${what} did not apply`);
    return ok(what);
  }
  report.registryProposals.push(await registryProposal(reg, step));
  log(
    `   ⚠️  ${what}: governance owns the registry, queued as an InvestorTypeConfig proposal`,
  );
}

/**
 * Task 4.13 (R-413-4): the strays the preflight would refuse that one
 * owner call removes, [{ what, on, fn, args }], read-only. Demo option
 * 83c lists them and offers to send each as the deployer; the ceremony
 * itself never removes them.
 */
async function findStrays(o) {
  o = await withBoundRegistry(await withDerivedContracts(o));
  o = await withDerivedPowers(o, () => {}, { strict: false });
  return [
    ...(await roleStrays(o)),
    ...(await trustStrays(o)),
    ...(await nodeStrays(o)),
  ];
}

module.exports = {
  ACCEPTANCE_PLAN,
  findStrays,
  handoverDeployerPowers,
  proposeCall,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  acceptAllByVote,
  pendingRegistryProposals,
  preflight,
  checkVoters,
  assertHandoverComplete,
};
