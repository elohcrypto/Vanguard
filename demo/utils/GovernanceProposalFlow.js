/**
 * @fileoverview Governance option 76: create a proposal
 * @module GovernanceProposalFlow
 * @description Proposal type names and thresholds, and the proposal builders by type.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { voterAgeRefusal } = require("./ChainTime");
const { ethers } = require("hardhat");
const { createOracleParametersProposal } = require("./OracleProposal");
const { createPrivacyProposal } = require("./PrivacyProposal");

/**
 * Proposal type names in ProposalType enum order.
 *
 * Must match the ProposalType enum in contracts/governance/GovernanceConfig.sol.
 * ListUpdate (6) is the single list-update type created by DynamicListModule,
 * menu option 86 (plan 2D.1).
 */
const PROPOSAL_TYPE_NAMES = [
  "InvestorTypeConfig",
  "ComplianceRules",
  "OracleParameters",
  "TokenParameters",
  "SystemParameters",
  "EmergencyAction",
  "ListUpdate",
  "IdentityRegistryParameters",
  "GovernanceTokenParameters",
  "EscrowFactoryParameters",
  "IdentityFactoryParameters",
  "PrivacyParameters",
  "VerifierParameters",
];

/**
 * Name a proposal type, tolerating types this demo predates.
 * @private
 */
function _proposalTypeName(mod, typeNum) {
  return PROPOSAL_TYPE_NAMES[Number(typeNum)] ?? `Unknown type ${typeNum}`;
}

/**
 * Read the configured quorum/approval thresholds for a proposal type and
 * render them as percentages. Thresholds are basis points on-chain.
 * @private
 */
async function _thresholdsFor(mod, vanguardGovernance, typeNum) {
  const t = await vanguardGovernance.proposalThresholds(Number(typeNum));
  return {
    quorumPct: Number(t.quorumPercentage) / 100,
    approvalPct: Number(t.approvalPercentage) / 100,
  };
}

/** Option 76: Create Proposal */
async function createProposal(mod) {
  displaySection("CREATE GOVERNANCE PROPOSAL", "🗳️");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const governanceToken = mod.state.getContract("governanceToken");

  if (!vanguardGovernance || !governanceToken) {
    displayError("Deploy Governance Token system first (option 74)");
    return;
  }

  try {
    console.log("📋 PROPOSAL TYPES:");
    console.log("0. InvestorTypeConfig - Update investor type limits");
    console.log("1. ComplianceRules - Update compliance parameters");
    console.log(
      "2. OracleParameters - Pause/unpause/remove a node, emergency designation, threshold, operator",
    );
    console.log("3. TokenParameters - Update token settings");
    console.log("4. SystemParameters - Update system settings");
    console.log("5. EmergencyAction - Emergency actions");
    console.log(
      "6. ListUpdate - Whitelist/blacklist a member via DynamicListManager",
    );
    console.log(
      "7. IdentityRegistryParameters - Update KYC/AML registry (topics, issuers, agents)",
    );
    console.log(
      "8. GovernanceTokenParameters - Pause/unpause or manage agents of the vote token",
    );
    console.log(
      "9. EscrowFactoryParameters - Escrow factory fee wallet, registry, rules (after the handover)",
    );
    console.log(
      "10. IdentityFactoryParameters - OnchainID factory fees, pause, withdraw (after the handover)",
    );
    console.log(
      "11. PrivacyParameters - PrivacyManager binding validity (demo builder; root, operator, verifier by calldata)",
    );
    console.log(
      "12. VerifierParameters - ZKVerifierIntegrated proof cache expiry (demo builder; verifiers by calldata)",
    );

    const typeChoice = await mod.promptUser("Select proposal type (0-12): ");
    const proposalType = parseInt(typeChoice);

    // Types 2, 11 and 12 pick their proposer among the verified wallets
    // (OracleProposal.js, PrivacyProposal.js); 0 and 1 propose as signer 0.
    if (proposalType === 2) {
      // Task 4.4: node lifecycle and engine parameters (OracleProposal.js).
      return await createOracleParametersProposal(mod.state, mod.promptUser);
    }
    if (proposalType === 11 || proposalType === 12) {
      return await createPrivacyProposal(
        mod.state,
        mod.promptUser,
        proposalType,
      );
    }
    if (proposalType !== 0 && proposalType !== 1) {
      console.log(
        "⚠️  The demo builds types 0, 1, 2, 11 and 12; other types are proposed by calldata (createProposal) directly.",
      );
      return;
    }

    // Pre-flight checks (types 0 and 1 propose as signer 0)
    const owner = mod.state.signers[0];
    const identityRegistry = mod.state.getContract("identityRegistry");
    const isVerified = await identityRegistry.isVerified(owner.address);

    if (!isVerified) {
      console.log(
        "ℹ️  You must be KYC/AML verified to create proposals (isVerified false)",
      );
      console.log("\n💡 SOLUTION:");
      console.log("   1. Use Option 6 to issue KYC to yourself (signer 0)");
      console.log("   2. Use Option 7 to issue AML to yourself (signer 0)");
      console.log("   3. Try creating proposal again");
      return;
    }

    // D25: a proposer's identity must be minVoterAge old.
    const young = await voterAgeRefusal(
      vanguardGovernance,
      identityRegistry,
      owner.address,
    );
    if (young) {
      displayError(`Proposer ${owner.address} ${young}`);
      return;
    }

    const proposalCost = await vanguardGovernance.proposalCreationCost();
    const balance = await governanceToken.balanceOf(owner.address);
    const governanceAddress = await vanguardGovernance.getAddress();
    const allowance = await governanceToken.allowance(
      owner.address,
      governanceAddress,
    );

    console.log("\n📊 PRE-FLIGHT CHECKS:");
    console.log(`   ✅ KYC/AML Status: Verified`);
    console.log(`   Your VGT Balance: ${ethers.formatEther(balance)} VGT`);
    console.log(`   Proposal Cost: ${ethers.formatEther(proposalCost)} VGT`);
    console.log(`   Current Allowance: ${ethers.formatEther(allowance)} VGT`);

    if (balance < proposalCost) {
      displayError(
        `Insufficient VGT balance. You need ${ethers.formatEther(proposalCost)} VGT`,
      );
      console.log("\n💡 SOLUTION: Use Option 75a to mint more VGT tokens");
      return;
    }

    if (allowance < proposalCost) {
      displayError(
        `Insufficient allowance. Governance contract needs approval to spend ${ethers.formatEther(proposalCost)} VGT`,
      );
      console.log("\n💡 SOLUTION:");
      console.log("   1. Use Option 75c to approve Governance contract");
      console.log(
        `   2. Approve at least ${ethers.formatEther(proposalCost)} VGT`,
      );
      console.log("   3. Try creating proposal again");
      return;
    }

    console.log("   ✅ All checks passed!\n");

    if (proposalType === 0) {
      await mod._createInvestorTypeConfigProposal();
    } else {
      await mod._createComplianceRulesProposal();
    }
  } catch (error) {
    displayError(`Proposal creation failed: ${error.message}`);
    if (error.message.includes("ERC20InsufficientAllowance")) {
      console.log(
        "\n💡 TIP: Use Option 75c to approve Governance contract to spend VGT",
      );
    } else if (error.message.includes("Must be KYC/AML verified")) {
      console.log("\n💡 TIP: Use Options 6 & 7 to issue KYC/AML to yourself");
    } else if (error.message.includes("Identity too new to vote")) {
      console.log(
        "\n💡 TIP: identities propose and vote only once minVoterAge old (7 days / TIME_SCALE); wait, or jump time on a dev node",
      );
    } else if (error.message.includes("Wallet does not control its identity")) {
      console.log(
        "\n💡 TIP: the wallet must own its OnchainID or hold a MANAGEMENT/ACTION key on it",
      );
    }
  }
}

/**
 * Helper: Create InvestorTypeConfig proposal
 * @private
 */
async function _createInvestorTypeConfigProposal(mod) {
  console.log("\n📝 CREATE INVESTORTYPECONFIG PROPOSAL");
  console.log("=".repeat(60));

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError("Deploy InvestorTypeRegistry first (option 51)");
    return;
  }

  console.log("\n1. Update investor type limits");
  console.log(
    "2. Exempt or un-exempt a treasury wallet from investor limits (D22)",
  );
  // Refuse anything but 1 or 2: a fall-through to the limits flow would
  // consume the next scripted answers as limits.
  const action = (await mod.promptUser("Select action (1-2): ")).trim();
  if (action !== "1" && action !== "2") {
    displayError(`Select 1 or 2, got "${action}"`);
    return;
  }
  if (action === "2") {
    await mod._createTreasuryExemptionProposal(investorTypeRegistry);
    return;
  }

  console.log("\n🎯 Select investor type to update:");
  console.log("0. Normal Investor");
  console.log("1. Retail Investor");
  console.log("2. Accredited Investor");
  console.log("3. Institutional Investor");

  const typeChoice = await mod.promptUser("Select type (0-3): ");
  const investorType = parseInt(typeChoice);

  console.log("\n💰 Enter new limits:");
  const maxTransfer = await mod.promptUser("Max transfer amount (VSC): ");
  const maxHolding = await mod.promptUser("Max holding amount (VSC): ");

  const title = `Update ${["Normal", "Retail", "Accredited", "Institutional"][investorType]} Investor Limits`;
  const description = `Increase max transfer to ${maxTransfer} VSC and max holding to ${maxHolding} VSC`;

  // Encode the function call
  const callData = investorTypeRegistry.interface.encodeFunctionData(
    "updateInvestorTypeConfig",
    [
      investorType,
      {
        maxTransferAmount: ethers.parseEther(maxTransfer),
        maxHoldingAmount: ethers.parseEther(maxHolding),
        requiredWhitelistTier: 2,
        transferCooldownMinutes: 30,
        largeTransferThreshold: ethers.parseEther("10000"),
        enhancedLogging: true,
        enhancedPrivacy: false,
      },
    ],
  );

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const tx = await vanguardGovernance.createProposal(
    0, // ProposalType.InvestorTypeConfig
    title,
    description,
    await investorTypeRegistry.getAddress(),
    callData,
  );
  const receipt = await tx.wait();

  displaySuccess("INVESTORTYPECONFIG PROPOSAL CREATED!");
  console.log(`   Transaction: ${receipt.hash}`);
  console.log(`   Title: ${title}`);
  console.log(`   Target: InvestorTypeRegistry`);
  console.log(
    `   Investor Type: ${["Normal", "Retail", "Accredited", "Institutional"][investorType]}`,
  );
  console.log(`   Max Transfer: ${maxTransfer} VSC`);
  console.log(`   Max Holding: ${maxHolding} VSC`);
  console.log("\n💡 Next: Use option 77 to vote on this proposal");
}

/**
 * Helper: InvestorTypeConfig proposal calling setInvestorLimitExempt.
 * D22: after the handover governance owns the registry, so a vote is the
 * only way to exempt (or un-exempt) a treasury wallet.
 * @private
 */
async function _createTreasuryExemptionProposal(mod, investorTypeRegistry) {
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const owner = await investorTypeRegistry.owner();
  if (owner !== (await vanguardGovernance.getAddress())) {
    // The call would revert at execution and the proposal settle Rejected.
    displayError(
      `InvestorTypeRegistry is owned by ${owner}, not governance: run option 83b first, or exempt directly as the owner (option 22/51)`,
    );
    return;
  }
  const bank = Array.from(mod.state.bankingInstitutions?.values?.() ?? []).find(
    (b) => b.type === "CENTRAL_BANK",
  );
  const fallback = bank ? bank.address : mod.state.signers[0].address;
  const input = await mod.promptUser(`Treasury wallet [${fallback}]: `);
  const wallet = input.trim() || fallback;
  if (!ethers.isAddress(wallet)) {
    displayError(`Not an address: ${wallet}`);
    return;
  }
  const answer = await mod.promptUser("Exempt from investor limits? (y/n): ");
  // An explicit y or n: a blank answer must not build an un-exempt vote.
  const yn = answer.trim().toLowerCase();
  if (!["y", "yes", "n", "no"].includes(yn)) {
    displayError(`Answer y or n, got "${answer.trim()}"`);
    return;
  }
  const exempt = yn.startsWith("y");

  const title = `${exempt ? "Exempt" : "Un-exempt"} treasury ${wallet} from investor limits`;
  const callData = investorTypeRegistry.interface.encodeFunctionData(
    "setInvestorLimitExempt",
    [wallet, exempt],
  );
  const receipt = await (
    await vanguardGovernance.createProposal(
      0, // ProposalType.InvestorTypeConfig
      title,
      `setInvestorLimitExempt(${wallet}, ${exempt}) (D22)`,
      await investorTypeRegistry.getAddress(),
      callData,
    )
  ).wait();

  displaySuccess("TREASURY EXEMPTION PROPOSAL CREATED!");
  console.log(`   Transaction: ${receipt.hash}`);
  console.log(`   Title: ${title}`);
  console.log(`   Target: InvestorTypeRegistry.setInvestorLimitExempt`);
  console.log("\n💡 Next: option 77 votes, option 78 executes after the delay");
}

/**
 * Helper: Create ComplianceRules proposal
 * @private
 */
async function _createComplianceRulesProposal(mod) {
  console.log("\n📝 CREATE COMPLIANCERULES PROPOSAL");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    displayError("Deploy VSC token first (option 21)");
    return;
  }

  console.log("\n🎯 Select compliance parameter to update:");
  console.log("1. Update jurisdiction rules (allowed/blocked countries)");
  console.log("2. Clear the token's jurisdiction rule (default rule applies)");
  console.log(
    "   (Investor limits are InvestorTypeConfig votes, type 0: Task 4.1)",
  );

  const actionChoice = await mod.promptUser("Select action (1-2): ");

  const complianceRules = mod.state.getContract("complianceRules");
  let title, description, callData;
  const target = await complianceRules.getAddress();
  const tokenAddress = await digitalToken.getAddress();

  switch (actionChoice) {
    case "1":
      // Update jurisdiction rules
      console.log("\n📍 JURISDICTION RULES:");
      console.log(
        "Enter allowed country codes (comma-separated, e.g., 840,826,392 for US,UK,JP)",
      );
      console.log(
        "Country codes: US=840, UK=826, JP=392, SG=702, HK=344, CN=156",
      );
      const allowedInput = await mod.promptUser("Allowed countries: ");
      const allowedCountries = allowedInput
        .split(",")
        .map((c) => parseInt(c.trim()));

      console.log(
        "Enter blocked country codes (comma-separated, or leave empty)",
      );
      const blockedInput = await mod.promptUser("Blocked countries: ");
      const blockedCountries = blockedInput
        ? blockedInput.split(",").map((c) => parseInt(c.trim()))
        : [];

      title = `Update Jurisdiction Rules`;
      description = `Set allowed countries: ${allowedInput}, blocked: ${blockedInput || "none"}`;
      callData = complianceRules.interface.encodeFunctionData(
        "setJurisdictionRule",
        [tokenAddress, allowedCountries, blockedCountries],
      );
      break;

    case "2":
      title = `Clear Jurisdiction Rule`;
      description = `Clear the token's own jurisdiction rule; the default rule applies`;
      callData = complianceRules.interface.encodeFunctionData(
        "clearJurisdictionRule",
        [tokenAddress],
      );
      break;

    default:
      displayError("Invalid choice");
      return;
  }

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const tx = await vanguardGovernance.createProposal(
    1, // ProposalType.ComplianceRules
    title,
    description,
    target,
    callData,
  );
  const receipt = await tx.wait();

  displaySuccess("COMPLIANCERULES PROPOSAL CREATED!");
  console.log(`   Transaction: ${receipt.hash}`);
  console.log(`   Title: ${title}`);
  console.log(`   Target: ComplianceRules`);
  console.log(`   Token: ${tokenAddress}`);
  console.log("\n💡 Next: Use option 77 to vote on this proposal");
}

module.exports = {
  PROPOSAL_TYPE_NAMES,
  _proposalTypeName,
  _thresholdsFor,
  createProposal,
  _createInvestorTypeConfigProposal,
  _createTreasuryExemptionProposal,
  _createComplianceRulesProposal,
};
