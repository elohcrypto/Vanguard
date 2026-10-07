/**
 * @fileoverview Governance options 74 and 79: deploy, time travel
 * @module GovernanceDeployFlow
 * @description Deploys VGT and VanguardGovernance and jumps past the newest active
 * proposal's deadline on a dev node.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { advancePast } = require("./ChainTime");
const { ethers } = require("hardhat");
const { PROPOSAL_TYPE_NAMES } = require("./GovernanceProposalFlow");

/** Option 74: Deploy Governance System */
async function deployGovernanceSystem(mod) {
  displaySection("DEPLOY GOVERNANCE TOKEN (VGT)", "🪙");

  const governanceToken = mod.state.getContract("governanceToken");
  if (governanceToken) {
    console.log("⚠️  Governance Token already deployed");
    console.log(`   Address: ${await governanceToken.getAddress()}`);
    return;
  }

  const identityRegistry = mod.state.getContract("identityRegistry");
  const complianceRules = mod.state.getContract("complianceRules");
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
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const govToken = await GovernanceToken.deploy(
      "Vanguard Governance Token",
      "VGT",
      identityRegistryAddr,
      complianceRulesAddr,
    );
    await govToken.waitForDeployment();
    const govTokenAddr = await govToken.getAddress();
    mod.state.setContract("governanceToken", govToken);
    console.log(`   ✅ GovernanceToken deployed: ${govTokenAddr}`);

    // Deploy VanguardGovernance
    console.log("\n📝 Step 2: Deploying VanguardGovernance contract...");
    const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
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
    const digitalToken = mod.state.getContract("digitalToken");
    const tokenAddr = digitalToken
      ? await digitalToken.getAddress()
      : ethers.ZeroAddress;
    const oracleManager = mod.state.getContract("oracleManager");
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
    mod.state.setContract("vanguardGovernance", vanguardGovernance);
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
    const deployerAddr = mod.state.signers[0].address;
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
    console.log("   ✅ REAL KYC/AML enforcement enabled for governance tokens");

    // D21: governance holds VGT fees as a TRUSTED CONTRACT, not as an
    // identity. Fee pulls (createProposal/castVote) and refunds
    // (claimRefund) skip governance's own identity check; the human
    // counterparty is still checked. A contract identity's claims lapse
    // and a registry agent could delete it, halting every vote.
    console.log("\n📝 Step 6: Trusting VanguardGovernance to hold VGT fees...");
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
    console.log(`👤 Owner: ${mod.state.signers[0].address}`);
    console.log(`🔒 Compliance: REAL KYC/AML enforcement via ComplianceRules`);
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
      const { quorumPct, approvalPct } = await mod._thresholdsFor(
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

/** Option 79: Time Travel (Fast Forward 9 Days) */
async function timeTravel9Days(mod) {
  displaySection("TIME TRAVEL - FAST FORWARD FOR VOTING", "⏰");

  try {
    console.log("\n📅 Current blockchain time will be advanced by 9 days");
    console.log("   • 7 days for voting period");
    console.log("   • 2 days for execution delay");
    console.log("");
    console.log("⚠️  This only works on local blockchain (Hardhat/Ganache)");
    console.log("");

    const confirm = await mod.promptUser("Proceed with time travel? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Time travel cancelled");
      return;
    }

    // Read the real deadline from the newest Active proposal rather than
    // assuming 9 days: the contract may have been deployed with a
    // timeScale, and a public network has to be WAITED out, not jumped.
    const vanguardGovernance = mod.state.getContract("vanguardGovernance");
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

module.exports = { deployGovernanceSystem, timeTravel9Days };
