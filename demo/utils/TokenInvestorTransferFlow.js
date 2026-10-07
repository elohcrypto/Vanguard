/**
 * @fileoverview Token option 26: investor-to-investor transfers
 * @module TokenInvestorTransferFlow
 * @description The normal, excess and blocked investor-to-investor scenarios.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { whitelistHints } = require("./WhitelistLiveFlow");
const { waitOutCooldown } = require("./InvestorTypeRules");
const { ethers } = require("hardhat");

/** Option 26: Investor-to-Investor Transfer */
async function investorToInvestorTransfer(mod) {
  console.log("\n💸 INVESTOR-TO-INVESTOR TRANSFER (MAX 8,000)");
  console.log("=".repeat(50));

  if (mod.state.investors.size === 0) {
    console.log(
      "❌ No investors created yet. Create investors first (option 23)",
    );
    return;
  }

  // Show available investors with their compliance status and balances
  console.log("\n👥 AVAILABLE INVESTORS:");
  const investorArray = Array.from(mod.state.investors.values());
  let compliantInvestors = [];

  investorArray.forEach((investor, index) => {
    const complianceIcon = investor.tokenEligible ? "✅" : "❌";
    const balanceInfo =
      investor.tokenBalance > 0
        ? `(${investor.tokenBalance.toLocaleString()} VSC)`
        : "(0 VSC)";
    console.log(
      `   ${index}: ${investor.name} ${complianceIcon} ${balanceInfo}`,
    );

    if (investor.tokenEligible) {
      compliantInvestors.push({ ...investor, index });
    }
  });

  if (compliantInvestors.length < 2) {
    console.log("\n❌ Need at least 2 compliant investors for transfers");
    console.log(
      "💡 Create more compliant investors or use Token Issuer distribution (option 25)",
    );
    return;
  }

  console.log("\n🔄 TRANSFER SCENARIOS:");
  console.log("1. Normal Transfer (Within 8,000 limit)");
  console.log("2. Attempt Excess Transfer (>8,000 limit)");
  console.log("3. Transfer to Non-Compliant (Blocked)");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select transfer scenario (0-3): ");

  try {
    switch (choice) {
      case "1":
        await mod.executeNormalTransfer(compliantInvestors);
        break;
      case "2":
        await mod.executeExcessTransfer(compliantInvestors);
        break;
      case "3":
        await mod.executeBlockedTransfer(investorArray);
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Transfer failed:", error.message);
  }
}

/**
 * Execute normal transfer (within 8,000 limit)
 * @private
 */
async function executeNormalTransfer(mod, compliantInvestors) {
  console.log("\n✅ NORMAL TRANSFER (WITHIN 8,000 LIMIT) - ON-CHAIN");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  if (compliantInvestors.length < 2) {
    console.log("❌ Need at least 2 compliant investors");
    return;
  }

  // Show investors and let user select
  console.log("\n👥 SELECT SENDER:");
  compliantInvestors.forEach((investor, index) => {
    console.log(`   ${index}: ${investor.name} - ${investor.address}`);
  });

  const senderIndex = await mod.promptUser(
    `Select sender (0-${compliantInvestors.length - 1}): `,
  );
  const sender = compliantInvestors[parseInt(senderIndex)];

  if (!sender) {
    console.log("❌ Invalid sender selection");
    return;
  }

  // Show recipients (exclude sender by address)
  const recipients = compliantInvestors.filter(
    (inv) => inv.address !== sender.address,
  );

  if (recipients.length === 0) {
    console.log("❌ No other investors available for transfer");
    console.log("💡 Create more investors first (option 23)");
    return;
  }

  console.log("\n👥 SELECT RECIPIENT:");
  recipients.forEach((investor, index) => {
    console.log(`   ${index}: ${investor.name} - ${investor.address}`);
  });

  const recipientIndex = await mod.promptUser(
    `Select recipient (0-${recipients.length - 1}): `,
  );
  const recipient = recipients[parseInt(recipientIndex)];

  if (!recipient) {
    console.log("❌ Invalid recipient selection");
    return;
  }

  const amount = await mod.promptUser(
    "Enter amount to transfer (max 8000 VSC): ",
  );
  const amountWei = ethers.parseEther(amount);
  const maxTransfer = ethers.parseEther("8000");

  if (amountWei > maxTransfer) {
    console.log("❌ Amount exceeds 8,000 VSC limit!");
    return;
  }

  try {
    let totalGasUsed = 0n;

    console.log("\n🔗 EXECUTING TRANSFER ON-CHAIN...");
    console.log(`📤 From: ${sender.name} (${sender.address})`);
    console.log(`📥 To: ${recipient.name} (${recipient.address})`);
    console.log(`💰 Amount: ${amount} VSC`);

    // Step 1: Verify sender compliance on-chain
    console.log("\n📝 Step 1: Verifying sender compliance on blockchain...");
    const identityRegistry = mod.state.getContract("identityRegistry");
    const senderVerified = await identityRegistry.isVerified(sender.address);
    console.log(
      `   ${senderVerified ? "✅" : "❌"} Sender Verified: ${senderVerified}`,
    );

    // Step 2: Verify recipient compliance on-chain
    console.log("\n📝 Step 2: Verifying recipient compliance on blockchain...");
    const recipientVerified = await identityRegistry.isVerified(
      recipient.address,
    );
    console.log(
      `   ${recipientVerified ? "✅" : "❌"} Recipient Verified: ${recipientVerified}`,
    );

    if (!senderVerified || !recipientVerified) {
      console.log("❌ Transfer blocked: Compliance check failed!");
      return;
    }

    // Step 3: Check sender balance on-chain
    console.log("\n📝 Step 3: Checking sender balance on blockchain...");
    const senderBalanceBefore = await digitalToken.balanceOf(sender.address);
    console.log(
      `   💰 Sender Balance: ${ethers.formatEther(senderBalanceBefore)} VSC`,
    );

    if (senderBalanceBefore < amountWei) {
      console.log("❌ Insufficient balance!");
      return;
    }

    // Continue in next method due to 150-line limit...
    await mod.completeNormalTransfer(
      sender,
      recipient,
      amount,
      amountWei,
      senderBalanceBefore,
      digitalToken,
      totalGasUsed,
    );
  } catch (error) {
    console.error("❌ Transfer failed:", error.message);
    if (error.message.includes("ERC20: transfer amount exceeds balance")) {
      console.error("💡 Sender has insufficient balance");
    } else if (error.message.includes("compliance")) {
      console.error("💡 Compliance check failed");
    }
    // Task 3.6: name a party VSC's allow list refuses (option 42 -> 1).
    const parties = [sender?.address, recipient?.address];
    const hints = await whitelistHints(mod.state, parties).catch(() => []);
    for (const h of hints) {
      console.error(`💡 ${h}`);
    }
  }
}

/**
 * Complete normal transfer (part 2)
 * @private
 */
async function completeNormalTransfer(
  mod,
  sender,
  recipient,
  amount,
  amountWei,
  senderBalanceBefore,
  digitalToken,
  totalGasUsed,
) {
  // Step 4: Check recipient balance before transfer
  console.log("\n📝 Step 4: Checking recipient balance on blockchain...");
  const recipientBalanceBefore = await digitalToken.balanceOf(
    recipient.address,
  );
  console.log(
    `   💰 Recipient Balance: ${ethers.formatEther(recipientBalanceBefore)} VSC`,
  );

  // Task 4.10: the sender may be inside its type's cooldown (e.g. it just
  // locked or received); wait it out on a dev node, else say until when.
  if (!(await waitOutCooldown(mod.state, sender.signer))) return;

  // Step 5: Execute transfer on-chain
  console.log("\n📝 Step 5: Executing transfer on blockchain...");
  const tx = await digitalToken
    .connect(sender.signer)
    .transfer(recipient.address, amountWei);
  const receipt = await tx.wait();
  totalGasUsed += receipt.gasUsed;

  console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
  console.log(`   🧱 Block Number: ${receipt.blockNumber}`);
  console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

  // Step 6: Verify balances after transfer
  console.log(
    "\n📝 Step 6: Verifying balances after transfer on blockchain...",
  );
  const senderBalanceAfter = await digitalToken.balanceOf(sender.address);
  const recipientBalanceAfter = await digitalToken.balanceOf(recipient.address);

  console.log(
    `   📤 Sender New Balance: ${ethers.formatEther(senderBalanceAfter)} VSC`,
  );
  console.log(
    `   📥 Recipient New Balance: ${ethers.formatEther(recipientBalanceAfter)} VSC`,
  );
  console.log(
    `   📊 Amount Transferred: ${ethers.formatEther(senderBalanceBefore - senderBalanceAfter)} VSC`,
  );

  // Record transaction
  mod.state.transferHistory.push({
    type: "TRANSFER",
    from: sender.name,
    fromAddress: sender.address,
    to: recipient.name,
    toAddress: recipient.address,
    amount: amount,
    timestamp: new Date().toISOString(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: "SUCCESS",
  });

  console.log("\n🎉 TRANSFER COMPLETED ON-CHAIN SUCCESSFULLY!");
  console.log("=".repeat(60));
  console.log(`📤 From: ${sender.name}`);
  console.log(`📥 To: ${recipient.name}`);
  console.log(`💰 Amount: ${amount} VSC`);
  console.log(`🔗 Transaction: ${receipt.hash}`);
  console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

  console.log("\n💡 Transfer Details:");
  console.log(`   • ✅ Both parties verified on-chain`);
  console.log(`   • ✅ Within 8,000 VSC limit`);
  console.log(`   • ✅ Balances updated on blockchain`);
}

/**
 * Execute excess transfer (>8,000 limit)
 * @private
 */
async function executeExcessTransfer(mod, compliantInvestors) {
  console.log("\n🚫 EXCESS TRANSFER ATTEMPT (>8,000 LIMIT)");
  console.log("-".repeat(40));

  const sender = compliantInvestors[0];
  const recipient = compliantInvestors.find(
    (inv) => inv.address !== sender.address,
  );

  if (!recipient) {
    console.log("❌ Need at least 2 investors for this demo");
    return;
  }

  const amount = 10000; // Exceeds 8,000 limit

  console.log(`\n🔍 COMPLIANCE CHECK:`);
  console.log(
    `   Sender: ${sender.name} - KYC: ${sender.kycStatus} ✅ AML: ${sender.amlStatus} ✅`,
  );
  console.log(
    `   Recipient: ${recipient.name} - KYC: ${recipient.kycStatus} ✅ AML: ${recipient.amlStatus} ✅`,
  );
  console.log(
    `   Amount: ${amount.toLocaleString()} VSC (EXCEEDS 8,000 limit ❌)`,
  );

  console.log(`\n💸 Attempting transfer...`);
  console.log(`⏳ Validating compliance...`);
  console.log(`⏳ Checking transfer limits...`);
  console.log(`⛔ TRANSFER BLOCKED! (expected)`);
  console.log(`🚫 Reason: Amount exceeds daily limit of 8,000 VSC`);

  // Record blocked transaction
  mod.state.transferHistory.push({
    type: "INVESTOR_TRANSFER",
    from: sender.name,
    to: recipient.name,
    amount: amount,
    timestamp: new Date().toISOString(),
    status: "BLOCKED",
    reason: "Exceeds 8,000 VSC transfer limit",
  });

  console.log("\n⛔ TRANSFER BLOCKED BY StableCoin LIMITS! (expected)");
  console.log("💡 Maximum transfer amount is 8,000 VSC per transaction");
}

/**
 * Execute blocked transfer (to non-compliant)
 * @private
 */
async function executeBlockedTransfer(mod, allInvestors) {
  console.log("\n🚫 TRANSFER TO NON-COMPLIANT (BLOCKED)");
  console.log("-".repeat(40));

  const compliantInvestors = allInvestors.filter((inv) => inv.tokenEligible);
  const nonCompliantInvestors = allInvestors.filter(
    (inv) => !inv.tokenEligible,
  );

  if (compliantInvestors.length === 0 || nonCompliantInvestors.length === 0) {
    console.log(
      "ℹ️  Need both compliant and non-compliant investors for this demo",
    );
    return;
  }

  const sender = compliantInvestors[0];
  const recipient = nonCompliantInvestors[0];
  const amount = 3000;

  console.log(`\n🔍 COMPLIANCE CHECK:`);
  console.log(
    `   Sender: ${sender.name} - KYC: ${sender.kycStatus} ✅ AML: ${sender.amlStatus} ✅`,
  );
  console.log(
    `   Recipient: ${recipient.name} - KYC: ${recipient.kycStatus} ❌ AML: ${recipient.amlStatus} ❌`,
  );
  console.log(
    `   Amount: ${amount.toLocaleString()} VSC (Within 8,000 limit ✅)`,
  );

  console.log(`\n💸 Attempting transfer...`);
  console.log(`⏳ Validating compliance...`);
  console.log(`⛔ TRANSFER BLOCKED! (expected)`);
  console.log(`🚫 Reason: Recipient is not KYC/AML compliant`);

  // Record blocked transaction
  mod.state.transferHistory.push({
    type: "INVESTOR_TRANSFER",
    from: sender.name,
    to: recipient.name,
    amount: amount,
    timestamp: new Date().toISOString(),
    status: "BLOCKED",
    reason: "Recipient not KYC/AML compliant",
  });

  console.log("\n⛔ TRANSFER BLOCKED BY COMPLIANCE! (expected)");
  console.log(
    "💡 Only KYC/AML approved investors can receive Vanguard StableCoin",
  );
}

module.exports = {
  investorToInvestorTransfer,
  executeNormalTransfer,
  completeNormalTransfer,
  executeExcessTransfer,
  executeBlockedTransfer,
};
