/**
 * @fileoverview Option 76 -> type 2, OracleParameters (plan v2 Task 4.4):
 * governance, OracleManager's owner after the handover, votes the node
 * lifecycle and the engine parameters. Same shape as the type-1 helper
 * (GovernanceModule._createComplianceRulesProposal): prompt, encode the
 * OracleManager call, createProposal(2, ...) from the first wallet that
 * may propose (GovernedCalls.pickProposer), then 77/78.
 * Task 5.12 (D50, R-56-2): action 7 registers a node, so the deployer-era
 * nodes rotate out add-before-remove; the node prompts list the nodes
 * registered on chain, and option 83f acknowledges a node proposed here.
 * Task 5.17 (deep review M-4): action 3 counts the nodes a removal would
 * leave, net of the removals already open: below ConsensusOracle.MIN_NODES
 * it refuses (no query could open, every list freezes; removeOracle checks
 * no floor), below RECOMMENDED_NODES (3, owner Q4) it asks for "yes".
 */

const { ethers } = require("hardhat");
const { displayError, displaySuccess } = require("./DisplayHelpers");
const { registeredNodes, opsSigner } = require("./OracleLifecycleFlow");
const { pickProposer } = require("./GovernedCalls");
const SignerManager = require("./SignerManager");

const ORACLE_PARAMETERS = 2; // ProposalType.OracleParameters
const REPUTATION = 500; // option 31's, and the runbook's
const DESCRIPTION = "registered by an OracleParameters vote";
/** Wallets with a role (section 1 of the runbook): never a node key. */
const ROLE_WALLETS = {
  0: "the deployer",
  9: "the issuer admin",
  10: "ops",
  11: "the guardian",
};

/** Q4: three independent nodes; fewer is allowed only on a typed "yes". */
const RECOMMENDED_NODES = 3;

/**
 * M-4: the nodes left if `node` and every node under an open (Active)
 * removeOracle proposal went: { left, open, minNodes }.
 */
async function nodesLeftAfter(state, node) {
  const om = state.getContract("oracleManager");
  const gov = state.getContract("vanguardGovernance");
  const target = (await om.getAddress()).toLowerCase();
  const sel = om.interface.getFunction("removeOracle").selector;
  const gone = new Set([node.toLowerCase()]);
  const open = [];
  for (let id = 1; id <= Number(await gov.proposalCount()); id++) {
    const [p] = await gov.getProposal(id);
    if (Number(p.status) !== 1 || p.target.toLowerCase() !== target) continue;
    if (!String(p.callData).startsWith(sel)) continue;
    const [n] = om.interface.decodeFunctionData("removeOracle", p.callData);
    gone.add(n.toLowerCase());
    open.push(`#${id} (${n})`);
  }
  const live = await om.getRegisteredOracles();
  const left = live.filter((a) => !gone.has(a.toLowerCase())).length;
  const engine = await ethers.getContractAt(
    ["function MIN_NODES() view returns (uint256)"],
    await om.consensusEngine(),
  );
  return { left, open, minNodes: Number(await engine.MIN_NODES()) };
}

/** M-4: whether a removal of `node` may be proposed (prompts below 3). */
async function removalAllowed(state, prompt, node) {
  const { left, open, minNodes } = await nodesLeftAfter(state, node);
  const also = open.length ? `, with open removal(s) ${open.join(", ")}` : "";
  if (left < minNodes) {
    displayError(
      `removing ${node} would leave ${left} node(s)${also}: below ConsensusOracle.MIN_NODES (${minNodes}) no query opens and every list freezes; register a node first (action 7)`,
    );
    return false;
  }
  if (left >= RECOMMENDED_NODES) return true;
  console.log(
    `   ⚠️  removing ${node} would leave ${left} node(s)${also}, fewer than the ${RECOMMENDED_NODES} independent nodes the deployment runs (Q4)`,
  );
  const yes = (await prompt('Type "yes" to propose it anyway: ')).trim();
  if (yes === "yes") return true;
  displayError("Not proposed");
  return false;
}

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
  ["Register a node", "registerOracle", "newnode"],
];

/** A node address: an index into the chain's list or a typed address. */
async function askNode(state, prompt) {
  const nodes = await registeredNodes(state);
  nodes.forEach((n, i) => {
    const key = n.signer
      ? `wallet ${state.signers.indexOf(n.signer)}`
      : "no demo key";
    console.log(`   ${i}: ${n.address} (${key})`);
  });
  const a = (
    await prompt(`Node (0-${nodes.length - 1} or 0x address): `)
  ).trim();
  if (/^\d+$/.test(a)) return nodes[Number(a)]?.address ?? null;
  return ethers.isAddress(a) ? ethers.getAddress(a) : null;
}

/**
 * registerOracle's [address, name, description, 500], or null after an
 * error line. Enter takes the next free demo wallet, allocated on demand
 * (never reserved); with none free, or for a key the demo does not hold,
 * the address is typed. A registered address is refused before any VGT.
 */
async function askNewNode(state, prompt) {
  const om = state.getContract("oracleManager");
  const dflt = `NODE_${(await om.getRegisteredOracles()).length + 1}`;
  const name = (await prompt(`Node name [${dflt}]: `)).trim() || dflt;
  let a = (
    await prompt("Node address (Enter: next free demo wallet): ")
  ).trim();
  let wallet = null;
  if (!a) {
    wallet = new SignerManager(state).getNextAvailableSigner(
      "oracle node",
      name,
    );
    if (wallet) a = wallet.signer.address;
    else {
      console.log("   ⚠️  no free demo wallet: type the node's address");
      a = (await prompt("Node address: ")).trim();
    }
  }
  if (!ethers.isAddress(a)) return (displayError(`Not an address: ${a}`), null);
  a = ethers.getAddress(a);
  const i = state.signers.findIndex((s) => s.address === a);
  if (ROLE_WALLETS[i]) {
    return (
      displayError(
        `${a} is wallet ${i} (${ROLE_WALLETS[i]}): a node needs its own key`,
      ),
      null
    );
  }
  if (await om.isRegisteredOracle(a)) {
    return (
      displayError(`${a} is already a registered node: nothing to propose`),
      null
    );
  }
  const desc =
    (await prompt(`Description [${DESCRIPTION}]: `)).trim() || DESCRIPTION;
  console.log(
    `   New node ${a}: ${wallet ? `wallet ${wallet.index}` : "no demo key, it cannot answer rounds"}`,
  );
  return [a, name, desc, REPUTATION];
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
  if (kind === "newnode") return askNewNode(state, prompt);
  const node = await askNode(state, prompt);
  if (!node) return (displayError("Invalid node"), null);
  if (kind === "node") return [node];
  if (kind === "node+reason") {
    if (!(await removalAllowed(state, prompt, node))) return null;
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
  const governed =
    owner.toLowerCase() === (await gov.getAddress()).toLowerCase();
  if (!governed) {
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
  const proposer = await pickProposer(state);
  if (!proposer) {
    displayError(
      `No wallet among 0-8 can propose (verified, ${ethers.formatEther(await gov.proposalCreationCost())} VGT, identity old enough)`,
    );
    return null;
  }
  const title = `OracleManager.${fn}(${args.join(", ")})`;
  const vgt = state.getContract("governanceToken");
  const cost = await gov.proposalCreationCost();
  await (
    await vgt.connect(proposer).approve(await gov.getAddress(), cost)
  ).wait();
  const receipt = await (
    await gov
      .connect(proposer)
      .createProposal(
        ORACLE_PARAMETERS,
        title,
        label,
        await om.getAddress(),
        om.interface.encodeFunctionData(fn, args),
      )
  ).wait();
  const id = await gov.proposalCount();
  // The operator stands behind a node it proposed: 83c/83e/83f acknowledge
  // it, only once governance owns the manager (review L-1: before, the
  // deployer could register the same address directly and pass 83c).
  if (fn === "registerOracle" && governed) {
    (state.proposedNodes ??= []).push(args[0]);
  } else if (fn === "registerOracle") {
    console.log(
      "   ⚠️  not acknowledged: only a node proposed after the handover counts for 83c/83e/83f",
    );
  }
  console.log(`   Proposer: ${proposer.address}`);
  displaySuccess("ORACLEPARAMETERS PROPOSAL CREATED!");
  console.log(`   Proposal: #${id}`);
  console.log(`   Transaction: ${receipt.hash}`);
  console.log(`   Call: ${title}`);
  console.log("\n💡 Next: option 77 votes, option 78 executes after the delay");
  return id;
}

module.exports = { createOracleParametersProposal, ACTIONS, nodesLeftAfter };
