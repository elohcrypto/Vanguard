/**
 * @fileoverview Owner-only demo calls that keep working after the handover
 * (plan v2 Task 2F.5, L11): while the deployer owns the target it calls
 * directly; once governance owns it, the call becomes a proposal of the
 * type bound to that target, voted with options 77/78.
 */

const { ethers } = require("hardhat");
const { proposeCall } = require("./Handover");
const { voterAgeRefusal, walletControlRefusal } = require("./ChainTime");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const COMPLIANCE_RULES_TYPE = 1; // ProposalType.ComplianceRules
/** issuerAdmin 9, ops 10, guardian 11: role wallets never propose (N-3). */
const ROLE_WALLETS = new Set([9, 10, 11]);

/**
 * First wallet among 0-8 that may propose: verified, old enough, controls
 * its identity and holds the creation fee. Null when none can.
 */
async function pickProposer(state) {
  const gov = state.getContract("vanguardGovernance");
  const idReg = state.getContract("identityRegistry");
  const vgt = state.getContract("governanceToken");
  const cost = await gov.proposalCreationCost();
  for (let i = 0; i < Math.min(10, state.signers.length); i++) {
    if (ROLE_WALLETS.has(i)) continue;
    const s = state.signers[i];
    if (!(await idReg.isVerified(s.address))) continue;
    if ((await vgt.balanceOf(s.address)) < cost) continue;
    if (await voterAgeRefusal(gov, idReg, s.address)) continue;
    if (await walletControlRefusal(idReg, s.address)) continue;
    return s;
  }
  return null;
}

/**
 * Trust `wallet` in ComplianceRules (option 63's escrow wallet). Returns
 * { direct: true } after the deployer's call, { proposalId } after a
 * ComplianceRules proposal, or { refused: reason } with nothing sent.
 */
async function trustContract(state, wallet, log = console.log) {
  const rules = state.getContract("complianceRules");
  const deployer = state.signers[0];
  const owner = await rules.owner();
  if (same(owner, deployer.address)) {
    await (await rules.connect(deployer).addTrustedContract(wallet)).wait();
    return { direct: true };
  }
  const gov = state.getContract("vanguardGovernance");
  if (!gov || !same(owner, await gov.getAddress())) {
    return {
      refused: `ComplianceRules is owned by ${owner}, neither the deployer nor governance`,
    };
  }
  const proposer = await pickProposer(state);
  if (!proposer) {
    return {
      refused: `governance owns ComplianceRules; no wallet among 0-8 can propose (verified, ${ethers.formatEther(await gov.proposalCreationCost())} VGT, identity old enough)`,
    };
  }
  const proposalId = await proposeCall(
    gov,
    proposer,
    COMPLIANCE_RULES_TYPE,
    rules,
    rules.interface.encodeFunctionData("addTrustedContract", [wallet]),
    `Trust escrow wallet ${wallet}`,
  );
  log(
    `   🗳️  Proposal #${proposalId} (ComplianceRules) by ${proposer.address}`,
  );
  return { proposalId };
}

module.exports = { trustContract, pickProposer };
