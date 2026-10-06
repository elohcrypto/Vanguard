/**
 * @fileoverview Demo option 82, the complete governance workflow (plan v2
 * Task 4.7, owner amendment of 2026-10-01): one ComplianceRules proposal
 * from creation to execution, every number read from chain.
 *
 *   1. Actors from the shared picker (VoterPicker.js): one proposer and at
 *      least three voters; the proposer never votes.
 *   2. Each actor short of the fees is topped up by a VGT agent only (the
 *      deployer before the handover, ops after it); with no agent signer
 *      the option stops with the 75a hint.
 *   3. The proposer approves exactly the creation fee and proposes (the id
 *      is proposalCount() after the receipt); each voter approves exactly
 *      the voting fee and votes.
 *   4. On a dev node: advance past executionTime, execute, read VSC's
 *      jurisdiction rule back. On a real network: print the on-chain voting
 *      period and execution delay and point to option 78.
 */

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { canJumpTime } = require("./ChainTime");
const { proposeCall, settleProposal } = require("./Handover");
const { pickVoters, verifiedHumans } = require("./VoterPicker");

const COMPLIANCE_RULES_TYPE = 1; // ProposalType.ComplianceRules
const OPS = 10;
const STATUS = [
  "Pending",
  "Active",
  "Approved",
  "Rejected",
  "Executed",
  "Cancelled",
];
/** What the proposal adds to VSC's rule: US, UK, Canada allowed; Russia blocked. */
const RULE = { allowed: [840n, 826n, 124n], blocked: [643n] };

/**
 * VSC's current rule with RULE added: RULE.allowed joins the allowed list
 * and leaves the blocked one, RULE.blocked the other way round, so no
 * country loses its standing except by RULE.
 */
function withRule(current) {
  const keep = (xs, drop) =>
    xs.filter((x) => !drop.some((d) => d === x)).map((x) => BigInt(x));
  const add = (xs, extra) => [
    ...xs,
    ...extra.filter((e) => !xs.some((x) => x === e)),
  ];
  return {
    allowed: add(
      keep([...current.allowedCountries], RULE.blocked),
      RULE.allowed,
    ),
    blocked: add(
      keep([...current.blockedCountries], RULE.allowed),
      RULE.blocked,
    ),
  };
}
const ACTORS = 4; // one proposer, three voters

const fmt = (v) => ethers.formatEther(v);
const list = (a) => `[${a.map(String).join(", ")}]`;

/** The VGT agent among the deployer (0) and ops (10), or null. */
async function vgtAgent(state) {
  const vgt = state.getContract("governanceToken");
  for (const [i, role] of [
    [0, "deployer"],
    [OPS, "ops"],
  ]) {
    const s = state.signers[i];
    if (s && (await vgt.isAgent(s.address))) return { signer: s, role, i };
  }
  return null;
}

/**
 * Top up the first ACTORS verified wallets to the proposal fee plus the
 * voting fee, minting the shortfall from the VGT agent. False (after the
 * reason) when it cannot.
 */
async function topUp(state, log) {
  const gov = state.getContract("vanguardGovernance");
  const vgt = state.getContract("governanceToken");
  const stake = (await gov.proposalCreationCost()) + (await gov.votingCost());
  const humans = (await verifiedHumans(state)).slice(0, ACTORS);
  if (humans.length < ACTORS) {
    displayError(
      `Option 82 needs ${ACTORS} verified wallets among 0-9 (one proposer, three voters); found ${humans.length}`,
    );
    log(
      "   💡 Onboard them with option 23 or 24; options 6 and 7 issue KYC/AML claims",
    );
    return false;
  }
  const short = [];
  for (const s of humans) {
    const bal = await vgt.balanceOf(s.address);
    if (bal < stake) short.push([s, stake - bal]);
  }
  if (short.length === 0) {
    log(`   ✅ Every actor holds the fees (${fmt(stake)} VGT each)`);
    return true;
  }
  const agent = await vgtAgent(state);
  if (!agent) {
    displayError(
      `${short.length} actor(s) hold under ${fmt(stake)} VGT and neither the deployer nor ops is a VGT agent here`,
    );
    log("   💡 A VGT agent mints to them with option 75a, then rerun 82");
    return false;
  }
  for (const [s, amount] of short) {
    await (await vgt.connect(agent.signer).mint(s.address, amount)).wait();
    log(
      `   ✅ ${agent.role} (wallet ${agent.i}, VGT agent) minted ${fmt(amount)} VGT to ${s.address}`,
    );
  }
  return true;
}

/** Each voter approves exactly the voting fee and votes; returns the votes. */
async function castVotes(gov, vgt, id, voters, approvalBps, log) {
  const cost = await gov.votingCost();
  const govAddr = await gov.getAddress();
  // One AGAINST vote when the FOR share still clears approval: the tally
  // then shows one person, one vote, whatever the balances.
  const against =
    (BigInt(voters.length - 1) * 10000n) / BigInt(voters.length) >= approvalBps;
  const votes = [];
  for (const [n, v] of voters.entries()) {
    const support = !(against && n === voters.length - 1);
    await (await vgt.connect(v).approve(govAddr, cost)).wait();
    await (
      await gov
        .connect(v)
        .castVote(id, support, support ? "Support" : "Against")
    ).wait();
    votes.push(support);
    log(
      `   ✅ ${v.address} voted ${support ? "FOR" : "AGAINST"}: 1 vote, ${fmt(cost)} VGT fee`,
    );
  }
  return votes;
}

/**
 * Option 82. Returns { proposalId, status } (status read from chain), or
 * null when it stopped before creating a proposal.
 */
async function runCompleteWorkflow({ state, promptUser, log = console.log }) {
  displaySection("DEMO COMPLETE GOVERNANCE WORKFLOW", "🧪");
  const gov = state.getContract("vanguardGovernance");
  const vgt = state.getContract("governanceToken");
  const rules = state.getContract("complianceRules");
  const vsc = state.getContract("digitalToken");
  if (!gov || !vgt || !rules || !vsc) {
    displayError("Option 82 needs VSC (21) and governance (74)");
    return null;
  }
  log("\nOne ComplianceRules proposal from creation to execution:");
  log("1. one proposer and three voters, verified, holding the fees");
  log(
    `2. propose VSC's jurisdiction rule plus allowed ${list(RULE.allowed)} and blocked ${list(RULE.blocked)}`,
  );
  log("3. vote: 1 person = 1 vote; VGT is the fee, not the weight");
  log("4. execute after the voting period and delay, read the rule back");
  const proceed = await promptUser("Proceed with demo? (yes/no): ");
  if (proceed.toLowerCase() !== "yes") {
    log("Demo cancelled");
    return null;
  }

  log("\nSTEP 1: ACTORS AND FEES");
  if (!(await topUp(state, log))) return null;
  const pick = await pickVoters(
    state,
    COMPLIANCE_RULES_TYPE,
    "ComplianceRules",
  );
  if (!pick) return null;
  if (pick.voters.length < ACTORS - 1) {
    displayError(
      `Need three voters besides the proposer; found ${pick.voters.length}`,
    );
    return null;
  }
  const voters = pick.voters.slice(0, Math.max(ACTORS - 1, pick.needed));
  const vscAddr = await vsc.getAddress();
  const before = await rules.getJurisdictionRule(vscAddr);
  log(`   Proposer: ${pick.proposer.address} (does not vote)`);
  const target = withRule(before);
  log(
    `   VSC rule now: allowed ${list(before.allowedCountries)}, blocked ${list(before.blockedCountries)}`,
  );
  log(
    `   Proposed:     allowed ${list(target.allowed)}, blocked ${list(target.blocked)}`,
  );
  log(
    "   (a rule change for VSC lapses the private jurisdiction records: 42 -> 3 again)",
  );

  log("\nSTEP 2: CREATE THE PROPOSAL");
  let id;
  try {
    id = await proposeCall(
      gov,
      pick.proposer,
      COMPLIANCE_RULES_TYPE,
      rules,
      rules.interface.encodeFunctionData("setJurisdictionRule", [
        vscAddr,
        target.allowed,
        target.blocked,
      ]),
      "Update Jurisdiction Rules",
      "demo option 82",
    );
  } catch (error) {
    displayError(`Proposal not created: ${error.message.split("\n")[0]}`);
    return null;
  }
  log(
    `   ✅ Proposal #${id} (proposalCount after the receipt); creation fee ${fmt(await gov.proposalCreationCost())} VGT approved exactly`,
  );

  try {
    log("\nSTEP 3: VOTE");
    const t = await gov.proposalThresholds(COMPLIANCE_RULES_TYPE);
    await castVotes(gov, vgt, id, voters, t.approvalPercentage, log);
    const [p, totalVotes, participation] = await gov.getProposal(id);
    // The contract's own gates (getProposal / executeProposal).
    const quorumMet =
      totalVotes * 10000n >= p.eligibleVotersAtCreation * t.quorumPercentage;
    const approved =
      totalVotes > 0n &&
      (p.votesFor * 10000n) / totalVotes >= t.approvalPercentage;
    log(
      `   Tally: ${p.votesFor} FOR, ${p.votesAgainst} AGAINST of ${p.eligibleVotersAtCreation} eligible, turnout ${Number(participation) / 100}%`,
    );
    log(
      `   Quorum ${Number(t.quorumPercentage) / 100}%: ${quorumMet ? "met" : "NOT met"}; approval ${Number(t.approvalPercentage) / 100}%: ${approved ? "met" : "NOT met"}`,
    );

    log("\nSTEP 4: EXECUTE");
    if (!(await canJumpTime())) {
      log(
        `   Voting period ${t.votingPeriod}s, execution delay ${t.executionDelay}s (on chain, this type)`,
      );
      log(
        `   Voting ends ${new Date(Number(p.votingEnds) * 1000).toISOString()}, executable from ${new Date(Number(p.executionTime) * 1000).toISOString()}`,
      );
      log(`   💡 Execute proposal #${id} with option 78 after that time`);
      return { proposalId: id, status: STATUS[Number(p.status)], target };
    }
    await settleProposal(gov, id, `proposal #${id}`);
    const [after] = await gov.getProposal(id);
    const rule = await rules.getJurisdictionRule(vscAddr);
    const ok =
      list(rule.allowedCountries) === list(target.allowed) &&
      list(rule.blockedCountries) === list(target.blocked);
    log(`   Status: ${STATUS[Number(after.status)]}`);
    log(
      `   VSC rule read back: allowed ${list(rule.allowedCountries)}, blocked ${list(rule.blockedCountries)} ${ok ? "✅" : "❌ not what the proposal set"}`,
    );
    if (ok)
      displaySuccess(
        `PROPOSAL #${id} EXECUTED: VSC'S JURISDICTION RULE CHANGED BY VOTE`,
      );
    else displayError(`Proposal #${id} executed but the rule differs`);
    return { proposalId: id, status: STATUS[Number(after.status)], target };
  } catch (error) {
    displayError(
      `Workflow stopped after creating proposal #${id}: ${error.message.split("\n")[0]}`,
    );
    log(
      `   💡 Continue proposal #${id} with options 77 (vote) and 78 (execute)`,
    );
    const [p] = await gov.getProposal(id);
    return { proposalId: id, status: STATUS[Number(p.status)], target };
  }
}

module.exports = { runCompleteWorkflow, RULE, withRule };
