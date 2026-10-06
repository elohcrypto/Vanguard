/**
 * @fileoverview Option 76 -> types 11 and 12 (plan v2 Task 4.7): after the
 * handover governance owns PrivacyManager and ZKVerifierIntegrated, so the
 * two settings option 47 -> 3 and 47 -> 2 set as the deployer become votes:
 *   11 PrivacyParameters: PrivacyManager.setProofValidityPeriod (1-365 days)
 *   12 VerifierParameters: ZKVerifierIntegrated.setProofCacheExpiry (1-168 h)
 * Same shape as the type-2 helper (OracleProposal.js): prompt, encode,
 * proposeCall from the shared picker's proposer, then 77/78.
 */

const { ethers } = require("hardhat");
const { displayError, displaySuccess } = require("./DisplayHelpers");
const { proposeCall } = require("./Handover");
const { pickVoters } = require("./VoterPicker");

const SPECS = {
  11: {
    name: "PrivacyParameters",
    key: "privacyManager",
    fn: "setProofValidityPeriod",
    ask: "Binding validity in days (1-365): ",
    min: 1,
    max: 365,
    unit: 86400n,
  },
  12: {
    name: "VerifierParameters",
    key: "zkVerifierIntegrated",
    fn: "setProofCacheExpiry",
    ask: "Proof cache expiry in hours (1-168): ",
    min: 1,
    max: 168,
    unit: 3600n,
  },
};

/** Option 76 -> 11 or 12. Returns the new proposal id, or null. */
async function createPrivacyProposal(state, prompt, type) {
  const spec = SPECS[type];
  const gov = state.getContract("vanguardGovernance");
  const target = state.getContract(spec.key);
  console.log(`\n📝 CREATE ${spec.name.toUpperCase()} PROPOSAL (type ${type})`);
  console.log("=".repeat(60));
  if (!target) return (displayError("No privacy pair: run option 1"), null);
  const owner = await target.owner();
  if (owner.toLowerCase() !== (await gov.getAddress()).toLowerCase()) {
    console.log(
      `   ⚠️  ${spec.key} is owned by ${owner}, not governance: the proposal executes only after the handover (83c, 83d)`,
    );
  }
  const n = Number((await prompt(spec.ask)).trim());
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
    return (displayError(`Not ${spec.min}-${spec.max}`), null);
  }
  const value = BigInt(n) * spec.unit;
  const pick = await pickVoters(state, type, spec.name);
  if (!pick) return null;
  const title = `${spec.key}.${spec.fn}(${value})`;
  const id = await proposeCall(
    gov,
    pick.proposer,
    type,
    target,
    target.interface.encodeFunctionData(spec.fn, [value]),
    title,
    `demo: option 76 type ${type}`,
  );
  console.log(`   Proposer: ${pick.proposer.address}`);
  displaySuccess(`${spec.name.toUpperCase()} PROPOSAL #${id} CREATED`);
  console.log(`   Call: ${title}`);
  console.log(
    `   Fee: ${ethers.formatEther(await gov.proposalCreationCost())} VGT, approved exactly`,
  );
  console.log("\n💡 Next: option 77 votes, option 78 executes after the delay");
  return id;
}

module.exports = { createPrivacyProposal, SPECS };
