/**
 * Option 82 section of scripts/demo-smoke.js (plan v2 Task 4.7): the
 * complete governance workflow through the module API, with a stubbed
 * "yes" (demo-drive.sh can feed the confirmation as `82:yes`; the module
 * call keeps this check inside the in-process smoke). Called from
 * demo-smoke-handover.js after the ceremony, so ops is the VGT agent and
 * governance owns ComplianceRules. Every assertion reads the chain.
 */

const { ethers } = require("hardhat");
const { RULE } = require("../demo/utils/GovernanceWorkflow");

/**
 * The rule option 82 must leave, computed here and not by the module
 * (review L2): the current lists, RULE.allowed moved into the allowed
 * list and RULE.blocked into the blocked one, nothing else changed.
 */
function expectRule(cur) {
  const a = [...cur.allowedCountries].map(String);
  const b = [...cur.blockedCountries].map(String);
  const add = RULE.allowed.map(String);
  const block = RULE.blocked.map(String);
  const allowed = a.filter((x) => !block.includes(x));
  for (const x of add) if (!allowed.includes(x)) allowed.push(x);
  const blocked = b.filter((x) => !add.includes(x));
  for (const x of block) if (!blocked.includes(x)) blocked.push(x);
  return { allowed, blocked };
}
const { verifiedHumans } = require("../demo/utils/VoterPicker");

const EXECUTED = 4n; // ProposalStatus.Executed
const list = (a) => a.map(String).join(",");

async function runWorkflowSmoke(state, failures) {
  const GovernanceModule = require("../demo/modules/GovernanceModule");
  const { EnhancedLogger } = require("../demo/logging");
  const gov = state.getContract("vanguardGovernance");
  const rules = state.getContract("complianceRules");
  const vscAddr = await state.getContract("digitalToken").getAddress();
  const before = await gov.proposalCount();
  const n0 = failures.length;
  // The first actor gives its VGT to the second, so the workflow must top
  // it up through the VGT agent (ops after the ceremony), never the deployer.
  const vgt = state.getContract("governanceToken");
  const [first, second] = await verifiedHumans(state);
  const bal = await vgt.balanceOf(first.address);
  if (bal > 0n)
    await (await vgt.connect(first).transfer(second.address, bal)).wait();
  const fromBlock = await ethers.provider.getBlockNumber();
  const version0 = await rules.jurisdictionRuleVersion(vscAddr);
  const want = expectRule(await rules.getJurisdictionRule(vscAddr));

  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let res;
  try {
    const m = new GovernanceModule(
      state,
      new EnhancedLogger(),
      async () => "yes",
    );
    res = await m.demoCompleteWorkflow();
  } catch (e) {
    failures.push(`option 82 threw: ${e.message.split("\n")[0]}`);
    return;
  } finally {
    console.log = real;
  }
  const tail = lines.slice(-4).join(" | ");
  if (!res) {
    failures.push(`option 82 created no proposal: ${tail}`);
    return;
  }
  const id = BigInt(res.proposalId);
  if (id !== before + 1n || (await gov.proposalCount()) !== id) {
    failures.push(
      `option 82 reported proposal #${id}, proposalCount ${before} -> ${await gov.proposalCount()}`,
    );
  }
  const [p, totalVotes] = await gov.getProposal(id);
  if (p.status !== EXECUTED || res.status !== "Executed") {
    failures.push(
      `option 82 proposal #${id} is status ${p.status} (reported ${res.status}), expected Executed: ${tail}`,
    );
  }
  if (await gov.hasVoted(id, p.proposer)) {
    failures.push(
      `option 82: the proposer ${p.proposer} voted on its own proposal`,
    );
  }
  if (totalVotes < 3n) {
    failures.push(
      `option 82 counted ${totalVotes} votes, expected at least 3 voters`,
    );
  }
  if (!/demo option 82\)$/.test(p.description)) {
    failures.push(
      `option 82 proposal description "${p.description}" does not name option 82`,
    );
  }
  const mints = await vgt.queryFilter(
    vgt.filters.Transfer(ethers.ZeroAddress, first.address),
    fromBlock,
  );
  const ops = state.signers[10].address;
  const by = mints.length ? (await mints[0].getTransaction()).from : null;
  if (mints.length !== 1 || !by || by.toLowerCase() !== ops.toLowerCase()) {
    failures.push(
      `option 82: ${mints.length} VGT mint(s) to the emptied actor ${first.address}, sent by ${by}; expected one top-up by ops ${ops}`,
    );
  }
  const version1 = await rules.jurisdictionRuleVersion(vscAddr);
  if (version1 !== version0 + 1n) {
    failures.push(
      `option 82: jurisdictionRuleVersion(VSC) ${version0} -> ${version1}, expected one setJurisdictionRule`,
    );
  }
  const rule = await rules.getJurisdictionRule(vscAddr);
  const covers = (xs, need) =>
    need.every((n) => xs.map(String).includes(String(n)));
  if (
    list(rule.allowedCountries) !== list(want.allowed) ||
    list(rule.blockedCountries) !== list(want.blocked) ||
    !covers(rule.allowedCountries, RULE.allowed) ||
    !covers(rule.blockedCountries, RULE.blocked)
  ) {
    failures.push(
      `option 82: VSC rule is allowed [${list(rule.allowedCountries)}] blocked [${list(rule.blockedCountries)}], not the proposal's`,
    );
  }
  if (!lines.some((l) => /VSC rule read back: .*✅/.test(l))) {
    failures.push("option 82 did not print the rule read back from chain");
  }
  if (failures.length === n0) {
    console.log(
      `✅ Option 82: proposal #${id} Executed, ${totalVotes} votes, the proposer did not vote, VSC rule read back`,
    );
  }
}

module.exports = { runWorkflowSmoke };
