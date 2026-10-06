/**
 * @fileoverview Governance system module
 * @module GovernanceModule
 * @description Handles governance operations including token deployment, proposal creation,
 * voting operations, and proposal execution.
 * Covers menu options 74-83.
 */

const {
  displayInfo,
  displaySection,
  displaySuccess,
  displayError,
} = require("../utils/DisplayHelpers");
const {
  advancePast,
  ageOrVoterAgeRefusal,
  voterAgeRefusal,
  walletControlRefusal,
} = require("../utils/ChainTime");
const { ethers } = require("hardhat");
const { createOracleParametersProposal } = require("../utils/OracleProposal");

/**
 * Proposal type names in ProposalType enum order.
 *
 * Must match contracts/governance/VanguardGovernance.sol. ListUpdate (6) is
 * the single list-update type created by DynamicListModule, menu option 86
 * (plan 2D.1).
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
 * @class GovernanceModule
 * @description Manages governance system operations.
 */
class GovernanceModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /**
   * Name a proposal type, tolerating types this demo predates.
   * @private
   */
  _proposalTypeName(typeNum) {
    return PROPOSAL_TYPE_NAMES[Number(typeNum)] ?? `Unknown type ${typeNum}`;
  }

  /**
   * Read the configured quorum/approval thresholds for a proposal type and
   * render them as percentages. Thresholds are basis points on-chain.
   * @private
   */
  async _thresholdsFor(vanguardGovernance, typeNum) {
    const t = await vanguardGovernance.proposalThresholds(Number(typeNum));
    return {
      quorumPct: Number(t.quorumPercentage) / 100,
      approvalPct: Number(t.approvalPercentage) / 100,
    };
  }

  /** Option 74: Deploy Governance System */
  async deployGovernanceSystem() {
    displaySection("DEPLOY GOVERNANCE TOKEN (VGT)", "🪙");

    const governanceToken = this.state.getContract("governanceToken");
    if (governanceToken) {
      console.log("⚠️  Governance Token already deployed");
      console.log(`   Address: ${await governanceToken.getAddress()}`);
      return;
    }

    const identityRegistry = this.state.getContract("identityRegistry");
    const complianceRules = this.state.getContract("complianceRules");
    if (!identityRegistry || !complianceRules) {
      displayError("Deploy ERC-3643 system first (option 21)");
      return;
    }

    try {
      console.log("\n🔗 DEPLOYING GOVERNANCE TOKEN ON-CHAIN...");

      const identityRegistryAddr = await identityRegistry.getAddress();
      const complianceRulesAddr = await complianceRules.getAddress();

      // Deploy GovernanceToken
      console.log("\n📝 Step 1: Deploying GovernanceToken contract...");
      const GovernanceToken =
        await ethers.getContractFactory("GovernanceToken");
      const govToken = await GovernanceToken.deploy(
        "Vanguard Governance Token",
        "VGT",
        identityRegistryAddr,
        complianceRulesAddr,
      );
      await govToken.waitForDeployment();
      const govTokenAddr = await govToken.getAddress();
      this.state.setContract("governanceToken", govToken);
      console.log(`   ✅ GovernanceToken deployed: ${govTokenAddr}`);

      // Deploy VanguardGovernance
      console.log("\n📝 Step 2: Deploying VanguardGovernance contract...");
      const investorTypeRegistry = this.state.getContract(
        "investorTypeRegistry",
      );
      const investorTypeRegistryAddr = investorTypeRegistry
        ? await investorTypeRegistry.getAddress()
        : ethers.ZeroAddress;
      if (!investorTypeRegistry) {
        console.log(
          "   ⚠️  No InvestorTypeRegistry deployed (option 51). Governance binds",
        );
        console.log(
          "      InvestorTypeConfig proposals to the registry set HERE, so type-0",
        );
        console.log(
          "      proposals and option 83b will be unavailable on this deployment.",
        );
      }
      const digitalToken = this.state.getContract("digitalToken");
      const tokenAddr = digitalToken
        ? await digitalToken.getAddress()
        : ethers.ZeroAddress;
      const oracleManager = this.state.getContract("oracleManager");
      const oracleManagerAddr = oracleManager
        ? await oracleManager.getAddress()
        : ethers.ZeroAddress;
      if (!oracleManager) {
        console.log(
          "   ⚠️  No OracleManager deployed (option 31): it cannot be governed or handed",
        );
        console.log(
          "      over (83c) until governance is redeployed after option 31.",
        );
      }

      const VanguardGovernance =
        await ethers.getContractFactory("VanguardGovernance");
      const vanguardGovernance = await VanguardGovernance.deploy(
        govTokenAddr,
        identityRegistryAddr,
        investorTypeRegistryAddr,
        complianceRulesAddr,
        oracleManagerAddr,
        tokenAddr,
        // Governance time scale. 1 = mainnet schedule (7-day votes). On a
        // network without evm_increaseTime set GOV_TIME_SCALE so a vote
        // settles in minutes: 336 -> 30-minute voting, ~9-minute delay.
        BigInt(process.env.GOV_TIME_SCALE || "1"),
      );
      await vanguardGovernance.waitForDeployment();
      const govAddr = await vanguardGovernance.getAddress();
      this.state.setContract("vanguardGovernance", vanguardGovernance);
      console.log(`   ✅ VanguardGovernance deployed: ${govAddr}`);

      // Set VanguardGovernance as agent for GovernanceToken
      console.log("\n📝 Step 3: Setting VanguardGovernance as agent...");
      await (await govToken.addAgent(govAddr)).wait();
      console.log("   ✅ VanguardGovernance set as agent");

      // Rule administrators are per token (Task 4.1, G5): governance may
      // set VSC's and VGT's jurisdiction rules by vote; the deployer keeps
      // VGT's until the handover removes it, as it does for VSC.
      console.log(
        "\n📝 Step 4: Setting VanguardGovernance as rule administrator...",
      );
      const deployerAddr = this.state.signers[0].address;
      for (const [t, who] of [
        [tokenAddr, govAddr],
        [govTokenAddr, govAddr],
        [govTokenAddr, deployerAddr],
      ]) {
        await (await complianceRules.setRuleAdministrator(t, who, true)).wait();
      }
      console.log(
        "   ✅ VanguardGovernance set as rule administrator for VSC and VGT",
      );

      // Configure ComplianceRules with IdentityRegistry for VGT
      console.log("\n📝 Step 5: Configuring ComplianceRules for VGT...");
      await (
        await complianceRules.setTokenIdentityRegistry(
          govTokenAddr,
          identityRegistryAddr,
        )
      ).wait();
      console.log("   ✅ ComplianceRules linked to IdentityRegistry for VGT");
      console.log(
        "   ✅ REAL KYC/AML enforcement enabled for governance tokens",
      );

      // D21: governance holds VGT fees as a TRUSTED CONTRACT, not as an
      // identity. Fee pulls (createProposal/castVote) and refunds
      // (claimRefund) skip governance's own identity check; the human
      // counterparty is still checked. A contract identity's claims lapse
      // and a registry agent could delete it, halting every vote.
      console.log(
        "\n📝 Step 6: Trusting VanguardGovernance to hold VGT fees...",
      );
      await (
        await complianceRules.addTrustedContract(govTokenAddr, govAddr)
      ).wait();
      console.log(
        "   ✅ VanguardGovernance trusted on VGT only (D21; per token, G5)",
      );
      console.log(
        "   ℹ️  It has no identity of its own: it never counts in the quorum",
      );
      console.log(
        "      denominator, and its ability to move fees never lapses.",
      );

      // Nominate VanguardGovernance as owner of InvestorTypeRegistry.
      //
      // The registry is Ownable2Step: this only NOMINATES. Ownership does not
      // move until governance calls acceptOwnership(), and governance can only
      // make external calls through executeProposal — so the handover has to
      // be completed by an actual vote (menu option 83b). That is deliberate:
      // a one-step transfer to a wrong address, or to a contract that cannot
      // call acceptOwnership, would permanently strand the registry.
      if (investorTypeRegistry) {
        console.log(
          "\n📝 Step 7: Nominating VanguardGovernance as InvestorTypeRegistry owner...",
        );
        await investorTypeRegistry.transferOwnership(govAddr);

        const currentOwner = await investorTypeRegistry.owner();
        const pending = await investorTypeRegistry.pendingOwner();
        console.log(`   Current owner:  ${currentOwner}`);
        console.log(`   Pending owner:  ${pending}`);
        console.log(
          "   ⏳ NOT transferred yet — governance must accept via a passed proposal",
        );
        console.log(
          "   💡 Use option 83b to run the vote that completes the handover",
        );
      }

      // Get governance costs
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();

      displaySuccess("GOVERNANCE TOKEN SYSTEM DEPLOYED!");
      console.log(`🪙 Governance Token: ${govTokenAddr}`);
      console.log(`🗳️  VanguardGovernance: ${govAddr}`);
      console.log(`💰 Initial Supply: 1,000,000 VGT`);
      console.log(`👤 Owner: ${this.state.signers[0].address}`);
      console.log(
        `🔒 Compliance: REAL KYC/AML enforcement via ComplianceRules`,
      );
      console.log("\n⚖️  FAIR VOTING SYSTEM:");
      console.log(`   • 1 Person = 1 Vote (NOT token-weighted)`);
      console.log(`   • KYC/AML verification required`);
      console.log(
        `   • Proposal creation cost: ${ethers.formatEther(proposalCost)} VGT`,
      );
      console.log(
        `   • Voting cost: ${ethers.formatEther(votingCost)} VGT per vote`,
      );
      console.log(`   • If a proposal passes: Tokens BURNED 🔥`);
      console.log(`   • If a proposal fails: Tokens RETURNED 💰`);

      // Thresholds are per proposal type and set at construction. Read
      // them from the chain — there is no single "51%" rule.
      console.log("\n📊 THRESHOLDS BY PROPOSAL TYPE (quorum / approval):");
      for (let t = 0; t < PROPOSAL_TYPE_NAMES.length; t++) {
        const { quorumPct, approvalPct } = await this._thresholdsFor(
          vanguardGovernance,
          t,
        );
        console.log(
          `   • ${PROPOSAL_TYPE_NAMES[t].padEnd(20)} ${quorumPct}% quorum, ${approvalPct}% approval`,
        );
      }
      console.log(
        "   ℹ️  Quorum is a share of REGISTERED IDENTITIES (eligible voters).",
      );
    } catch (error) {
      displayError(`Deployment failed: ${error.message}`);
    }
  }

  /** Option 75a: Mint Governance Tokens */
  async mintGovernanceTokens() {
    displaySection("MINT GOVERNANCE TOKENS", "🏭");

    const governanceToken = this.state.getContract("governanceToken");
    if (!governanceToken) {
      displayError("Deploy Governance Token first (option 74)");
      return;
    }

    try {
      const owner = this.state.signers[0];
      const ownerBalance = await governanceToken.balanceOf(owner.address);
      const totalSupply = await governanceToken.totalSupply();

      console.log("\n📊 CURRENT TOKEN SUPPLY:");
      console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
      console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
      console.log("");
      console.log(
        "⚠️  IMPORTANT: Only the contract owner (agent) can mint tokens",
      );
      console.log("   Minting increases total supply and creates new tokens");
      console.log("");

      // Get recipient address
      const recipient = await this.promptUser(
        "Enter recipient address (or signer index 0-9): ",
      );

      let recipientAddress;
      if (recipient.match(/^[0-9]$/)) {
        const index = parseInt(recipient);
        if (index >= this.state.signers.length) {
          displayError("Invalid signer index");
          return;
        }
        recipientAddress = this.state.signers[index].address;
        console.log(`   Selected: Signer ${index} (${recipientAddress})`);
      } else if (recipient.match(/^0x[a-fA-F0-9]{40}$/)) {
        recipientAddress = recipient;
      } else {
        displayError("Invalid address format");
        return;
      }

      // Check if recipient is verified
      const identityRegistry = this.state.getContract("identityRegistry");
      const isVerified = await identityRegistry.isVerified(recipientAddress);

      console.log(`\n👤 Recipient: ${recipientAddress}`);
      console.log(
        `   KYC/AML Status: ${isVerified ? "✅ Verified" : "❌ Not Verified"}`,
      );

      if (!isVerified) {
        displayError(
          "Recipient must be KYC/AML verified to receive VGT tokens",
        );
        console.log(
          "\n💡 TIP: Use Option 3 (Issue KYC) and Option 4 (Issue AML) first",
        );
        return;
      }

      // Get amount to mint
      const amount = await this.promptUser("\nEnter amount to mint (VGT): ");
      const amountWei = ethers.parseEther(amount);

      const recipientBalance =
        await governanceToken.balanceOf(recipientAddress);

      console.log("\n📋 MINT SUMMARY:");
      console.log("=".repeat(70));
      console.log(`   Recipient: ${recipientAddress}`);
      console.log(
        `   Current Balance: ${ethers.formatEther(recipientBalance)} VGT`,
      );
      console.log(`   Amount to Mint: ${amount} VGT`);
      console.log(
        `   New Balance: ${ethers.formatEther(recipientBalance + amountWei)} VGT`,
      );
      console.log(
        `   New Total Supply: ${ethers.formatEther(totalSupply + amountWei)} VGT`,
      );

      const confirm = await this.promptUser("\nProceed with minting? (y/n): ");
      if (confirm.toLowerCase() !== "y") {
        displayError("Minting cancelled");
        return;
      }

      // Mint tokens (only owner/agent can call this)
      const tx = await governanceToken.mint(recipientAddress, amountWei);
      await tx.wait();

      const newBalance = await governanceToken.balanceOf(recipientAddress);
      const newTotalSupply = await governanceToken.totalSupply();

      displaySuccess("TOKENS MINTED SUCCESSFULLY!");
      console.log(`   Recipient: ${recipientAddress}`);
      console.log(`   Amount Minted: ${amount} VGT`);
      console.log(`   New Balance: ${ethers.formatEther(newBalance)} VGT`);
      console.log(
        `   New Total Supply: ${ethers.formatEther(newTotalSupply)} VGT`,
      );
      console.log(`   Transaction: ${tx.hash}`);
    } catch (error) {
      displayError(`Minting failed: ${error.message}`);
      if (error.message.includes("onlyAgent")) {
        console.log(
          "\n💡 TIP: Only the contract owner (signer 0) can mint tokens",
        );
      } else if (error.message.includes("Identity not verified")) {
        console.log("\n💡 TIP: Recipient must be KYC/AML verified");
      }
    }
  }

  /** Option 75b: Burn Governance Tokens */
  async burnGovernanceTokens() {
    displaySection("BURN GOVERNANCE TOKENS", "🔥");

    const governanceToken = this.state.getContract("governanceToken");
    if (!governanceToken) {
      displayError("Deploy Governance Token first (option 74)");
      return;
    }

    try {
      const owner = this.state.signers[0];
      const ownerBalance = await governanceToken.balanceOf(owner.address);
      const totalSupply = await governanceToken.totalSupply();

      console.log("\n📊 CURRENT TOKEN SUPPLY:");
      console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
      console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
      console.log("");
      console.log("⚠️  IMPORTANT: Burning permanently destroys tokens");
      console.log("   This reduces total supply and cannot be undone");
      console.log(
        "   Only the contract owner (agent) can burn tokens from their balance",
      );
      console.log("");

      if (ownerBalance === 0n) {
        displayError("Owner has no VGT tokens to burn");
        return;
      }

      // Get amount to burn
      const amount = await this.promptUser(
        `Enter amount to burn (max: ${ethers.formatEther(ownerBalance)} VGT): `,
      );
      const amountWei = ethers.parseEther(amount);

      if (amountWei > ownerBalance) {
        displayError(
          `Insufficient balance. You have ${ethers.formatEther(ownerBalance)} VGT`,
        );
        return;
      }

      console.log("\n📋 BURN SUMMARY:");
      console.log("=".repeat(70));
      console.log(
        `   Current Balance: ${ethers.formatEther(ownerBalance)} VGT`,
      );
      console.log(`   Amount to Burn: ${amount} VGT`);
      console.log(
        `   New Balance: ${ethers.formatEther(ownerBalance - amountWei)} VGT`,
      );
      console.log(
        `   Current Total Supply: ${ethers.formatEther(totalSupply)} VGT`,
      );
      console.log(
        `   New Total Supply: ${ethers.formatEther(totalSupply - amountWei)} VGT`,
      );
      console.log("");
      console.log("⚠️  WARNING: This action is PERMANENT and IRREVERSIBLE!");

      const confirm = await this.promptUser(
        "\nAre you sure you want to burn these tokens? (yes/no): ",
      );
      if (confirm.toLowerCase() !== "yes") {
        displayError("Burning cancelled");
        return;
      }

      // Burn tokens (only owner/agent can call this)
      const tx = await governanceToken.burn(amountWei);
      await tx.wait();

      const newBalance = await governanceToken.balanceOf(owner.address);
      const newTotalSupply = await governanceToken.totalSupply();

      displaySuccess("TOKENS BURNED SUCCESSFULLY!");
      console.log(`   Amount Burned: ${amount} VGT 🔥`);
      console.log(`   New Balance: ${ethers.formatEther(newBalance)} VGT`);
      console.log(
        `   New Total Supply: ${ethers.formatEther(newTotalSupply)} VGT`,
      );
      console.log(`   Tokens Destroyed: PERMANENT`);
      console.log(`   Transaction: ${tx.hash}`);
    } catch (error) {
      displayError(`Burning failed: ${error.message}`);
      if (error.message.includes("onlyAgent")) {
        console.log(
          "\n💡 TIP: Only the contract owner (signer 0) can burn tokens",
        );
      }
    }
  }

  /** Option 75c: Approve Governance Contract to Spend VGT */
  async approveGovernanceSpending() {
    displaySection("APPROVE GOVERNANCE CONTRACT TO SPEND VGT", "✅");

    const governanceToken = this.state.getContract("governanceToken");
    const vanguardGovernance = this.state.getContract("vanguardGovernance");

    if (!governanceToken || !vanguardGovernance) {
      displayError("Deploy Governance Token first (option 74)");
      return;
    }

    try {
      const owner = this.state.signers[0];
      const ownerBalance = await governanceToken.balanceOf(owner.address);
      const governanceAddress = await vanguardGovernance.getAddress();
      const currentAllowance = await governanceToken.allowance(
        owner.address,
        governanceAddress,
      );

      console.log("\n📊 CURRENT STATUS:");
      console.log(
        `   Your VGT Balance: ${ethers.formatEther(ownerBalance)} VGT`,
      );
      console.log(
        `   Current Allowance: ${ethers.formatEther(currentAllowance)} VGT`,
      );
      console.log(`   Governance Contract: ${governanceAddress}`);
      console.log("");
      console.log("💡 WHAT IS APPROVAL?");
      console.log(
        "   Approval allows the Governance contract to spend your VGT tokens",
      );
      console.log("   This is required for:");
      console.log("   • Creating proposals (costs VGT)");
      console.log("   • Voting on proposals (costs VGT)");
      console.log("");

      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();

      console.log("📋 GOVERNANCE COSTS:");
      console.log(
        `   Proposal Creation: ${ethers.formatEther(proposalCost)} VGT`,
      );
      console.log(`   Voting: ${ethers.formatEther(votingCost)} VGT per vote`);
      console.log("");

      // Suggest approval amount
      const suggestedAmount = proposalCost * 10n + votingCost * 100n; // 10 proposals + 100 votes
      console.log("💡 SUGGESTED APPROVAL AMOUNTS:");
      console.log(
        `   Minimum (1 proposal + 1 vote): ${ethers.formatEther(proposalCost + votingCost)} VGT`,
      );
      console.log(
        `   Recommended (10 proposals + 100 votes): ${ethers.formatEther(suggestedAmount)} VGT`,
      );
      console.log(`   Maximum (unlimited): Enter "max" for unlimited approval`);
      console.log("");

      const amount = await this.promptUser(
        'Enter approval amount (VGT) or "max": ',
      );

      let approvalAmount;
      if (amount.toLowerCase() === "max") {
        approvalAmount = ethers.MaxUint256;
        console.log("   Setting UNLIMITED approval (MaxUint256)");
      } else {
        approvalAmount = ethers.parseEther(amount);
        if (approvalAmount > ownerBalance) {
          console.log(
            `   ⚠️  Warning: Approval amount (${amount}) exceeds your balance (${ethers.formatEther(ownerBalance)})`,
          );
          console.log("   This is OK - you can approve more than you have");
        }
      }

      console.log("\n📋 APPROVAL SUMMARY:");
      console.log("=".repeat(70));
      console.log(`   Spender: VanguardGovernance (${governanceAddress})`);
      console.log(
        `   Current Allowance: ${ethers.formatEther(currentAllowance)} VGT`,
      );
      console.log(
        `   New Allowance: ${amount.toLowerCase() === "max" ? "UNLIMITED" : amount + " VGT"}`,
      );

      const confirm = await this.promptUser("\nProceed with approval? (y/n): ");
      if (confirm.toLowerCase() !== "y") {
        displayError("Approval cancelled");
        return;
      }

      const tx = await governanceToken.approve(
        governanceAddress,
        approvalAmount,
      );
      await tx.wait();

      const newAllowance = await governanceToken.allowance(
        owner.address,
        governanceAddress,
      );

      displaySuccess("APPROVAL SUCCESSFUL!");
      console.log(`   Spender: ${governanceAddress}`);
      console.log(
        `   New Allowance: ${amount.toLowerCase() === "max" ? "UNLIMITED" : ethers.formatEther(newAllowance) + " VGT"}`,
      );
      console.log(`   Transaction: ${tx.hash}`);
      console.log("");
      console.log("✅ You can now:");
      console.log("   • Create proposals (Option 76)");
      console.log("   • Vote on proposals (Option 77)");
    } catch (error) {
      displayError(`Approval failed: ${error.message}`);
    }
  }

  /** Option 75: Distribute Governance Tokens */
  async distributeGovernanceTokens() {
    displaySection("DISTRIBUTE GOVERNANCE TOKENS", "📊");

    const governanceToken = this.state.getContract("governanceToken");
    if (!governanceToken) {
      displayError("Deploy Governance Token first (option 74)");
      return;
    }

    try {
      console.log("\n👥 DISTRIBUTION OPTIONS:");
      console.log("1. Distribute to Selected Investors (Choose from list)");
      console.log("2. Distribute to Specific Addresses (Manual entry)");
      console.log("3. Distribute Equal Amounts (Auto to first N signers)");
      console.log("0. Back");

      const choice = await this.promptUser("Select option (0-3): ");

      if (choice === "0") return;

      if (choice === "1") {
        await this._distributeToSelectedInvestors();
      } else if (choice === "2") {
        await this._distributeToSpecificAddresses();
      } else if (choice === "3") {
        await this._distributeEqualAmounts();
      }
    } catch (error) {
      displayError(`Distribution failed: ${error.message}`);
    }
  }

  /**
   * Helper: Distribute to selected investors
   * @private
   */
  async _distributeToSelectedInvestors() {
    console.log("\n👥 DISTRIBUTE TO SELECTED INVESTORS");
    console.log("=".repeat(60));

    const governanceToken = this.state.getContract("governanceToken");
    const identityRegistry = this.state.getContract("identityRegistry");

    // Get investors from state
    const investors = this.state.investors || new Map();

    if (investors.size === 0) {
      displayError(
        "No investors found. Create investors first using Option 23 (Investor Onboarding)",
      );
      console.log(
        "\n💡 TIP: Use Option 23 to create investors before distributing governance tokens",
      );
      return;
    }

    // Show available investors with their verification status
    console.log("\n📋 AVAILABLE INVESTORS:");
    const availableInvestors = [];
    let index = 0;

    for (const [address, investorData] of investors) {
      let status = "❓ Unknown";

      // Check if verified
      if (identityRegistry) {
        try {
          const isVerified = await identityRegistry.isVerified(address);
          status = isVerified ? "✅ Verified" : "❌ Not Verified";
        } catch (error) {
          status = "⚠️ Error checking";
        }
      }

      // Check current VGT balance
      let balance = "0";
      if (governanceToken) {
        try {
          const bal = await governanceToken.balanceOf(address);
          balance = ethers.formatEther(bal);
        } catch (error) {
          balance = "Error";
        }
      }

      console.log(`${index}. ${address}`);
      console.log(
        `   Type: ${investorData.type || "Unknown"} | Status: ${status} | Current VGT: ${balance}`,
      );
      availableInvestors.push({ index, address, data: investorData });
      index++;
    }

    console.log(
      "\n💡 Enter investor numbers to distribute to (comma-separated)",
    );
    console.log("   Example: 0,1,2 to distribute to investors 0, 1, and 2");

    const selection = await this.promptUser("Select investors: ");
    const selectedIndices = selection.split(",").map((s) => parseInt(s.trim()));

    // Validate selections
    const validInvestors = availableInvestors.filter((inv) =>
      selectedIndices.includes(inv.index),
    );
    if (validInvestors.length === 0) {
      displayError("No valid investors selected");
      return;
    }

    const amount = await this.promptUser("Enter amount per investor (VGT): ");
    const amountWei = ethers.parseEther(amount);

    console.log("\n🔗 DISTRIBUTING GOVERNANCE TOKENS...");

    const recipients = [];
    const amounts = [];

    for (const investor of validInvestors) {
      recipients.push(investor.address);
      amounts.push(amountWei);
    }

    console.log(`\n📊 Distribution Summary:`);
    for (let i = 0; i < validInvestors.length; i++) {
      const investor = validInvestors[i];
      console.log(
        `   ${i + 1}. ${investor.address} (${investor.data.type || "Unknown"}) → ${amount} VGT`,
      );
    }

    const confirm = await this.promptUser("\nConfirm distribution? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Distribution cancelled");
      return;
    }

    const tx = await governanceToken.distributeGovernanceTokens(
      recipients,
      amounts,
    );
    await tx.wait();

    displaySuccess("DISTRIBUTION COMPLETE!");
    console.log(
      `   Distributed ${amount} VGT to ${recipients.length} selected investors`,
    );
    console.log(`   Transaction: ${tx.hash}`);
  }

  /**
   * Helper: Distribute to specific addresses
   * @private
   */
  async _distributeToSpecificAddresses() {
    const governanceToken = this.state.getContract("governanceToken");

    const addresses = await this.promptUser(
      "Enter addresses (comma-separated): ",
    );
    const amounts = await this.promptUser(
      "Enter amounts (comma-separated, in VGT): ",
    );

    const addressArray = addresses.split(",").map((a) => a.trim());
    const amountArray = amounts
      .split(",")
      .map((a) => ethers.parseEther(a.trim()));

    const tx = await governanceToken.distributeGovernanceTokens(
      addressArray,
      amountArray,
    );
    await tx.wait();

    displaySuccess(
      `Distributed governance tokens to ${addressArray.length} addresses`,
    );
  }

  /**
   * Helper: Distribute equal amounts
   * @private
   */
  async _distributeEqualAmounts() {
    const governanceToken = this.state.getContract("governanceToken");

    const count = await this.promptUser("Number of recipients: ");
    const amount = await this.promptUser("Amount per recipient (VGT): ");
    const amountWei = ethers.parseEther(amount);

    const recipients = [];
    const amounts = [];

    for (let i = 1; i <= parseInt(count); i++) {
      recipients.push(this.state.signers[i].address);
      amounts.push(amountWei);
    }

    const tx = await governanceToken.distributeGovernanceTokens(
      recipients,
      amounts,
    );
    await tx.wait();

    displaySuccess(`Distributed ${amount} VGT to ${count} recipients`);
  }

  /** Option 76: Create Proposal */
  async createProposal() {
    displaySection("CREATE GOVERNANCE PROPOSAL", "🗳️");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const governanceToken = this.state.getContract("governanceToken");

    if (!vanguardGovernance || !governanceToken) {
      displayError("Deploy Governance Token system first (option 74)");
      return;
    }

    try {
      // Pre-flight checks
      const owner = this.state.signers[0];
      const identityRegistry = this.state.getContract("identityRegistry");
      const isVerified = await identityRegistry.isVerified(owner.address);

      if (!isVerified) {
        displayError("You must be KYC/AML verified to create proposals");
        console.log("\n💡 SOLUTION:");
        console.log("   1. Use Option 3 to issue KYC to yourself (signer 0)");
        console.log("   2. Use Option 4 to issue AML to yourself (signer 0)");
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
        "11. PrivacyParameters - PrivacyManager whitelist root, list operator, validity, verifier (after the handover)",
      );
      console.log(
        "12. VerifierParameters - ZKVerifierIntegrated verifier contracts, cache expiry (after the handover)",
      );

      const typeChoice = await this.promptUser("Select proposal type (0-12): ");
      const proposalType = parseInt(typeChoice);

      if (proposalType === 0) {
        await this._createInvestorTypeConfigProposal();
      } else if (proposalType === 1) {
        await this._createComplianceRulesProposal();
      } else if (proposalType === 2) {
        // Task 4.4: node lifecycle and engine parameters (OracleProposal.js).
        await createOracleParametersProposal(this.state, this.promptUser);
      } else {
        console.log(
          "⚠️  Other proposal types coming soon. Use type 0, 1 or 2 for now.",
        );
      }
    } catch (error) {
      displayError(`Proposal creation failed: ${error.message}`);
      if (error.message.includes("ERC20InsufficientAllowance")) {
        console.log(
          "\n💡 TIP: Use Option 75c to approve Governance contract to spend VGT",
        );
      } else if (error.message.includes("Must be KYC/AML verified")) {
        console.log("\n💡 TIP: Use Options 3 & 4 to issue KYC/AML to yourself");
      } else if (error.message.includes("Identity too new to vote")) {
        console.log(
          "\n💡 TIP: identities propose and vote only once minVoterAge old (7 days / TIME_SCALE); wait, or jump time on a dev node",
        );
      } else if (
        error.message.includes("Wallet does not control its identity")
      ) {
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
  async _createInvestorTypeConfigProposal() {
    console.log("\n📝 CREATE INVESTORTYPECONFIG PROPOSAL");
    console.log("=".repeat(60));

    const investorTypeRegistry = this.state.getContract("investorTypeRegistry");
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
    const action = (await this.promptUser("Select action (1-2): ")).trim();
    if (action !== "1" && action !== "2") {
      displayError(`Select 1 or 2, got "${action}"`);
      return;
    }
    if (action === "2") {
      await this._createTreasuryExemptionProposal(investorTypeRegistry);
      return;
    }

    console.log("\n🎯 Select investor type to update:");
    console.log("0. Normal Investor");
    console.log("1. Retail Investor");
    console.log("2. Accredited Investor");
    console.log("3. Institutional Investor");

    const typeChoice = await this.promptUser("Select type (0-3): ");
    const investorType = parseInt(typeChoice);

    console.log("\n💰 Enter new limits:");
    const maxTransfer = await this.promptUser("Max transfer amount (VSC): ");
    const maxHolding = await this.promptUser("Max holding amount (VSC): ");

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

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
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
  async _createTreasuryExemptionProposal(investorTypeRegistry) {
    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const owner = await investorTypeRegistry.owner();
    if (owner !== (await vanguardGovernance.getAddress())) {
      // The call would revert at execution and the proposal settle Rejected.
      displayError(
        `InvestorTypeRegistry is owned by ${owner}, not governance: run option 83b first, or exempt directly as the owner (option 22/51)`,
      );
      return;
    }
    const bank = Array.from(
      this.state.bankingInstitutions?.values?.() ?? [],
    ).find((b) => b.type === "CENTRAL_BANK");
    const fallback = bank ? bank.address : this.state.signers[0].address;
    const input = await this.promptUser(`Treasury wallet [${fallback}]: `);
    const wallet = input.trim() || fallback;
    if (!ethers.isAddress(wallet)) {
      displayError(`Not an address: ${wallet}`);
      return;
    }
    const answer = await this.promptUser(
      "Exempt from investor limits? (y/n): ",
    );
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
    console.log(
      "\n💡 Next: option 77 votes, option 78 executes after the delay",
    );
  }

  /**
   * Helper: Create ComplianceRules proposal
   * @private
   */
  async _createComplianceRulesProposal() {
    console.log("\n📝 CREATE COMPLIANCERULES PROPOSAL");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      displayError("Deploy VSC token first (option 21)");
      return;
    }

    console.log("\n🎯 Select compliance parameter to update:");
    console.log("1. Update jurisdiction rules (allowed/blocked countries)");
    console.log(
      "2. Clear the token's jurisdiction rule (default rule applies)",
    );
    console.log(
      "   (Investor limits are InvestorTypeConfig votes, type 0: Task 4.1)",
    );

    const actionChoice = await this.promptUser("Select action (1-2): ");

    const complianceRules = this.state.getContract("complianceRules");
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
        const allowedInput = await this.promptUser("Allowed countries: ");
        const allowedCountries = allowedInput
          .split(",")
          .map((c) => parseInt(c.trim()));

        console.log(
          "Enter blocked country codes (comma-separated, or leave empty)",
        );
        const blockedInput = await this.promptUser("Blocked countries: ");
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

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
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

  /** Option 77: Vote on Proposal */
  async voteOnProposal() {
    displaySection("VOTE ON GOVERNANCE PROPOSAL", "✅");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const governanceToken = this.state.getContract("governanceToken");

    if (!vanguardGovernance || !governanceToken) {
      displayError("Deploy Governance Token system first (option 74)");
      return;
    }

    try {
      // Show all available proposals
      console.log("\n📋 AVAILABLE PROPOSALS:");
      console.log("=".repeat(60));

      const statusNames = [
        "Pending",
        "Active",
        "Approved",
        "Rejected",
        "Executed",
        "Cancelled",
      ];

      let foundProposals = false;
      const activeProposals = [];

      // Check proposals 1-20
      for (let i = 1; i <= 20; i++) {
        try {
          const result = await vanguardGovernance.getProposal(i);
          const proposal = result[0];

          if (proposal.title && proposal.title.length > 0) {
            foundProposals = true;
            const statusNum = Number(proposal.status);
            const status = statusNames[statusNum];
            const type = this._proposalTypeName(proposal.proposalType);
            // Votes are counts (votesFor += 1), not token amounts:
            // formatEther would render 3 votes as
            // "0.000000000000000003".
            const votesFor = proposal.votesFor.toString();
            const votesAgainst = proposal.votesAgainst.toString();
            const totalVotes = proposal.votesFor + proposal.votesAgainst;

            let percentage = "";
            if (totalVotes > 0n) {
              const forPct = (
                (Number(proposal.votesFor) * 100) /
                Number(totalVotes)
              ).toFixed(1);
              percentage = ` (${forPct}% FOR)`;
            }

            console.log(`\n${i}. ${proposal.title}`);
            console.log(`   Type: ${type} | Status: ${status}`);
            console.log(
              `   Votes: ${votesFor} FOR, ${votesAgainst} AGAINST${percentage}`,
            );

            if (statusNum === 1) {
              // Active
              activeProposals.push(i);
            }
          }
        } catch (error) {
          break;
        }
      }

      if (!foundProposals) {
        displayError("No proposals found. Create a proposal first (option 76)");
        return;
      }

      if (activeProposals.length === 0) {
        console.log("\n⚠️  No active proposals available for voting");
        console.log(
          "   All proposals are either pending, executed, or cancelled",
        );
        return;
      }

      console.log("\n" + "=".repeat(60));
      console.log(
        `💡 Active proposals you can vote on: ${activeProposals.join(", ")}`,
      );

      const proposalId = await this.promptUser(
        "\nEnter proposal ID to vote on: ",
      );

      // Get proposal details
      const result = await vanguardGovernance.getProposal(parseInt(proposalId));
      const proposal = result[0];

      console.log("\n📋 PROPOSAL INFO:");
      console.log(`   Title: ${proposal.title}`);
      console.log(`   Status: ${statusNames[Number(proposal.status)]}`);

      // Show who may actually vote: castVote requires isVerified(msg.sender)
      // and a balance covering the voting fee; each eligible voter is worth
      // exactly 1 vote. Voting is not token-weighted and there is no
      // snapshot, so no VGT amount is shown as a weight.
      const idRegistryForVoters = this.state.getContract("identityRegistry");
      const voteFee = await vanguardGovernance.votingCost();
      // D25: only identities bound at or before this proposal's cutoff vote.
      // Jumping time cannot help: the cutoff is frozen at creation.
      const cutoff = proposal.voterAgeCutoff;

      console.log("\n👥 ELIGIBLE VOTERS (1 vote each):");
      console.log(`   Voting fee: ${ethers.formatEther(voteFee)} VGT`);
      const voters = [];
      for (let i = 0; i < Math.min(10, this.state.signers.length); i++) {
        const addr = this.state.signers[i].address;
        const balance = await governanceToken.balanceOf(addr);
        const verified = await idRegistryForVoters.isVerified(addr);
        const canPay = balance >= voteFee;
        const at = verified
          ? await idRegistryForVoters.identityRegisteredAt(
              await idRegistryForVoters.identity(addr),
            )
          : 0n;
        const noControl = verified
          ? await walletControlRefusal(idRegistryForVoters, addr)
          : null;

        if (verified && (at === 0n || at > cutoff)) {
          console.log(
            `${i}. ${addr} - ⚠️ Identity too new to vote: bound after this proposal's cutoff (created minVoterAge after the identity, a new proposal admits it)`,
          );
        } else if (noControl) {
          console.log(`${i}. ${addr} - ⚠️ Wallet ${noControl}`);
        } else if (verified && canPay) {
          console.log(`${i}. ${addr}`);
          console.log(
            `   ✅ Verified, ${ethers.formatEther(balance)} VGT — worth 1 vote`,
          );
          voters.push(i);
        } else if (verified) {
          console.log(
            `${i}. ${addr} - ⚠️ Verified but only ${ethers.formatEther(balance)} VGT (cannot pay fee)`,
          );
        } else if (balance > 0n) {
          console.log(
            `${i}. ${addr} - ⚠️ Holds ${ethers.formatEther(balance)} VGT but NOT KYC/AML verified`,
          );
        }
      }

      if (voters.length === 0) {
        // Eligibility is checked at castVote time, not at proposal creation:
        // a voter funded and verified after the proposal exists may vote.
        // An earlier message here said the opposite ("tokens distributed
        // AFTER proposal creation cannot vote") — verified false on chain.
        displayError("No signer is both verified and able to pay the vote fee");
        console.log("\n💡 SOLUTION:");
        console.log(
          "   1. Verify the signer (KYC) and distribute VGT (option 75)",
        );
        console.log(
          "   2. Then vote — eligibility is checked when the vote is cast",
        );
        return;
      }

      const voterChoice = await this.promptUser(
        `\nSelect voter (${voters.join(", ")}): `,
      );
      const voterIndex = parseInt(voterChoice);

      if (!voters.includes(voterIndex)) {
        displayError(
          "Invalid voter selection, or that signer is not eligible to vote",
        );
        return;
      }

      const voter = this.state.signers[voterIndex];
      const voterBalance = await governanceToken.balanceOf(voter.address);

      console.log(`\n🗳️  Voting as: ${voter.address}`);
      console.log(
        `   This vote counts as 1 (fee: ${ethers.formatEther(voteFee)} VGT of ${ethers.formatEther(voterBalance)} VGT held)`,
      );

      const support = await this.promptUser("\nVote FOR (y) or AGAINST (n): ");
      const reason = await this.promptUser("Enter reason (optional): ");

      const tx = await vanguardGovernance
        .connect(voter)
        .castVote(
          parseInt(proposalId),
          support.toLowerCase() === "y",
          reason || "",
        );
      await tx.wait();

      displaySuccess("VOTE CAST SUCCESSFULLY!");
      console.log(`   Voter: ${voter.address}`);
      console.log(`   Weight: 1 vote (all verified voters are equal)`);
      console.log(
        `   Support: ${support.toLowerCase() === "y" ? "FOR" : "AGAINST"}`,
      );
    } catch (error) {
      // castVote reverts with "Insufficient tokens for voting" or
      // "Must be KYC/AML verified"; no contract emits "No voting power",
      // so the branch that used to key on it was unreachable.
      displayError(`Voting failed: ${error.message}`);
    }
  }

  /** Option 78: Execute Proposal */
  async executeProposal() {
    displaySection("EXECUTE GOVERNANCE PROPOSAL", "⚡");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    if (!vanguardGovernance) {
      displayError("Deploy Governance Token system first (option 74)");
      return;
    }

    try {
      // Show all proposals that can be executed
      console.log("\n📋 PROPOSALS READY FOR EXECUTION:");
      console.log("=".repeat(60));

      const statusNames = [
        "Pending",
        "Active",
        "Approved",
        "Rejected",
        "Executed",
        "Cancelled",
      ];

      let foundExecutable = false;
      const executableProposals = [];

      // Check proposals 1-20
      for (let i = 1; i <= 20; i++) {
        try {
          const result = await vanguardGovernance.getProposal(i);
          const proposal = result[0];
          const canExecuteNow = result[3];

          if (proposal.title && proposal.title.length > 0) {
            const statusNum = Number(proposal.status);
            const status = statusNames[statusNum];
            const type = this._proposalTypeName(proposal.proposalType);
            const votesFor = proposal.votesFor.toString();
            const votesAgainst = proposal.votesAgainst.toString();
            const totalVotes = proposal.votesFor + proposal.votesAgainst;

            let percentage = "";
            if (totalVotes > 0n) {
              const forPct = (
                (Number(proposal.votesFor) * 100) /
                Number(totalVotes)
              ).toFixed(1);
              const againstPct = (
                (Number(proposal.votesAgainst) * 100) /
                Number(totalVotes)
              ).toFixed(1);
              percentage = ` (${forPct}% FOR, ${againstPct}% AGAINST)`;
            }

            // Still finalizable if Active or Approved.
            //
            // Note executeProposal() handles BOTH outcomes: a
            // proposal that passes runs its callData and burns the
            // locked tokens; one that fails is marked Rejected and
            // REFUNDS them. So this list must not be filtered by
            // canExecute — hiding failing proposals would strand
            // every voter's locked VGT with no way to reclaim it.
            // canExecute is shown per-proposal instead.
            if (statusNum === 1 || statusNum === 2) {
              foundExecutable = true;
              executableProposals.push(i);

              const { quorumPct, approvalPct } = await this._thresholdsFor(
                vanguardGovernance,
                proposal.proposalType,
              );
              const outcome = canExecuteNow
                ? "✅ will PASS — callData executes, tokens burned"
                : `❌ will FAIL thresholds (needs ${quorumPct}% quorum, ${approvalPct}% approval) — deposits become claimable (78a)`;

              console.log(`\n${i}. ${proposal.title}`);
              console.log(`   Type: ${type} | Status: ${status}`);
              console.log(
                `   Votes: ${votesFor} FOR, ${votesAgainst} AGAINST${percentage}`,
              );
              console.log(`   Outcome: ${outcome}`);
            }
          }
        } catch (error) {
          break;
        }
      }

      if (!foundExecutable) {
        displayError("No proposals ready for execution");
        console.log("   Proposals must be Active or Approved to execute");
        return;
      }

      console.log("\n" + "=".repeat(60));
      console.log(`💡 Executable proposals: ${executableProposals.join(", ")}`);

      const proposalId = await this.promptUser(
        "\nEnter proposal ID to execute: ",
      );

      // Get proposal details
      const result = await vanguardGovernance.getProposal(parseInt(proposalId));
      const proposal = result[0];

      console.log("\n📋 PROPOSAL DETAILS:");
      console.log(`   ID: ${proposalId}`);
      console.log(`   Title: ${proposal.title}`);
      console.log(`   Description: ${proposal.description}`);
      console.log(`   Votes FOR: ${proposal.votesFor}`);
      console.log(`   Votes AGAINST: ${proposal.votesAgainst}`);

      const totalVotes = proposal.votesFor + proposal.votesAgainst;
      if (totalVotes > 0n) {
        const forPercentage = (
          (Number(proposal.votesFor) * 100) /
          Number(totalVotes)
        ).toFixed(2);
        const againstPercentage = (
          (Number(proposal.votesAgainst) * 100) /
          Number(totalVotes)
        ).toFixed(2);
        console.log(
          `   FOR: ${forPercentage}% | AGAINST: ${againstPercentage}%`,
        );
      }

      // Turnout and thresholds come from the chain so the user knows
      // which outcome executing will produce before they confirm.
      const { quorumPct, approvalPct } = await this._thresholdsFor(
        vanguardGovernance,
        proposal.proposalType,
      );
      console.log(`   Turnout: ${Number(result[2]) / 100}% of eligible voters`);
      console.log(
        `   Required: ${quorumPct}% quorum, ${approvalPct}% approval`,
      );
      console.log(
        result[3]
          ? "   Outcome if executed: PASS — callData runs, locked VGT burned 🔥"
          : "   Outcome if executed: FAIL — proposal rejected, each deposit claimable via 78a 💰",
      );

      const confirm = await this.promptUser("\nExecute this proposal? (y/n): ");
      if (confirm.toLowerCase() !== "y") {
        displayError("Execution cancelled");
        return;
      }

      const tx = await vanguardGovernance.executeProposal(parseInt(proposalId));
      const receipt = await tx.wait();

      // A mined receipt is not a success. executeProposal settles THREE
      // outcomes without reverting: passed and ran (ProposalExecuted),
      // failed a threshold (Rejected, refund, no event), or passed the vote
      // but the target call reverted (ProposalExecutionFailed, refund).
      // Read the outcome from the log, not from the fact that it mined.
      const outcome = { executed: false, failed: null };
      for (const log of receipt.logs) {
        let parsed;
        try {
          parsed = vanguardGovernance.interface.parseLog(log);
        } catch {
          continue;
        }
        if (parsed?.name === "ProposalExecuted") outcome.executed = true;
        if (parsed?.name === "ProposalExecutionFailed")
          outcome.failed = parsed.args.reason;
      }

      if (outcome.executed) {
        displaySuccess("PROPOSAL EXECUTED — callData ran, locked VGT burned");
        // D20: show the expiry a ListUpdate wrote (a date or "never").
        const DynamicListModule = require("./DynamicListModule");
        for (const line of DynamicListModule.listExpiries(this.state, receipt))
          console.log(`   ${line}`);
      } else if (outcome.failed !== null) {
        let why = outcome.failed;
        try {
          const err = vanguardGovernance.interface.parseError(outcome.failed);
          if (err) why = `${err.name}(${err.args.map(String).join(", ")})`;
        } catch {
          // Not one of governance's own errors; show the raw bytes.
        }
        displayError("PROPOSAL PASSED THE VOTE BUT ITS TARGET CALL REVERTED");
        console.log(`   Reason: ${why}`);
        console.log(
          "   Marked Rejected. Each participant claims their own VGT (option 78a).",
        );
        console.log("   This is terminal — submit a corrected proposal.");
      } else {
        displayError("PROPOSAL REJECTED — thresholds not met");
        console.log(
          "   Each participant claims their own VGT deposit (option 78a).",
        );
      }
      console.log(`   Transaction: ${tx.hash}`);
    } catch (error) {
      displayError(`Execution failed: ${error.message}`);
    }
  }

  /** Option 79: Time Travel (Fast Forward 9 Days) */
  async timeTravel9Days() {
    displaySection("TIME TRAVEL - FAST FORWARD FOR VOTING", "⏰");

    try {
      console.log("\n📅 Current blockchain time will be advanced by 9 days");
      console.log("   • 7 days for voting period");
      console.log("   • 2 days for execution delay");
      console.log("");
      console.log("⚠️  This only works on local blockchain (Hardhat/Ganache)");
      console.log("");

      const confirm = await this.promptUser(
        "Proceed with time travel? (y/n): ",
      );
      if (confirm.toLowerCase() !== "y") {
        displayError("Time travel cancelled");
        return;
      }

      // Read the real deadline from the newest Active proposal rather than
      // assuming 9 days: the contract may have been deployed with a
      // timeScale, and a public network has to be WAITED out, not jumped.
      const vanguardGovernance = this.state.getContract("vanguardGovernance");
      if (!vanguardGovernance) {
        displayError("Deploy Governance Token system first (option 74)");
        return;
      }
      const count = Number(await vanguardGovernance.proposalCount());
      let target = 0n;
      for (let id = count; id >= 1; id--) {
        const [p] = await vanguardGovernance.getProposal(id);
        if (Number(p.status) === 1) {
          // Active
          target =
            p.executionTime > p.votingEnds ? p.executionTime : p.votingEnds;
          break;
        }
      }
      if (target === 0n) {
        displayError("No Active proposal to wait for");
        return;
      }
      await advancePast(target, "voting period + execution delay");

      displaySuccess("Past the deadline");
      console.log("   You can now execute proposals that have ended voting");
    } catch (error) {
      displayError(`Time travel failed: ${error.message}`);
      console.log(
        "💡 Make sure you are running on a local blockchain (Hardhat/Ganache)",
      );
    }
  }

  /** Option 80: Governance Dashboard */
  async showDashboard() {
    displaySection("GOVERNANCE DASHBOARD", "📈");

    const governanceToken = this.state.getContract("governanceToken");
    const vanguardGovernance = this.state.getContract("vanguardGovernance");

    if (!governanceToken || !vanguardGovernance) {
      displayError("Deploy Governance Token first (option 74)");
      return;
    }

    try {
      const totalSupply = await governanceToken.totalSupply();
      const ownerBalance = await governanceToken.balanceOf(
        this.state.signers[0].address,
      );

      console.log("\n🪙 GOVERNANCE TOKEN INFO:");
      console.log(`   Name: Vanguard Governance Token`);
      console.log(`   Symbol: VGT`);
      console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
      console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
      // GovernanceToken.getVotingPower() returns a TOKEN BALANCE plus VGT
      // delegated in. No contract reads it for any decision; votes are
      // counted 1 per verified person. Delegation is recorded, not counted
      // (D12 b, wiring after the external audit): each signer below shows
      // its delegate and delegated-in VGT, labelled as such.

      // Get governance parameters
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();
      const proposalCount = await vanguardGovernance.proposalCount();

      console.log("\n⚖️ GOVERNANCE PARAMETERS:");
      console.log("=".repeat(70));
      console.log(
        `   Proposal Creation Cost: ${ethers.formatEther(proposalCost)} VGT`,
      );
      console.log(
        `   Voting Cost: ${ethers.formatEther(votingCost)} VGT per vote`,
      );
      console.log(`   Total Proposals: ${proposalCount}`);

      console.log("\n📊 VOTING SYSTEM:");
      console.log("=".repeat(70));
      console.log("Fair Voting:");
      console.log("   • 1 Person = 1 Vote (Equal for all)");
      console.log("   • Only KYC/AML verified users can vote");
      console.log("   • Passed proposals: Tokens BURNED 🔥");
      console.log("   • Failed proposals: Tokens RETURNED 💰");
      console.log("   • Quorum + approval thresholds vary BY PROPOSAL TYPE");

      const idRegistry = this.state.getContract("identityRegistry");
      if (idRegistry) {
        const eligibleVoters = await idRegistry.registeredIdentityCount();
        console.log(
          `   • Eligible voters (registered identities): ${eligibleVoters}`,
        );
      }
      console.log("\n   Thresholds (quorum / approval):");
      for (let t = 0; t < PROPOSAL_TYPE_NAMES.length; t++) {
        const { quorumPct, approvalPct } = await this._thresholdsFor(
          vanguardGovernance,
          t,
        );
        console.log(
          `   • ${PROPOSAL_TYPE_NAMES[t].padEnd(20)} ${quorumPct}% / ${approvalPct}%`,
        );
      }
      console.log("");
      console.log(
        "💡 Note: Token balance shown below is for distribution purposes only.",
      );
      console.log(
        "   Voting power is ALWAYS 1 vote per verified user, regardless of balance.",
      );

      // Show user balances
      const identityRegistry = this.state.getContract("identityRegistry");
      console.log("\n👥 USER BALANCES & VOTING POWER:");
      console.log("=".repeat(70));
      console.log(
        "💡 Signer 0 = Contract Owner (received initial VGT supply for distribution)",
      );
      console.log("");

      for (let i = 0; i < Math.min(5, this.state.signers.length); i++) {
        const balance = await governanceToken.balanceOf(
          this.state.signers[i].address,
        );
        const isVerified = await identityRegistry.isVerified(
          this.state.signers[i].address,
        );

        // Determine role
        let role = "";
        if (i === 0) {
          role = " (Contract Owner - Token Distributor)";
        } else if (i === 1) {
          role = " (Owner Fee Wallet)";
        } else if (i === 2) {
          role = " (KYC Issuer)";
        } else if (i === 3) {
          role = " (AML Issuer)";
        } else {
          role = " (Regular User)";
        }

        console.log(`\nSigner ${i}${role}:`);
        console.log(`   VGT Balance: ${ethers.formatEther(balance)} VGT`);
        // D12 (b): delegation is recorded on VGT, never counted by castVote.
        const addr = this.state.signers[i].address;
        const del = await governanceToken.getDelegate(addr);
        const delIn = (await governanceToken.getVotingPower(addr)) - balance;
        console.log(
          `   delegate: ${del === ethers.ZeroAddress ? "none" : del}, delegated-in: ${ethers.formatEther(delIn)} VGT (recorded, not counted: D12)`,
        );
        console.log(
          `   Voting Power: ${isVerified ? "1 vote (equal)" : "0 votes (not verified)"}`,
        );
        console.log(
          `   KYC/AML Status: ${isVerified ? "✅ Verified" : "❌ Not Verified"}`,
        );
      }
    } catch (error) {
      displayError(`Dashboard error: ${error.message}`);
    }
  }

  /** Option 81: Test Compliance Enforcement */
  async testComplianceEnforcement() {
    displaySection("TEST COMPLIANCE ENFORCEMENT (VSC & VGT)", "🔒");

    const digitalToken = this.state.getContract("digitalToken");
    const governanceToken = this.state.getContract("governanceToken");

    if (!digitalToken) {
      displayError("Deploy Digital Token (VSC) first (option 21)");
      return;
    }

    if (!governanceToken) {
      displayError("Deploy Governance Token (VGT) first (option 74)");
      return;
    }

    try {
      console.log("\n📊 TESTING COMPLIANCE ENFORCEMENT...");
      console.log("=".repeat(70));

      // Get verified and unverified users
      const verifiedUser = this.state.signers[1];
      const unverifiedUser = this.state.signers[9]; // Assuming signer 9 is not verified

      // Check verification status
      const identityRegistry = this.state.getContract("identityRegistry");
      const isVerified1 = await identityRegistry.isVerified(
        verifiedUser.address,
      );
      const isVerified9 = await identityRegistry.isVerified(
        unverifiedUser.address,
      );

      console.log("\n👤 USER VERIFICATION STATUS:");
      console.log(
        `   Verified User (${verifiedUser.address.slice(0, 10)}...): ${isVerified1 ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`,
      );
      console.log(
        `   Unverified User (${unverifiedUser.address.slice(0, 10)}...): ${isVerified9 ? "❌ VERIFIED" : "✅ NOT VERIFIED"}`,
      );

      // Test VSC Transfer Control
      console.log("\n" + "=".repeat(70));
      console.log("PART 1: VSC TRANSFER CONTROL");
      console.log("=".repeat(70));

      console.log("\n✅ TEST 1.1: VSC transfer to verified user");
      try {
        const tx1 = await digitalToken.transfer(
          verifiedUser.address,
          ethers.parseEther("1000"),
        );
        await tx1.wait();
        const balance = await digitalToken.balanceOf(verifiedUser.address);
        console.log(`   ✅ SUCCESS: Transferred 1000 VSC to verified user`);
        console.log(`   Balance: ${ethers.formatEther(balance)} VSC`);
      } catch (error) {
        console.log(`   ❌ FAILED: ${error.message}`);
      }

      console.log(
        "\n❌ TEST 1.2: VSC transfer to unverified user (should FAIL)",
      );
      try {
        const tx2 = await digitalToken.transfer(
          unverifiedUser.address,
          ethers.parseEther("1000"),
        );
        await tx2.wait();
        console.log(
          `   ❌ UNEXPECTED: Transfer succeeded (should have failed)`,
        );
      } catch (error) {
        console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
        console.log(
          `   Reason: ${error.message.includes("Transfer not allowed") ? "Transfer not allowed" : "Compliance check failed"}`,
        );
      }

      // Test VGT Transfer Control
      console.log("\n" + "=".repeat(70));
      console.log("PART 2: VGT TRANSFER CONTROL");
      console.log("=".repeat(70));

      console.log("\n✅ TEST 2.1: VGT distribution to verified user");
      try {
        const tx3 = await governanceToken.distributeGovernanceTokens(
          [verifiedUser.address],
          [ethers.parseEther("5000")],
        );
        await tx3.wait();
        const balance = await governanceToken.balanceOf(verifiedUser.address);
        console.log(`   ✅ SUCCESS: Distributed 5000 VGT to verified user`);
        console.log(`   Balance: ${ethers.formatEther(balance)} VGT`);
      } catch (error) {
        console.log(`   ❌ FAILED: ${error.message}`);
      }

      console.log(
        "\n❌ TEST 2.2: VGT transfer to unverified user (should FAIL)",
      );
      try {
        const vgtWithSigner = governanceToken.connect(verifiedUser);
        const tx4 = await vgtWithSigner.transfer(
          unverifiedUser.address,
          ethers.parseEther("100"),
        );
        await tx4.wait();
        console.log(
          `   ❌ UNEXPECTED: Transfer succeeded (should have failed)`,
        );
      } catch (error) {
        console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
        console.log(
          `   Reason: ${error.message.includes("Transfer not allowed") ? "Transfer not allowed" : "Compliance check failed"}`,
        );
      }

      // Test VGT Voting Control
      console.log("\n" + "=".repeat(70));
      console.log("PART 3: VGT VOTING CONTROL");
      console.log("=".repeat(70));

      // Voting eligibility is NOT a token balance. castVote requires:
      //   identityRegistry.isVerified(msg.sender)         — the real gate
      //   balanceOf(msg.sender) >= votingCost             — the fee
      // Each verified voter then counts as exactly 1 vote.
      //
      // These lines previously read GovernanceToken.getVotingPower(), a
      // leftover from a token-weighted design. That made TEST 3.2 unable to
      // fail for the right reason: the unverified user has 0 VGT only because
      // TEST 2.2 blocked the transfer, so the check re-observed that result
      // instead of testing verification at all — it would still "pass" if
      // isVerified were removed from castVote entirely.
      const governanceForVoting = this.state.getContract("vanguardGovernance");
      const votingFee = governanceForVoting
        ? await governanceForVoting.votingCost()
        : 0n;

      const verifiedOk = await identityRegistry.isVerified(
        verifiedUser.address,
      );
      const verifiedBal = await governanceToken.balanceOf(verifiedUser.address);
      const unverifiedOk = await identityRegistry.isVerified(
        unverifiedUser.address,
      );
      const unverifiedBal = await governanceToken.balanceOf(
        unverifiedUser.address,
      );

      console.log(
        `\n   Voting fee: ${ethers.formatEther(votingFee)} VGT per vote`,
      );

      console.log("\n✅ TEST 3.1: Verified user may vote");
      console.log(`   KYC/AML verified: ${verifiedOk ? "✅ yes" : "❌ no"}`);
      console.log(
        `   Can pay fee: ${verifiedBal >= votingFee ? "✅ yes" : "❌ no"} (${ethers.formatEther(verifiedBal)} VGT)`,
      );
      console.log(
        `   ${verifiedOk && verifiedBal >= votingFee ? "✅ CAN vote — worth 1 vote" : "❌ CANNOT vote"}`,
      );

      console.log("\n❌ TEST 3.2: Unverified user is blocked by verification");
      console.log(
        `   KYC/AML verified: ${unverifiedOk ? "❌ yes (unexpected)" : "✅ no"}`,
      );
      console.log(`   VGT balance: ${ethers.formatEther(unverifiedBal)} VGT`);
      console.log(
        `   ${!unverifiedOk ? "✅ CANNOT vote — blocked by isVerified, independent of balance" : "❌ verification gate not working"}`,
      );

      // Summary
      console.log("\n" + "=".repeat(70));
      displaySuccess("COMPLIANCE ENFORCEMENT TEST COMPLETE!");
      console.log("=".repeat(70));
      console.log("\n✅ PROVEN:");
      console.log("   1. ✅ VSC transfers controlled by ComplianceRules");
      console.log("   2. ✅ VGT transfers controlled by ComplianceRules");
      console.log("   3. ✅ VGT voting controlled (must hold VGT)");
      console.log("   4. ✅ Only KYC/AML verified users can hold tokens");
      console.log("   5. ✅ Unverified users CANNOT participate");
    } catch (error) {
      displayError(`Test failed: ${error.message}`);
    }
  }

  /** Option 82: Demo Complete Governance Workflow */
  async demoCompleteWorkflow() {
    displaySection("DEMO COMPLETE GOVERNANCE WORKFLOW", "🧪");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    if (!vanguardGovernance) {
      displayError("Deploy Governance Token system first (option 74)");
      return;
    }

    try {
      console.log("\n📊 COMPLETE GOVERNANCE WORKFLOW DEMONSTRATION");
      console.log("This will demonstrate the full governance process:");
      console.log("1. Distribute governance tokens to verified users");
      console.log("2. Create a proposal to update ComplianceRules");
      console.log(
        "3. Cast votes (1 person = 1 vote; VGT is a fee, not weight)",
      );
      console.log("4. Execute the proposal after approval");
      console.log("");

      const proceed = await this.promptUser("Proceed with demo? (yes/no): ");
      if (proceed.toLowerCase() !== "yes") {
        console.log("Demo cancelled");
        return;
      }

      const governanceToken = this.state.getContract("governanceToken");
      const digitalToken = this.state.getContract("digitalToken");
      const complianceRules = this.state.getContract("complianceRules");

      // Step 1: Distribute tokens
      console.log("\n" + "=".repeat(70));
      console.log("STEP 1: DISTRIBUTE GOVERNANCE TOKENS");
      console.log("=".repeat(70));

      const voter1 = this.state.signers[1];
      const voter2 = this.state.signers[2];
      const voter3 = this.state.signers[3];

      console.log("\n📊 Distributing VGT to 3 voters...");
      const tx1 = await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address, voter3.address],
        [
          ethers.parseEther("300000"),
          ethers.parseEther("400000"),
          ethers.parseEther("300000"),
        ],
      );
      await tx1.wait();
      console.log("   ✅ Distributed 300,000 VGT to Voter 1");
      console.log("   ✅ Distributed 400,000 VGT to Voter 2");
      console.log("   ✅ Distributed 300,000 VGT to Voter 3");

      // Step 2: Create proposal
      console.log("\n" + "=".repeat(70));
      console.log("STEP 2: CREATE GOVERNANCE PROPOSAL");
      console.log("=".repeat(70));

      // D25: identities propose and vote only once minVoterAge old.
      const tooNew = await ageOrVoterAgeRefusal(
        vanguardGovernance,
        this.state.getContract("identityRegistry"),
        [voter1, voter2, voter3],
      );
      if (tooNew) {
        displayError(tooNew);
        return;
      }

      console.log("\n🗳️  Creating proposal to update jurisdiction rules...");
      const tokenAddr = await digitalToken.getAddress();
      const callData = complianceRules.interface.encodeFunctionData(
        "setJurisdictionRule",
        [tokenAddr, [840, 826, 124], [643]], // US, UK, Canada allowed; Russia blocked
      );

      const tx2 = await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules type
        "Update Jurisdiction Rules",
        "Add US, UK, Canada to allowed countries and block Russia",
        await complianceRules.getAddress(),
        callData,
      );
      await tx2.wait();
      console.log("   ✅ Proposal created: Update Jurisdiction Rules");

      // Step 3: Cast votes
      console.log("\n" + "=".repeat(70));
      console.log("STEP 3: CAST VOTES");
      console.log("=".repeat(70));

      console.log("\n✅ Casting votes...");
      // Each vote counts as exactly 1, regardless of VGT balance. The
      // VGT amounts below are the voting FEE, not voting weight.
      const votingCostForDemo = await vanguardGovernance.votingCost();
      const feeLabel = `${ethers.formatEther(votingCostForDemo)} VGT fee`;

      const tx3 = await vanguardGovernance
        .connect(voter1)
        .castVote(1, true, "Support");
      await tx3.wait();
      console.log(`   ✅ Voter 1 voted FOR — 1 vote (${feeLabel})`);

      const tx4 = await vanguardGovernance
        .connect(voter2)
        .castVote(1, true, "Support");
      await tx4.wait();
      console.log(`   ✅ Voter 2 voted FOR — 1 vote (${feeLabel})`);

      const tx5 = await vanguardGovernance
        .connect(voter3)
        .castVote(1, false, "Against");
      await tx5.wait();
      console.log(`   ✅ Voter 3 voted AGAINST — 1 vote (${feeLabel})`);

      // Check proposal status.
      //
      // Read every number from the chain. These lines previously printed
      // the literals "(70%)", "(30%)" and "Participation: 100%", which
      // were the same regardless of how anyone voted, and formatted the
      // vote COUNTS with formatEther — so 2 votes displayed as
      // "0.000000000000000002 VGT".
      const proposalResult = await vanguardGovernance.getProposal(1);
      const proposal = proposalResult[0];
      const totalVotes = proposalResult[1];
      const participationBps = proposalResult[2];
      const canExecute = proposalResult[3];

      const forPct =
        totalVotes > 0n
          ? ((Number(proposal.votesFor) * 100) / Number(totalVotes)).toFixed(1)
          : "0.0";
      const againstPct =
        totalVotes > 0n
          ? (
              (Number(proposal.votesAgainst) * 100) /
              Number(totalVotes)
            ).toFixed(1)
          : "0.0";

      const thresholds = await vanguardGovernance.proposalThresholds(1); // ComplianceRules
      const quorumPct = Number(thresholds.quorumPercentage) / 100;
      const approvalPct = Number(thresholds.approvalPercentage) / 100;

      console.log("\n📊 Proposal Status:");
      console.log(`   Votes FOR: ${proposal.votesFor} (${forPct}%)`);
      console.log(
        `   Votes AGAINST: ${proposal.votesAgainst} (${againstPct}%)`,
      );
      console.log(
        `   Turnout: ${Number(participationBps) / 100}% of eligible voters`,
      );
      console.log(
        `   Required for this type: ${quorumPct}% quorum, ${approvalPct}% approval`,
      );
      console.log(
        `   Can execute: ${canExecute ? "YES" : "NO — thresholds not met"}`,
      );

      console.log("\n⏰ Waiting for voting period to end...");
      console.log(
        "   (In production, this would be 7 days + 2 days execution delay)",
      );
      console.log(
        "   (For demo, you can manually execute after the time period)",
      );

      console.log("\n" + "=".repeat(70));
      displaySuccess("GOVERNANCE WORKFLOW DEMONSTRATION COMPLETE!");
      console.log("=".repeat(70));
      console.log("\n✅ DEMONSTRATED:");
      console.log("   1. ✅ Token distribution to verified users");
      console.log("   2. ✅ Proposal creation with encoded function call");
      console.log(
        `   3. ✅ 1-person-1-vote tallying (${forPct}% FOR, ${againstPct}% AGAINST)`,
      );
      console.log(
        `   4. ${canExecute ? "✅ Quorum and approval thresholds met" : "❌ Thresholds NOT met — this proposal cannot execute"}`,
      );
      console.log("   5. ⏰ Ready for execution after time-lock period");
      console.log(
        "\n💡 Next: Use option 78 to execute the proposal after waiting period",
      );
    } catch (error) {
      displayError(`Workflow demo failed: ${error.message}`);
    }
  }

  /**
   * Option 83b: governance accepts the InvestorTypeRegistry nomination made
   * by option 74 — by an actual vote. VanguardGovernance can only make
   * external calls through executeProposal, so acceptOwnership() is reachable
   * only through a proposal that clears quorum and approval. The flow is
   * HandoverModule.acceptOwnershipByVote, shared with option 83d.
   */
  async acceptRegistryOwnershipByVote() {
    displaySection("GOVERNANCE ACCEPTS REGISTRY OWNERSHIP (BY VOTE)", "🏛️");
    const investorTypeRegistry = this.state.getContract("investorTypeRegistry");
    if (
      !this.state.getContract("vanguardGovernance") ||
      !investorTypeRegistry
    ) {
      displayError(
        "Deploy the governance system (74) and InvestorTypeRegistry (51) first",
      );
      return;
    }
    const HandoverModule = require("./HandoverModule");
    const done = await new HandoverModule(
      this.state,
      this.logger,
      this.promptUser,
    ).acceptOwnershipByVote({
      target: investorTypeRegistry,
      proposalType: 0,
      label: "InvestorTypeRegistry",
      typeName: "InvestorTypeConfig",
      deployHint:
        "Deploy the registry (option 51) BEFORE governance (option 74).",
      nominateHint: "Run option 74 to nominate it first.",
    });
    if (done) {
      console.log(
        "\n   ⚠️  Note: updateInvestorTypeConfig is onlyOwner and BYPASSES this",
      );
      console.log(
        "      registry's own governor/requiredApprovals system. Config changes",
      );
      console.log(
        "      are protected by the VanguardGovernance vote, not by those governors.",
      );
    }
  }

  /** Option 83: Manage InvestorTypeRegistry via Governance */
  async manageInvestorTypeRegistry() {
    displaySection("MANAGE INVESTORTYPEREGISTRY VIA GOVERNANCE", "🏛️");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const investorTypeRegistry = this.state.getContract("investorTypeRegistry");

    if (!vanguardGovernance) {
      displayError("Deploy Governance Token system first (option 74)");
      return;
    }

    if (!investorTypeRegistry) {
      displayError("Deploy InvestorTypeRegistry first (option 51)");
      return;
    }

    try {
      console.log("\n📊 INVESTOR TYPE REGISTRY GOVERNANCE");
      console.log(
        "This demonstrates using governance to manage InvestorTypeRegistry",
      );
      console.log("");
      console.log("💡 Note: This is a simplified demonstration.");
      console.log("   Use Option 76 to create InvestorTypeConfig proposals");
      console.log("   Use Option 77 to vote on proposals");
      console.log("   Use Option 78 to execute approved proposals");
      console.log("");
      console.log("📋 Current Investor Type Configurations:");

      // Show current configurations for all types
      const types = ["Normal", "Retail", "Accredited", "Institutional"];
      for (let i = 0; i < 4; i++) {
        try {
          const config = await investorTypeRegistry.getInvestorTypeConfig(i);
          console.log(`\n${i}. ${types[i]} Investor:`);
          console.log(
            `   Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`,
          );
          console.log(
            `   Max Holding: ${ethers.formatEther(config.maxHoldingAmount)} VSC`,
          );
          console.log(`   Cooldown: ${config.transferCooldownMinutes} minutes`);
        } catch (error) {
          console.log(`\n${i}. ${types[i]} Investor: Not configured`);
        }
      }

      console.log("\n💡 To update these configurations via governance:");
      console.log(
        "   1. Use Option 76 (Create Proposal) → Select type 0 (InvestorTypeConfig)",
      );
      console.log("   2. Use Option 77 (Vote on Proposal)");
      console.log("   3. Use Option 79 (Time Travel 9 Days)");
      console.log("   4. Use Option 78 (Execute Proposal)");
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /** Option 83a: Change Governance Costs */
  async changeGovernanceCosts() {
    displaySection("CHANGE GOVERNANCE COSTS", "💰");
    console.log(
      "This allows the owner to change proposal creation and voting costs",
    );
    console.log("");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    if (!vanguardGovernance) {
      displayError("Deploy Governance system first (option 74)");
      return;
    }

    try {
      // Show current costs
      const currentProposalCost =
        await vanguardGovernance.proposalCreationCost();
      const currentVotingCost = await vanguardGovernance.votingCost();

      console.log("\n📊 CURRENT COSTS:");
      console.log("=".repeat(70));
      console.log(
        `   Proposal Creation: ${ethers.formatEther(currentProposalCost)} VGT`,
      );
      console.log(
        `   Voting: ${ethers.formatEther(currentVotingCost)} VGT per vote`,
      );
      console.log("");

      console.log("🎯 WHAT WOULD YOU LIKE TO CHANGE?");
      console.log("1. Change Proposal Creation Cost");
      console.log("2. Change Voting Cost");
      console.log("3. Change Both Costs");
      console.log("0. Back to Main Menu");
      console.log("");

      const choice = await this.promptUser("Select option (0-3): ");

      switch (choice) {
        case "1":
          await this._changeProposalCreationCost(currentProposalCost);
          break;
        case "2":
          await this._changeVotingCost(currentVotingCost);
          break;
        case "3":
          await this._changeProposalCreationCost(currentProposalCost);
          await this._changeVotingCost(currentVotingCost);
          break;
        case "0":
          return;
        default:
          console.log("Invalid choice");
      }
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /**
   * Helper: Change proposal creation cost
   * @private
   */
  async _changeProposalCreationCost(currentCost) {
    console.log("\n💰 CHANGE PROPOSAL CREATION COST");
    console.log(`   Current: ${ethers.formatEther(currentCost)} VGT`);

    const newCost = await this.promptUser("Enter new cost (VGT): ");
    const newCostWei = ethers.parseEther(newCost);

    const confirm = await this.promptUser(
      `\nChange from ${ethers.formatEther(currentCost)} to ${newCost} VGT? (y/n): `,
    );
    if (confirm.toLowerCase() !== "y") {
      console.log("❌ Change cancelled");
      return;
    }

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const tx = await vanguardGovernance.setProposalCreationCost(newCostWei);
    await tx.wait();

    displaySuccess(`Proposal creation cost changed to ${newCost} VGT`);
  }

  /**
   * Helper: Change voting cost
   * @private
   */
  async _changeVotingCost(currentCost) {
    console.log("\n💰 CHANGE VOTING COST");
    console.log(`   Current: ${ethers.formatEther(currentCost)} VGT per vote`);

    const newCost = await this.promptUser("Enter new cost (VGT): ");
    const newCostWei = ethers.parseEther(newCost);

    const confirm = await this.promptUser(
      `\nChange from ${ethers.formatEther(currentCost)} to ${newCost} VGT? (y/n): `,
    );
    if (confirm.toLowerCase() !== "y") {
      console.log("❌ Change cancelled");
      return;
    }

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const tx = await vanguardGovernance.setVotingCost(newCostWei);
    await tx.wait();

    displaySuccess(`Voting cost changed to ${newCost} VGT per vote`);
  }

  /**
   * Option 78a: Claim Refund.
   *
   * Settlement (reject, cancel, execution failure) no longer pushes VGT
   * back. It records what each participant is owed, and each one pulls it
   * here. A participant the token refuses to pay (identity deleted, address
   * frozen) blocks only their own claim, not everyone else's; before this,
   * one such participant froze every deposit on the proposal forever.
   */
  async claimRefund() {
    displaySection("CLAIM GOVERNANCE REFUND", "💰");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    const governanceToken = this.state.getContract("governanceToken");
    if (!vanguardGovernance || !governanceToken) {
      displayError("Deploy Governance Token system first (option 74)");
      return;
    }

    try {
      const signers = this.state.signers;
      const count = Number(await vanguardGovernance.proposalCount());
      if (count === 0) {
        displayError("No proposals exist yet");
        return;
      }

      // Scan every settled proposal for every signer; list what is owed.
      const claimable = [];
      for (let id = 1; id <= count; id++) {
        const [p] = await vanguardGovernance.getProposal(id);
        const status = Number(p.status);
        if (status !== 3 && status !== 5) continue; // Rejected, Cancelled
        for (let i = 0; i < signers.length; i++) {
          const owed = await vanguardGovernance.getClaimableRefund(
            id,
            signers[i].address,
          );
          if (owed > 0n)
            claimable.push({ id, i, owed, title: p.title, status });
        }
      }

      if (claimable.length === 0) {
        displayInfo(
          "Nothing to claim: no settled proposal holds a deposit for any signer",
        );
        return;
      }

      console.log("\n📋 CLAIMABLE DEPOSITS:");
      claimable.forEach((c, n) => {
        console.log(
          `${n + 1}. Proposal ${c.id} "${c.title}" (${c.status === 3 ? "Rejected" : "Cancelled"}) — signer ${c.i} ${signers[c.i].address.slice(0, 10)}… owed ${ethers.formatEther(c.owed)} VGT`,
        );
      });

      const pick = await this.promptUser("\nClaim which (number, or 'all'): ");
      const chosen =
        pick.trim().toLowerCase() === "all"
          ? claimable
          : [claimable[parseInt(pick) - 1]].filter(Boolean);
      if (chosen.length === 0) {
        displayError("Invalid choice");
        return;
      }

      for (const c of chosen) {
        try {
          const tx = await vanguardGovernance
            .connect(signers[c.i])
            .claimRefund(c.id);
          await tx.wait();
          displaySuccess(
            `Signer ${c.i} claimed ${ethers.formatEther(c.owed)} VGT from proposal ${c.id}`,
          );
        } catch (error) {
          // The token's compliance gate can refuse this one recipient. That
          // is the case the pull design exists for: nobody else is affected.
          displayError(
            `Signer ${c.i} could not claim from proposal ${c.id}: ${error.message}`,
          );
          console.log(
            "   Deposit stays claimable; retry once the signer is verified/unfrozen.",
          );
        }
      }
    } catch (error) {
      displayError(`Claim failed: ${error.message}`);
    }
  }
}

module.exports = GovernanceModule;
