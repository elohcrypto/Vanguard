/**
 * @fileoverview Owner-only demo calls that keep working after the handover
 * (plan v2 Task 2F.5, L11): while the deployer owns the target it calls
 * directly; once governance owns it, the call becomes a proposal of the
 * type bound to that target, voted with options 77/78.
 */

const { ethers, artifacts } = require("hardhat");
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
 * keccak256 of the compiled runtime code of `name`: the code hash a
 * ComplianceRules registrar may trust (plan v2 Task 4.3).
 */
async function walletCodeHash(name) {
  return ethers.keccak256(
    (await artifacts.readArtifact(name)).deployedBytecode,
  );
}

/**
 * Name `registrar` (InvestorRequestManager or EscrowWalletFactory) a
 * ComplianceRules registrar on VSC for the `walletName` code hash, so it
 * trusts each wallet it creates (plan v2 Task 4.3). Returns { direct: true }
 * after the deployer's call (or when already set), { proposalId } after a
 * ComplianceRules proposal, or { refused: reason } with nothing sent.
 */
async function registerRegistrar(
  state,
  registrar,
  walletName,
  log = console.log,
) {
  const rules = state.getContract("complianceRules");
  const vsc = await state.getContract("digitalToken").getAddress();
  const hash = await walletCodeHash(walletName);
  if ((await rules.trustedRegistrars(vsc, registrar)) === hash) {
    return { direct: true };
  }
  const deployer = state.signers[0];
  const owner = await rules.owner();
  if (same(owner, deployer.address)) {
    await (
      await rules.connect(deployer).setTrustedRegistrar(vsc, registrar, hash)
    ).wait();
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
    rules.interface.encodeFunctionData("setTrustedRegistrar", [
      vsc,
      registrar,
      hash,
    ]),
    `Registrar ${registrar} for ${walletName}`,
  );
  log(
    `   🗳️  Proposal #${proposalId} (ComplianceRules) by ${proposer.address}`,
  );
  return { proposalId };
}

const ORACLE_PARAMETERS_TYPE = 2; // ProposalType.OracleParameters

/**
 * An owner-only OracleManager call (plan v2 Task 4.4): the deployer calls
 * directly while it owns the manager; once governance owns it the call
 * becomes an OracleParameters proposal (voted with options 77/78).
 * Returns { direct: true }, { proposalId } or { refused: reason }.
 */
async function governOracleManager(state, fn, args, log = console.log) {
  const om = state.getContract("oracleManager");
  const deployer = state.signers[0];
  const owner = await om.owner();
  if (same(owner, deployer.address)) {
    await (await om.connect(deployer)[fn](...args)).wait();
    return { direct: true };
  }
  const gov = state.getContract("vanguardGovernance");
  if (!gov || !same(owner, await gov.getAddress())) {
    return {
      refused: `OracleManager is owned by ${owner}, neither the deployer nor governance`,
    };
  }
  const proposer = await pickProposer(state);
  if (!proposer) {
    return {
      refused: `governance owns OracleManager; no wallet among 0-8 can propose (verified, ${ethers.formatEther(await gov.proposalCreationCost())} VGT, identity old enough)`,
    };
  }
  const proposalId = await proposeCall(
    gov,
    proposer,
    ORACLE_PARAMETERS_TYPE,
    om,
    om.interface.encodeFunctionData(fn, args),
    `OracleManager.${fn}(${args.join(", ")})`,
  );
  log(
    `   🗳️  Proposal #${proposalId} (OracleParameters) by ${proposer.address}`,
  );
  return { proposalId };
}

module.exports = {
  registerRegistrar,
  governOracleManager,
  walletCodeHash,
  pickProposer,
};
