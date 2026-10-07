/**
 * @fileoverview Investor type options 51 to 53: deploy, configurations, assignment
 * @module InvestorTypeSetupFlow
 * @description Deploys InvestorTypeRegistry, prints the type configurations, assigns types.
 * Moved out of demo/modules/InvestorTypeModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");
const { deployCustody } = require("./CustodyFlow");
const { wireInvestorRegistry } = require("./InvestorTypeRules");

/** Option 51: Deploy Investor Type System */
async function deployInvestorTypeSystem(mod) {
  displaySection("DEPLOY INVESTOR TYPE SYSTEM", "🏗️");

  try {
    // Deploy InvestorTypeRegistry
    console.log("📦 Deploying InvestorTypeRegistry...");
    const InvestorTypeRegistryFactory = await ethers.getContractFactory(
      "InvestorTypeRegistry",
    );
    const investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
    await investorTypeRegistry.waitForDeployment();
    const registryAddress = await investorTypeRegistry.getAddress();
    mod.state.setContract("investorTypeRegistry", investorTypeRegistry);
    console.log(`✅ InvestorTypeRegistry deployed: ${registryAddress}`);

    // Set up compliance officer
    console.log("👮 Setting up compliance officers...");
    try {
      await investorTypeRegistry.setComplianceOfficer(
        mod.state.signers[1].address,
        true,
      );
      console.log(
        `✅ Compliance officer configured: ${mod.state.signers[1].address}`,
      );
    } catch (error) {
      console.log("⚠️ Compliance officer setup failed:", error.message);
    }

    // Check if VanguardGovernance is already deployed
    // Try both 'governance' and 'vanguardGovernance' (Option 74 uses 'vanguardGovernance')
    const governance =
      mod.state.getContract("governance") ||
      mod.state.getContract("vanguardGovernance");

    if (governance) {
      console.log("🗳️ Integrating with existing VanguardGovernance...");
      try {
        // Set VanguardGovernance as authorized to update investor type rules
        const governanceAddress = await governance.getAddress();
        await investorTypeRegistry.setGovernance(governanceAddress);
        console.log(`✅ VanguardGovernance integrated: ${governanceAddress}`);
        console.log(
          "   💡 Investor type updates now require governance proposals",
        );
      } catch (error) {
        console.log("⚠️ Governance integration failed:", error.message);
        console.log("   💡 You can manually integrate later if needed");
      }
    } else {
      console.log("🗳️ VanguardGovernance not detected");
      console.log(
        "   💡 Deploy governance system first (Option 74) for democratic control",
      );
      console.log("   💡 Or continue with owner-based control for testing");
    }

    // Display basic system info
    console.log("\n📊 Basic System Information:");
    console.log("   📋 InvestorTypeRegistry: Deployed");
    console.log("   💡 Use option 52 to view detailed configurations");

    displaySuccess("INVESTOR TYPE SYSTEM DEPLOYED SUCCESSFULLY!");
    console.log("📊 System Status:");
    console.log(`   📋 InvestorTypeRegistry: ${registryAddress}`);
    console.log(`   👮 Compliance Officers: 1`);

    // Show governance status
    if (governance) {
      const governanceAddress = await governance.getAddress();
      console.log(`   🗳️ Governance: Integrated with VanguardGovernance`);
      console.log(`   📍 Governance Address: ${governanceAddress}`);
      console.log(`   ⚖️ Updates require governance proposals`);
    } else {
      console.log(`   🗳️ Governance: Not integrated (owner-based control)`);
      console.log(`   💡 Deploy Option 74 for democratic governance`);
    }

    // Task 2A.2: wire the registry into the Token whenever one already
    // exists, regardless of deploy order (option 21 then 51, or 51 then
    // 21 — option 21 does the symmetric call when the registry exists
    // first). Without this, ContractDeployer.js used to point operators at
    // option 52, a read-only dashboard that never calls
    // token.setInvestorTypeRegistry.
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    if (token) {
      console.log("\n🔗 Connecting InvestorTypeRegistry to VSC token...");
      try {
        await wireInvestorRegistry(token, investorTypeRegistry); // 4.10
        const wired = await token.investorTypeRegistry();
        console.log(`   ✅ Token.investorTypeRegistry(): ${wired}`);
        // D22 (a): mint now enforces holding caps; a treasury is exempt.
        // Owner only (D22): the deployer owns a freshly deployed registry.
        const canExempt =
          (await investorTypeRegistry.owner()) ===
          (await investorTypeRegistry.runner.getAddress());
        for (const bank of mod.state.bankingInstitutions?.values() || []) {
          if (bank.type !== "CENTRAL_BANK") continue;
          if (!canExempt) {
            console.log(
              "   central bank not exempt: after the handover only governance can exempt a treasury (InvestorTypeConfig vote)",
            );
            continue;
          }
          await (
            await investorTypeRegistry.setInvestorLimitExempt(
              bank.address,
              true,
            )
          ).wait();
          console.log(
            "   ✅ central bank exempt from investor limits (treasury, D22)",
          );
        }
        if (wired.toLowerCase() !== registryAddress.toLowerCase()) {
          console.log(
            `   ⚠️  Readback (${wired}) does not match deployed registry (${registryAddress})`,
          );
        }
        // Task 4.3: investor custody (option 23) needs this registry.
        console.log(
          "\n🔐 Deploying investor custody (InvestorRequestManager)...",
        );
        await deployCustody(mod.state);
      } catch (error) {
        console.log(
          `⚠️ Failed to connect InvestorTypeRegistry to token: ${error.message}`,
        );
      }
    } else {
      console.log(
        "\n💡 No VSC token deployed yet — connect automatically once option 21 deploys it",
      );
    }
  } catch (error) {
    displayError(`Investor Type System deployment failed: ${error.message}`);
  }
}

/** Option 52: Show Investor Type Configurations */
async function showInvestorTypeConfigurations(mod) {
  displaySection("SHOW INVESTOR TYPE CONFIGURATIONS", "📊");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    console.log("\n📋 CURRENT INVESTOR TYPE CONFIGURATIONS:");
    const investorTypes = [0, 1, 2, 3]; // Normal, Retail, Accredited, Institutional
    const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];
    const typeEmojis = ["👤", "🛒", "💼", "🏛️"];

    for (let i = 0; i < investorTypes.length; i++) {
      const config = await investorTypeRegistry.getInvestorTypeConfig(
        investorTypes[i],
      );
      console.log(
        `\n${typeEmojis[i]} ${typeNames[i]} Investor (Type ${investorTypes[i]}):`,
      );
      console.log(
        `   💰 Max Transfer Amount: ${ethers.formatEther(config.maxTransferAmount)} VSC`,
      );
      console.log(
        `   🏦 Max Holding Amount: ${ethers.formatEther(config.maxHoldingAmount)} VSC`,
      );
      console.log(
        `   🏆 Required Whitelist Tier: ${config.requiredWhitelistTier}`,
      );
      console.log(
        `   ⏰ Transfer Cooldown: ${config.transferCooldownMinutes} minutes`,
      );

      // Handle MaxUint256 (no threshold) case
      const thresholdDisplay =
        config.largeTransferThreshold.toString() ===
        ethers.MaxUint256.toString()
          ? "No threshold (all transfers normal)"
          : `${ethers.formatEther(config.largeTransferThreshold)} VSC`;
      console.log(`   🚨 Large Transfer Threshold: ${thresholdDisplay}`);

      console.log(
        `   📊 Enhanced Logging: ${config.enhancedLogging ? "✅ Enabled" : "❌ Disabled"}`,
      );
      console.log(
        `   🔐 Enhanced Privacy: ${config.enhancedPrivacy ? "✅ Enabled" : "❌ Disabled"}`,
      );
    }

    displaySuccess("INVESTOR TYPE CONFIGURATIONS DISPLAYED");
  } catch (error) {
    displayError(`Failed to show configurations: ${error.message}`);
  }
}

/** Option 53: Assign Investor Types */
async function assignInvestorTypes(mod) {
  displaySection("ASSIGN INVESTOR TYPES", "👥");
  console.log(
    "\n💡 This option shows investors from the INVESTOR ONBOARDING SYSTEM (Option 23)",
  );
  console.log(
    "💡 All investors here have proper KYC/AML, multi-sig wallets, and token locking.",
  );
  console.log("");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    // Check if we have investors from the onboarding system
    if (!mod.state.investors || mod.state.investors.size === 0) {
      console.log("\n❌ NO INVESTORS FOUND!");
      console.log("");
      console.log("💡 To create investors with proper onboarding:");
      console.log("   1. Go to Option 23: INVESTOR ONBOARDING SYSTEM");
      console.log("   2. Create normal users (Sub-option 1)");
      console.log("   3. Request investor status (Sub-option 2)");
      console.log("   4. Complete the onboarding workflow");
      console.log("");
      console.log("✅ This ensures:");
      console.log("   - KYC/AML verification");
      console.log("   - Multi-signature wallets");
      console.log("   - Token locking requirements");
      console.log("   - Bank approval workflow");
      console.log("   - Complete compliance");
      return;
    }

    console.log("\n📋 INVESTORS FROM ONBOARDING SYSTEM:");
    console.log("=".repeat(50));

    // Get digital token contract to fetch real balances
    const digitalToken =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");

    let index = 1;
    const investorArray = Array.from(mod.state.investors.values());

    for (const investor of investorArray) {
      console.log(`\n${index}. ${investor.name}`);
      console.log(`   🆔 Address: ${investor.address}`);
      console.log(`   📋 Current Type: ${investor.type}`);

      // Check KYC/AML status
      const kycStatus = investor.kycStatus || "NOT_ISSUED";
      const amlStatus = investor.amlStatus || "NOT_ISSUED";
      console.log(
        `   🎯 KYC Status: ${kycStatus} ${kycStatus === "ISSUED" ? "✅" : "❌"}`,
      );
      console.log(
        `   🔍 AML Status: ${amlStatus} ${amlStatus === "ISSUED" ? "✅" : "❌"}`,
      );

      // Get real on-chain balance
      let balance = 0;
      if (digitalToken) {
        try {
          const onchainBalance = await digitalToken.balanceOf(investor.address);
          balance = parseFloat(ethers.formatEther(onchainBalance));
        } catch (error) {
          balance = investor.tokenBalance || 0;
        }
      } else {
        balance = investor.tokenBalance || 0;
      }
      console.log(`   💰 Token Balance: ${balance.toLocaleString()} VSC`);

      if (investor.multiSigWallet) {
        console.log(
          `   🔐 Multi-Sig Wallet: ${investor.multiSigWallet.address}`,
        );
        console.log(
          `   💰 Locked Tokens: ${investor.multiSigWallet.tokensLocked} VSC`,
        );
      }
      index++;
    }

    const choice = await mod.promptUser(
      "\nSelect investor number (or 0 to cancel): ",
    );
    const investorIndex = parseInt(choice) - 1;

    if (investorIndex < 0 || investorIndex >= investorArray.length) {
      console.log("❌ Invalid selection");
      return;
    }

    const selectedInvestor = investorArray[investorIndex];

    console.log("\n📊 SELECT INVESTOR TYPE:");
    console.log("0. 👤 Normal Investor");
    console.log("1. 🛒 Retail Investor");
    console.log("2. 💼 Accredited Investor");
    console.log("3. 🏛️ Institutional Investor");

    const typeChoice = await mod.promptUser("\nSelect type (0-3): ");
    const newType = parseInt(typeChoice);

    if (newType < 0 || newType > 3) {
      console.log("❌ Invalid type selection");
      return;
    }

    console.log(
      `\n🔄 Assigning ${selectedInvestor.name} to type ${newType}...`,
    );
    const tx = await investorTypeRegistry.assignInvestorType(
      selectedInvestor.address,
      newType,
    );
    await tx.wait();

    // Update investor record
    selectedInvestor.type = ["Normal", "Retail", "Accredited", "Institutional"][
      newType
    ];

    displaySuccess("INVESTOR TYPE ASSIGNED!");
    console.log(`   👤 Investor: ${selectedInvestor.name}`);
    console.log(`   📋 New Type: ${selectedInvestor.type}`);
    console.log(`   🔗 Transaction: ${tx.hash}`);
  } catch (error) {
    displayError(`Failed to assign investor type: ${error.message}`);
  }
}

module.exports = {
  deployInvestorTypeSystem,
  showInvestorTypeConfigurations,
  assignInvestorTypes,
};
