/**
 * @fileoverview Investor type options 54 to 56: type changes, transfer and holding limits
 * @module InvestorTypeLimitsFlow
 * @description Upgrades and downgrades types and tests the transfer and holding caps.
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

/** Option 54: Upgrade/Downgrade Investor Types */
async function upgradeDowngradeInvestorTypes(mod) {
  displaySection("UPGRADE/DOWNGRADE INVESTOR TYPES", "⬆️");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    if (!mod.state.investors || mod.state.investors.size === 0) {
      console.log("\n❌ NO INVESTORS FOUND!");
      console.log("💡 Create investors first using Option 23");
      return;
    }

    console.log("\n📋 CURRENT INVESTOR TYPES:");
    console.log("=".repeat(50));

    let index = 1;
    const investorArray = Array.from(mod.state.investors.values());

    for (const investor of investorArray) {
      const currentTypeBigInt = await investorTypeRegistry.getInvestorType(
        investor.address,
      );
      const currentType = Number(currentTypeBigInt); // Convert BigInt to Number
      const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];
      console.log(
        `${index}. ${investor.name} - Current: ${typeNames[currentType]}`,
      );
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
    const currentTypeBigInt = await investorTypeRegistry.getInvestorType(
      selectedInvestor.address,
    );
    const currentType = Number(currentTypeBigInt); // Convert BigInt to Number

    console.log("\n📊 UPGRADE/DOWNGRADE OPTIONS:");
    console.log("1. ⬆️ Upgrade (increase privileges)");
    console.log("2. ⬇️ Downgrade (decrease privileges)");

    const actionChoice = await mod.promptUser("\nSelect action (1-2): ");
    let newType;

    if (actionChoice === "1") {
      // Upgrade
      newType = Math.min(currentType + 1, 3);
      if (newType === currentType) {
        console.log("❌ Already at maximum type (Institutional)");
        return;
      }
    } else if (actionChoice === "2") {
      // Downgrade
      newType = Math.max(currentType - 1, 0);
      if (newType === currentType) {
        console.log("❌ Already at minimum type (Normal)");
        return;
      }
    } else {
      console.log("❌ Invalid action");
      return;
    }

    const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];
    console.log(
      `\n🔄 Changing ${selectedInvestor.name} from ${typeNames[currentType]} to ${typeNames[newType]}...`,
    );

    const tx = await investorTypeRegistry.assignInvestorType(
      selectedInvestor.address,
      newType,
    );
    await tx.wait();

    selectedInvestor.type = typeNames[newType];

    displaySuccess("INVESTOR TYPE UPDATED!");
    console.log(`   👤 Investor: ${selectedInvestor.name}`);
    console.log(`   📋 Old Type: ${typeNames[currentType]}`);
    console.log(`   📋 New Type: ${typeNames[newType]}`);
    console.log(`   🔗 Transaction: ${tx.hash}`);
  } catch (error) {
    displayError(`Failed to upgrade/downgrade investor type: ${error.message}`);
  }
}

/** Option 55: Test Transfer Limits by Type */
async function testTransferLimits(mod) {
  displaySection("TEST TRANSFER LIMITS BY TYPE", "💰");
  console.log(
    "\n💡 This option uses investors from the INVESTOR ONBOARDING SYSTEM (Option 23)",
  );
  console.log(
    "💡 All investors have proper KYC/AML, multi-sig wallets, and token locking.",
  );
  console.log("");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  const digitalToken =
    mod.state.getContract("token") || mod.state.getContract("digitalToken");

  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  if (!digitalToken) {
    displayError(
      "Digital token not deployed. Please deploy ERC-3643 system first (option 21).",
    );
    return;
  }

  try {
    // Check if we have investors from the onboarding system
    if (!mod.state.investors || mod.state.investors.size === 0) {
      console.log("\n❌ NO INVESTORS FOUND!");
      console.log("");
      console.log("💡 To create investors for transfer testing:");
      console.log("   1. Go to Option 23: INVESTOR ONBOARDING SYSTEM");
      console.log("   2. Create at least 2 normal users (Sub-option 1)");
      console.log("   3. Request investor status for each (Sub-option 2)");
      console.log("   4. Complete the onboarding workflow");
      console.log("");
      console.log("💡 You need at least 2 investors to test transfers!");
      return;
    }

    const investorArray = Array.from(mod.state.investors.values());

    if (investorArray.length < 2) {
      console.log("\n⚠️  INSUFFICIENT INVESTORS!");
      console.log(`   Current: ${investorArray.length} investor(s)`);
      console.log(`   Required: At least 2 investors`);
      console.log("");
      console.log(
        "💡 Create more investors using Option 23 (INVESTOR ONBOARDING SYSTEM)",
      );
      return;
    }

    console.log("\n📋 AVAILABLE INVESTORS:");
    console.log("=".repeat(50));

    let index = 1;
    for (const investor of investorArray) {
      console.log(`\n${index}. ${investor.name}`);
      console.log(`   🆔 Address: ${investor.address.substring(0, 10)}...`);
      console.log(`   📋 Type: ${investor.type}`);

      // Get real on-chain balance
      let balance = 0;
      try {
        const onchainBalance = await digitalToken.balanceOf(investor.address);
        balance = parseFloat(ethers.formatEther(onchainBalance));
      } catch (error) {
        balance = investor.tokenBalance || 0;
      }
      console.log(`   💳 Balance: ${balance.toLocaleString()} VSC`);

      // Get transfer limit for this investor type
      const typeMap = {
        NORMAL: 0,
        RETAIL: 1,
        ACCREDITED: 2,
        INSTITUTIONAL: 3,
      };
      const typeIndex = typeMap[investor.type] || 0;
      const config =
        await investorTypeRegistry.getInvestorTypeConfig(typeIndex);
      console.log(
        `   📊 Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`,
      );

      index++;
    }

    console.log("\n" + "=".repeat(50));

    // Select sender
    const senderChoice = await mod.promptUser(
      `\nSelect SENDER (1-${investorArray.length}): `,
    );
    const senderIndex = parseInt(senderChoice) - 1;
    const sender = investorArray[senderIndex];

    if (!sender) {
      console.log("❌ Invalid sender selection");
      return;
    }

    // Select recipient
    console.log(`\n📋 SELECT RECIPIENT (cannot be ${sender.name}):`);
    const recipients = investorArray.filter((inv, idx) => idx !== senderIndex);

    for (let idx = 0; idx < recipients.length; idx++) {
      const inv = recipients[idx];
      // Get real on-chain balance
      let balance = 0;
      try {
        const onchainBalance = await digitalToken.balanceOf(inv.address);
        balance = parseFloat(ethers.formatEther(onchainBalance));
      } catch (error) {
        balance = inv.tokenBalance || 0;
      }
      console.log(
        `${idx + 1}. ${inv.name} (${inv.type}) - Balance: ${balance.toLocaleString()} VSC`,
      );
    }

    const recipientChoice = await mod.promptUser(
      `\nSelect RECIPIENT (1-${recipients.length}): `,
    );
    const recipient = recipients[parseInt(recipientChoice) - 1];

    if (!recipient) {
      console.log("❌ Invalid recipient selection");
      return;
    }

    console.log("\n💸 TRANSFER SETUP:");
    console.log("=".repeat(50));

    // Get sender's real balance
    let senderBalance = 0;
    try {
      const onchainBalance = await digitalToken.balanceOf(sender.address);
      senderBalance = parseFloat(ethers.formatEther(onchainBalance));
    } catch (error) {
      senderBalance = sender.tokenBalance || 0;
    }

    console.log(`📤 From: ${sender.name} (${sender.type})`);
    console.log(`   Address: ${sender.address}`);
    console.log(`   Balance: ${senderBalance.toLocaleString()} VSC`);
    console.log("");

    // Get recipient's real balance
    let recipientBalance = 0;
    try {
      const onchainBalance = await digitalToken.balanceOf(recipient.address);
      recipientBalance = parseFloat(ethers.formatEther(onchainBalance));
    } catch (error) {
      recipientBalance = recipient.tokenBalance || 0;
    }

    console.log(`📥 To: ${recipient.name} (${recipient.type})`);
    console.log(`   Address: ${recipient.address}`);
    console.log(`   Balance: ${recipientBalance.toLocaleString()} VSC`);
    console.log("");

    // Get sender's transfer limit
    const typeMap = { NORMAL: 0, RETAIL: 1, ACCREDITED: 2, INSTITUTIONAL: 3 };
    const senderTypeIndex = typeMap[sender.type] || 0;
    const senderConfig =
      await investorTypeRegistry.getInvestorTypeConfig(senderTypeIndex);
    const maxTransfer = senderConfig.maxTransferAmount;

    console.log(
      `📊 ${sender.name}'s Max Transfer: ${ethers.formatEther(maxTransfer)} VSC`,
    );
    console.log("");

    const amount = await mod.promptUser("Enter transfer amount (in VSC): ");
    const transferAmount = ethers.parseEther(amount);

    console.log("\n🔍 VALIDATING TRANSFER...");

    // Check if amount exceeds limit
    if (transferAmount > maxTransfer) {
      console.log(`❌ TRANSFER BLOCKED!`);
      console.log(`   Amount: ${amount} VSC`);
      console.log(`   Limit: ${ethers.formatEther(maxTransfer)} VSC`);
      console.log(`   Reason: Exceeds ${sender.type} investor transfer limit`);
      return;
    }

    console.log(`✅ Transfer amount within limit`);
    console.log(`   Amount: ${amount} VSC`);
    console.log(`   Limit: ${ethers.formatEther(maxTransfer)} VSC`);

    displaySuccess("TRANSFER LIMIT TEST COMPLETE!");
    console.log("   💡 Transfer would be allowed (within limits)");
    console.log("   💡 Use Option 26 to execute actual transfers");
  } catch (error) {
    displayError(`Transfer limits testing failed: ${error.message}`);
  }
}

/** Option 56: Test Holding Limits by Type */
async function testHoldingLimits(mod) {
  displaySection("TEST HOLDING LIMITS BY TYPE", "🏦");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    console.log("\n🧪 TESTING HOLDING LIMITS FOR EACH INVESTOR TYPE");

    const testUsers = mod.state.signers.slice(0, 4);
    const investorTypes = [0, 1, 2, 3];
    const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];

    console.log("\n📊 HOLDING LIMIT TESTS:");

    for (let i = 0; i < testUsers.length; i++) {
      const config = await investorTypeRegistry.getInvestorTypeConfig(
        investorTypes[i],
      );
      const maxHolding = config.maxHoldingAmount; // Already BigInt, keep as-is for ethers operations
      const testAmount = maxHolding + ethers.parseEther("10000"); // BigInt + BigInt = OK

      console.log(`\n${typeNames[i]} Investor (${testUsers[i].address}):`);
      console.log(
        `   📊 Max Holding Limit: ${ethers.formatEther(maxHolding)} VSC`,
      );

      // Test within limit (BigInt - BigInt = OK)
      const withinLimit = await investorTypeRegistry.canHoldAmount(
        testUsers[i].address,
        maxHolding - ethers.parseEther("5000"),
      );
      console.log(
        `   ✅ Holding within limit: ${withinLimit ? "ALLOWED" : "BLOCKED"}`,
      );

      // Test over limit
      const overLimit = await investorTypeRegistry.canHoldAmount(
        testUsers[i].address,
        testAmount,
      );
      console.log(
        `   ❌ Holding over limit: ${overLimit ? "ALLOWED" : "BLOCKED"}`,
      );
    }

    displaySuccess("HOLDING LIMITS TESTING COMPLETE");
  } catch (error) {
    displayError(`Holding limits testing failed: ${error.message}`);
  }
}

module.exports = {
  upgradeDowngradeInvestorTypes,
  testTransferLimits,
  testHoldingLimits,
};
