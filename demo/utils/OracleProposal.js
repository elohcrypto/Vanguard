/**
 * @fileoverview Option 76 -> type 2, OracleParameters (plan v2 Task 4.4):
 * governance, OracleManager's owner after the handover, votes the node
 * lifecycle and the engine parameters. Same shape as the type-1 helper
 * (GovernanceModule._createComplianceRulesProposal): prompt, encode the
 * OracleManager call, createProposal(2, ...) from wallet 0, then 77/78.
 */

const { ethers } = require("hardhat");
const { displayError, displaySuccess } = require("./DisplayHelpers");
const { nodeSigners, opsSigner } = require("./OracleLifecycleFlow");

const ORACLE_PARAMETERS = 2; // ProposalType.OracleParameters

/** [label, function, () => args prompt] for each action. */
const ACTIONS = [
  ["Pause a node", "pauseOracle", "node"],
  ["Unpause a node", "unpauseOracle", "node"],
  ["Remove a node", "removeOracle", "node+reason"],
  [
    "Set / clear a node's emergency designation",
    "setEmergencyOracle",
    "node+flag",
  ],
  [
    "Set the consensus threshold (percent, 51-100)",
    "setConsensusThreshold",
    "percent",
  ],
  ["Set the operator", "setOperator", "address"],
];

/** A node address: a node index 0-2 or a typed address; null if invalid. */
async function askNode(state, prompt) {
  nodeSigners(state).forEach((n, i) =>
    console.log(`   ${i}: ${n.address} (wallet ${i + 1})`),
  );
  const a = (await prompt("Node (0-2 or 0x address): ")).trim();
  if (/^[0-2]$/.test(a)) return nodeSigners(state)[Number(a)].address;
  return ethers.isAddress(a) ? ethers.getAddress(a) : null;
}

/** The args for `kind`, or null after an error line. */
async function askArgs(state, prompt, kind) {
  if (kind === "percent") {
    const p = Number(await prompt("Threshold percent (51-100): "));
    if (!Number.isInteger(p) || p <= 50 || p > 100) {
      return (displayError("The threshold is a whole percent in 51-100"), null);
    }
    return [p];
  }
  if (kind === "address") {
    const fallback = opsSigner(state).address;
    const a = (await prompt(`Operator [ops ${fallback}]: `)).trim() || fallback;
    if (!ethers.isAddress(a))
      return (displayError(`Not an address: ${a}`), null);
    return [ethers.getAddress(a)];
  }
  const node = await askNode(state, prompt);
  if (!node) return (displayError("Invalid node"), null);
  if (kind === "node") return [node];
  if (kind === "node+reason") {
    return [node, (await prompt("Reason: ")).trim() || "governance vote"];
  }
  const yn = (await prompt("Designate (y) or clear (n)? "))
    .trim()
    .toLowerCase();
  if (!["y", "n"].includes(yn)) return (displayError("Answer y or n"), null);
  return [node, yn === "y"];
}

/** Option 76 -> 2. Returns the new proposal id, or null. */
async function createOracleParametersProposal(state, prompt) {
  console.log("\n📝 CREATE ORACLEPARAMETERS PROPOSAL");
  console.log("=".repeat(60));
  const om = state.getContract("oracleManager");
  const gov = state.getContract("vanguardGovernance");
  if (!om)
    return (displayError("Deploy the oracle system first (option 31)"), null);
  const owner = await om.owner();
  if (owner.toLowerCase() !== (await gov.getAddress()).toLowerCase()) {
    // The call would revert at execution: governance cannot act as owner yet.
    console.log(
      `   ⚠️  OracleManager is owned by ${owner}, not governance: the proposal executes only after the handover (option 83c)`,
    );
  }
  ACTIONS.forEach(([label], i) => console.log(`${i + 1}. ${label}`));
  const pick =
    ACTIONS[Number(await prompt(`Select action (1-${ACTIONS.length}): `)) - 1];
  if (!pick) return (displayError("Invalid choice"), null);
  const [label, fn, kind] = pick;
  const args = await askArgs(state, prompt, kind);
  if (!args) return null;
  const title = `OracleManager.${fn}(${args.join(", ")})`;
  const receipt = await (
    await gov.createProposal(
      ORACLE_PARAMETERS,
      title,
      label,
      await om.getAddress(),
      om.interface.encodeFunctionData(fn, args),
    )
  ).wait();
  const id = await gov.proposalCount();
  displaySuccess("ORACLEPARAMETERS PROPOSAL CREATED!");
  console.log(`   Proposal: #${id}`);
  console.log(`   Transaction: ${receipt.hash}`);
  console.log(`   Call: ${title}`);
  console.log("\n💡 Next: option 77 votes, option 78 executes after the delay");
  return id;
}

module.exports = { createOracleParametersProposal, ACTIONS };
