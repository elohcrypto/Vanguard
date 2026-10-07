/**
 * @fileoverview Token option 28: restricted transfer scenarios
 * @module TokenRestrictionFlow
 * @description The amount-limit and non-compliant-recipient scenarios.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");

/** Option 28: transfer restriction scenarios on VSC (sub-menu 1-3) */
async function restrictedTransferScenarios(mod) {
  console.log("\n🚫 DEMONSTRATE TRANSFER RESTRICTIONS");
  console.log("=".repeat(50));

  console.log("\n🎭 RESTRICTION SCENARIOS:");
  console.log("1. 💰 Amount Exceeds Limit (>8,000 VSC)");
  console.log("2. ❌ Non-Compliant Recipient");
  console.log("3. 📜 View Transfer History");
  console.log("0. Back");

  const choice = await mod.promptUser("Select scenario (0-3): ");

  try {
    switch (choice) {
      case "1":
        await mod.demonstrateAmountLimit();
        break;
      case "2":
        await mod.demonstrateNonCompliantRecipient();
        break;
      case "3":
        await mod.viewTransferHistory();
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Demonstration failed:", error.message);
  }
}

/**
 * Demonstrate amount limit restriction
 * @private
 */
async function demonstrateAmountLimit(mod) {
  console.log("\n💰 AMOUNT LIMIT RESTRICTION DEMO");
  console.log("=".repeat(40));
  console.log("⚠️  This demonstrates on-chain transfer amount limits");
  console.log("");

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  // Get investors with balance - check on-chain
  const allInvestors = Array.from(mod.state.investors.values()).filter(
    (inv) => inv.tokenEligible,
  );
  const investorsWithBalance = [];

  for (const inv of allInvestors) {
    try {
      const balance = await digitalToken.balanceOf(inv.address);
      const balanceVSC = parseFloat(ethers.formatEther(balance));
      if (balanceVSC >= 10000) {
        inv.actualBalance = balanceVSC;
        investorsWithBalance.push(inv);
      }
    } catch (error) {
      // Skip this investor
    }
  }

  if (investorsWithBalance.length === 0) {
    console.log("❌ No investors have sufficient balance (need ≥10,000 VSC)");
    console.log("💡 Use Option 25 to mint and distribute tokens first");
    return;
  }

  const sender = investorsWithBalance[0];
  const recipients = Array.from(mod.state.investors.values()).filter(
    (inv) => inv.tokenEligible && inv.address !== sender.address,
  );

  if (recipients.length === 0) {
    console.log("❌ Need at least 2 investors for this demo");
    return;
  }

  const recipient = recipients[0];
  const excessAmount = "10000"; // Exceeds 8,000 limit

  console.log(
    `📤 Sender: ${sender.name} (${sender.address.substring(0, 10)}...)`,
  );
  console.log(`   💰 Balance: ${sender.actualBalance.toLocaleString()} VSC`);
  console.log(
    `📥 Recipient: ${recipient.name} (${recipient.address.substring(0, 10)}...)`,
  );
  console.log(`💰 Attempting: ${excessAmount} VSC`);
  console.log(`🚫 Limit: 8,000 VSC`);
  console.log("");

  try {
    // Step 1: Check if transfer is allowed on-chain
    console.log("📝 Step 1: Checking transfer limits on blockchain...");
    const amountWei = ethers.parseEther(excessAmount);
    const canTransfer = await digitalToken.canTransfer(
      sender.address,
      recipient.address,
      amountWei,
    );

    console.log(`   ${canTransfer ? "✅" : "❌"} Can Transfer: ${canTransfer}`);

    if (!canTransfer) {
      console.log("");
      console.log("⚠️  TRANSFER BLOCKED BY ON-CHAIN COMPLIANCE!");
      console.log(`   Requested: ${excessAmount} VSC`);
      console.log(`   Maximum: 8,000 VSC`);
      console.log(`   Reason: Amount exceeds compliance limit`);
      console.log("");
      console.log("💡 Solution: Split into multiple transfers ≤8,000 VSC");
      console.log("💡 Example: Transfer 8,000 VSC, then 2,000 VSC separately");
      console.log("");
      console.log("✅ ERC-3643 compliance enforced on-chain!");
    } else {
      console.log(
        "⚠️  Warning: Transfer would be allowed (limit may have changed)",
      );
    }
  } catch (error) {
    console.log("");
    console.log("❌ TRANSFER BLOCKED BY SMART CONTRACT!");
    console.log(`   Error: ${error.message}`);
    console.log("");
    console.log("✅ ERC-3643 compliance enforced on-chain!");
  }
}

/**
 * Demonstrate non-compliant recipient restriction
 * @private
 */
async function demonstrateNonCompliantRecipient(mod) {
  console.log("\n🚫 NON-COMPLIANT RECIPIENT DEMO");
  console.log("=".repeat(40));
  console.log("⚠️  This demonstrates on-chain compliance verification");
  console.log("");

  const digitalToken = mod.state.getContract("digitalToken");
  const identityRegistry = mod.state.getContract("identityRegistry");

  if (!digitalToken || !identityRegistry) {
    console.log("❌ Contracts not deployed. Deploy them first (option 21)");
    return;
  }

  const compliantInvestors = Array.from(mod.state.investors.values()).filter(
    (inv) => inv.tokenEligible,
  );
  const nonCompliantInvestors = Array.from(mod.state.investors.values()).filter(
    (inv) => !inv.tokenEligible,
  );

  if (compliantInvestors.length === 0) {
    console.log("❌ Need at least 1 compliant investor");
    console.log("💡 Create compliant investors first (Option 23)");
    return;
  }

  if (nonCompliantInvestors.length === 0) {
    console.log("ℹ️  No non-compliant investors available for this demo");
    console.log("💡 This demo requires a non-compliant investor");
    console.log(
      "💡 In production, non-compliant users are blocked automatically",
    );
    return;
  }

  const sender = compliantInvestors[0];
  const recipient = nonCompliantInvestors[0];
  const amount = "1000";

  console.log(
    `📤 Sender: ${sender.name} (${sender.address.substring(0, 10)}...)`,
  );
  console.log(`   ✅ KYC: ${sender.kycStatus}`);
  console.log(`   ✅ AML: ${sender.amlStatus}`);

  console.log(
    `\n📥 Recipient: ${recipient.name} (${recipient.address.substring(0, 10)}...)`,
  );
  console.log(`   ❌ KYC: ${recipient.kycStatus}`);
  console.log(`   ❌ AML: ${recipient.amlStatus}`);
  console.log(`💰 Attempting: ${amount} VSC`);
  console.log("");

  try {
    // Step 1: Verify sender on-chain
    console.log("📝 Step 1: Verifying sender compliance on blockchain...");
    const senderVerified = await identityRegistry.isVerified(sender.address);
    console.log(
      `   ${senderVerified ? "✅" : "❌"} Sender Verified: ${senderVerified}`,
    );

    // Step 2: Verify recipient on-chain
    console.log("\n📝 Step 2: Verifying recipient compliance on blockchain...");
    const recipientVerified = await identityRegistry.isVerified(
      recipient.address,
    );
    console.log(
      `   ${recipientVerified ? "✅" : "❌"} Recipient Verified: ${recipientVerified}`,
    );

    if (!recipientVerified) {
      console.log("");
      console.log("⚠️  TRANSFER BLOCKED BY ON-CHAIN COMPLIANCE!");
      console.log(`   Issue: Recipient not verified in IdentityRegistry`);
      console.log(`   Reason: Missing or invalid KYC/AML claims`);
      console.log("");
      console.log("💡 Solution: Recipient must complete KYC/AML verification");
      console.log(
        "💡 ERC-3643 compliance enforced on-chain by IdentityRegistry",
      );
      console.log("");
      console.log("✅ Blockchain prevented non-compliant transfer!");
    } else {
      console.log("⚠️  Warning: Recipient is verified (may have been updated)");
    }
  } catch (error) {
    console.log("");
    console.log("❌ TRANSFER BLOCKED BY SMART CONTRACT!");
    console.log(`   Error: ${error.message}`);
    console.log("");
    console.log("✅ ERC-3643 compliance enforced on-chain!");
  }
}

module.exports = {
  restrictedTransferScenarios,
  demonstrateAmountLimit,
  demonstrateNonCompliantRecipient,
};
