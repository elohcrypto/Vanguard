/**
 * @fileoverview Token options 27.5 and 28 -> 3: user-to-user transfer, history
 * @module TokenPeerTransferFlow
 * @description A transfer between two compliant users, and the transfer history.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const { waitOutCooldown } = require("./InvestorTypeRules");

/** Option 27.5: User-to-User Transfer */
async function userToUserTransfer(mod) {
  console.log("\n👥 USER-TO-USER TRANSFER - ON-CHAIN");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  // Merge normal users from both Option 23 (investors with type NORMAL/NORMAL_USER) and Option 24 (normalUsers)
  const normalUsersFromInvestors = mod.state.investors
    ? Array.from(mod.state.investors.values()).filter(
        (u) => u.type === "NORMAL" || u.type === "NORMAL_USER",
      )
    : [];
  const normalUsersFromOption24 = mod.state.normalUsers
    ? Array.from(mod.state.normalUsers.values())
    : [];

  const allNormalUsers = [
    ...normalUsersFromInvestors,
    ...normalUsersFromOption24,
  ];

  if (allNormalUsers.length < 2) {
    console.log(
      "❌ Need at least 2 users. Create more users (option 23 → 1 or option 24)",
    );
    return;
  }

  // Get compliant users with addresses
  const compliantUsers = allNormalUsers.filter(
    (user) => user.tokenEligible && user.address,
  );

  if (compliantUsers.length < 2) {
    console.log("❌ Need at least 2 compliant users with addresses");
    console.log(
      "💡 Create compliant users first (option 23 → 1 or option 24 → 1)",
    );
    console.log(
      `   Currently: ${normalUsersFromInvestors.length} from Option 23, ${normalUsersFromOption24.length} from Option 24`,
    );
    console.log(`   Compliant: ${compliantUsers.length} users`);
    return;
  }

  console.log("\n👥 AVAILABLE USERS:");
  compliantUsers.forEach((user, index) => {
    console.log(`   ${index}: ${user.name} - ${user.address}`);
  });

  const senderIndex = await mod.promptUser(
    `\nSelect sender (0-${compliantUsers.length - 1}): `,
  );
  const recipientIndex = await mod.promptUser(
    `Select recipient (0-${compliantUsers.length - 1}): `,
  );

  const sender = compliantUsers[parseInt(senderIndex)];
  const recipient = compliantUsers[parseInt(recipientIndex)];

  if (!sender || !recipient) {
    console.log("❌ Invalid selection");
    return;
  }

  if (sender.address === recipient.address) {
    console.log("❌ Cannot transfer to the same user");
    return;
  }

  const amount = await mod.promptUser("Enter amount to transfer (VSC): ");
  const amountWei = ethers.parseEther(amount);

  try {
    let totalGasUsed = 0n;

    console.log("\n🔗 EXECUTING USER-TO-USER TRANSFER ON-CHAIN...");
    console.log(`👤 From: ${sender.name} (${sender.address})`);
    console.log(`👤 To: ${recipient.name} (${recipient.address})`);
    console.log(`💰 Amount: ${amount} VSC`);

    // Step 1: Check sender balance
    console.log("\n📝 Step 1: Checking sender balance on blockchain...");
    const senderBalance = await digitalToken.balanceOf(sender.address);
    console.log(
      `   💰 Sender Balance: ${ethers.formatEther(senderBalance)} VSC`,
    );

    if (senderBalance < amountWei) {
      console.log("   ❌ Insufficient balance!");
      return;
    }

    // Step 2: Verify compliance on-chain
    console.log("\n📝 Step 2: Verifying compliance on blockchain...");
    const identityRegistry = mod.state.getContract("identityRegistry");
    const senderVerified = await identityRegistry.isVerified(sender.address);
    const recipientVerified = await identityRegistry.isVerified(
      recipient.address,
    );

    console.log(
      `   ${senderVerified ? "✅" : "❌"} Sender Verified: ${senderVerified}`,
    );
    console.log(
      `   ${recipientVerified ? "✅" : "❌"} Recipient Verified: ${recipientVerified}`,
    );

    if (!senderVerified || !recipientVerified) {
      console.log("   ❌ One or both users not verified on-chain!");
      return;
    }

    // Task 4.10: wait out the sender's cooldown (dev node), else stop, so
    // canTransfer below answers for the limits, not the cooldown.
    if (!(await waitOutCooldown(mod.state, sender.signer))) return;

    // Step 3: Check transfer limits on-chain
    console.log("\n📝 Step 3: Checking transfer limits on blockchain...");
    const canTransfer = await digitalToken.canTransfer(
      sender.address,
      recipient.address,
      amountWei,
    );
    console.log(`   ${canTransfer ? "✅" : "❌"} Can Transfer: ${canTransfer}`);

    if (!canTransfer) {
      console.log("   ❌ Transfer blocked by compliance rules!");
      console.log(
        "   💡 Amount may exceed transfer limits or violate compliance rules",
      );
      return;
    }

    // Step 4: Execute transfer on blockchain
    console.log("\n📝 Step 4: Executing transfer on blockchain...");
    const tx = await digitalToken
      .connect(sender.signer)
      .transfer(recipient.address, amountWei);
    const receipt = await tx.wait();
    totalGasUsed += receipt.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
    console.log(`   🧱 Block Number: ${receipt.blockNumber}`);
    console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

    // Step 5: Verify balances on-chain
    console.log("\n📝 Step 5: Verifying balances on blockchain...");
    const newSenderBalance = await digitalToken.balanceOf(sender.address);
    const newRecipientBalance = await digitalToken.balanceOf(recipient.address);

    console.log(
      `   💰 Sender New Balance: ${ethers.formatEther(newSenderBalance)} VSC`,
    );
    console.log(
      `   💰 Recipient New Balance: ${ethers.formatEther(newRecipientBalance)} VSC`,
    );

    // Update JavaScript records
    const senderRecord = mod.state.normalUsers.get(sender.id);
    const recipientRecord = mod.state.normalUsers.get(recipient.id);
    if (senderRecord)
      senderRecord.tokenBalance = parseFloat(
        ethers.formatEther(newSenderBalance),
      );
    if (recipientRecord)
      recipientRecord.tokenBalance = parseFloat(
        ethers.formatEther(newRecipientBalance),
      );

    // Record transaction
    mod.state.transferHistory.push({
      type: "USER_TO_USER_TRANSFER",
      from: sender.name,
      to: recipient.name,
      amount: parseFloat(amount),
      timestamp: new Date().toISOString(),
      status: "SUCCESS",
      reason: "Compliant user-to-user transfer",
    });

    console.log("\n🎉 USER-TO-USER TRANSFER SUCCESSFUL!");
    console.log("=".repeat(60));
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    console.log("💡 Transfer enforced by ComplianceRules contract on-chain");
  } catch (error) {
    console.error("❌ Transfer failed:", error.message);
    console.log(
      "💡 Make sure both users are verified and amount is within limits",
    );
  }
}

/**
 * View transfer history
 * @private
 */
async function viewTransferHistory(mod) {
  console.log("\n📜 TRANSFER HISTORY");
  console.log("=".repeat(60));

  if (!mod.state.transferHistory || mod.state.transferHistory.length === 0) {
    console.log("❌ No transfers recorded yet");
    console.log("💡 Execute some transfers first (Options 26, 27, 27.5)");
    return;
  }

  console.log(`\n📊 Total Transactions: ${mod.state.transferHistory.length}\n`);

  mod.state.transferHistory.forEach((tx, index) => {
    const statusIcon = tx.status === "SUCCESS" ? "✅" : "❌";
    console.log(`${index + 1}. ${statusIcon} ${tx.type}`);
    console.log(`   From: ${tx.from}`);
    console.log(`   To: ${tx.to}`);
    console.log(`   Amount: ${tx.amount.toLocaleString()} VSC`);
    console.log(`   Status: ${tx.status}`);
    if (tx.reason) console.log(`   Reason: ${tx.reason}`);
    if (tx.txHash) console.log(`   TX Hash: ${tx.txHash}`);
    console.log(`   Time: ${new Date(tx.timestamp).toLocaleString()}`);
    console.log("");
  });

  // Summary statistics
  const successful = mod.state.transferHistory.filter(
    (tx) => tx.status === "SUCCESS",
  ).length;
  const blocked = mod.state.transferHistory.filter(
    (tx) => tx.status === "BLOCKED",
  ).length;

  console.log("📊 SUMMARY:");
  console.log(`   ✅ Successful: ${successful}`);
  console.log(`   ❌ Blocked: ${blocked}`);
  console.log(
    `   📈 Success Rate: ${((successful / mod.state.transferHistory.length) * 100).toFixed(1)}%`,
  );
}

module.exports = { userToUserTransfer, viewTransferHistory };
