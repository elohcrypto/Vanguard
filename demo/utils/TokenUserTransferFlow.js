/**
 * @fileoverview Token option 27: investor-to-user transfers
 * @module TokenUserTransferFlow
 * @description The normal, excess and blocked investor-to-user scenarios.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");
const { waitOutCooldown } = require("./InvestorTypeRules");

/** Option 27: Investor-to-User Transfer */
async function investorToUserTransfer(mod) {
  console.log("\n💸 INVESTOR-TO-USER TRANSFER (MAX 8,000)");
  console.log("=".repeat(50));

  if (!mod.state.investors || mod.state.investors.size === 0) {
    console.log(
      "❌ No investors created yet. Create investors first (option 23)",
    );
    return;
  }

  // Merge normal users from both Option 23 (investors with type NORMAL) and Option 24 (normalUsers)
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

  if (allNormalUsers.length === 0) {
    console.log(
      "❌ No normal users created yet. Create normal users first (option 23 → 1 or option 24)",
    );
    return;
  }

  // Show available investors with balances (check on-chain balance)
  console.log("\n👥 AVAILABLE INVESTORS:");
  const allInvestors = Array.from(mod.state.investors.values()).filter(
    (inv) => inv.tokenEligible,
  );
  const investorsWithBalance = [];

  // Check actual on-chain balances
  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  for (const investor of allInvestors) {
    try {
      const investorAddress = investor.user || investor.address;

      // Get both total and free balance to show frozen tokens
      const totalBalance = await digitalToken.balanceOf(investorAddress);
      const totalBalanceVSC = parseFloat(ethers.formatEther(totalBalance));

      const freeBalance = await digitalToken.getFreeBalance(investorAddress);
      const freeBalanceVSC = parseFloat(ethers.formatEther(freeBalance));

      const frozenTokens = await digitalToken.frozenTokens(investorAddress);
      const frozenBalanceVSC = parseFloat(ethers.formatEther(frozenTokens));

      // Store both balances for display
      investor.actualBalance = freeBalanceVSC; // Available for transfer
      investor.totalBalance = totalBalanceVSC; // Total including frozen
      investor.frozenBalance = frozenBalanceVSC; // Frozen tokens

      if (freeBalanceVSC > 0) {
        investorsWithBalance.push(investor);
      }
    } catch (error) {
      console.log(
        `⚠️  Error checking balance for ${investor.name}: ${error.message}`,
      );
    }
  }

  if (investorsWithBalance.length === 0) {
    console.log("❌ No investors have available (unfrozen) tokens to transfer");
    console.log("💡 Use Token Issuer distribution first (Option 25 → 2 or 3)");
    console.log("");
    console.log("📋 Quick Guide:");
    console.log("   1. Option 25 → 1: Mint to Central Bank");
    console.log("   2. Option 25 → 2: Distribute to All Investors");
    console.log("   3. Option 27: Transfer to Normal Users");
    console.log("");
    console.log(
      "💡 Note: Frozen tokens (locked in multi-sig) cannot be transferred",
    );
    return;
  }

  investorsWithBalance.forEach((investor, index) => {
    let displayText = `   ${index}: ${investor.name} (${investor.actualBalance.toLocaleString()} VSC) ✅`;

    // Show frozen balance if any
    if (investor.frozenBalance > 0) {
      displayText += ` [${investor.frozenBalance.toLocaleString()} VSC frozen]`;
    }

    console.log(displayText);
  });

  // Show available normal users with on-chain balances (from both sources)
  console.log("\n👤 AVAILABLE NORMAL USERS:");
  console.log(
    `   (${normalUsersFromInvestors.length} from Option 23, ${normalUsersFromOption24.length} from Option 24)`,
  );
  const compliantUsers = allNormalUsers.filter((user) => user.tokenEligible);

  if (compliantUsers.length === 0) {
    console.log("❌ No compliant normal users available");
    console.log(
      "💡 Create compliant normal users first (option 23 → 1 or option 24 → 1)",
    );
    return;
  }

  // Check on-chain balances for normal users
  for (let index = 0; index < compliantUsers.length; index++) {
    const user = compliantUsers[index];
    let balance = 0;
    const userAddress = user.user || user.address;

    if (digitalToken && userAddress) {
      try {
        const onchainBalance = await digitalToken.balanceOf(userAddress);
        balance = parseFloat(ethers.formatEther(onchainBalance));
      } catch (error) {
        balance = user.tokenBalance || 0;
      }
    } else {
      balance = user.tokenBalance || 0;
    }

    console.log(
      `   ${index}: ${user.name} (${balance.toLocaleString()} VSC) ✅`,
    );
  }

  console.log("\n🔄 TRANSFER SCENARIOS:");
  console.log("1. Normal Transfer (Within 8,000 limit)");
  console.log("2. Attempt Excess Transfer (>8,000 limit)");
  console.log("3. Transfer to Non-Compliant User (Blocked)");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select transfer scenario (0-3): ");

  try {
    switch (choice) {
      case "1":
        await mod.executeInvestorToUserNormalTransfer(
          investorsWithBalance,
          compliantUsers,
        );
        break;
      case "2":
        await mod.executeInvestorToUserExcessTransfer(
          investorsWithBalance,
          compliantUsers,
        );
        break;
      case "3":
        await mod.executeInvestorToUserBlockedTransfer(investorsWithBalance);
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
 * Execute normal investor-to-user transfer
 * @private
 */
async function executeInvestorToUserNormalTransfer(mod, investors, users) {
  console.log("\n✅ NORMAL INVESTOR-TO-USER TRANSFER");
  console.log("-".repeat(40));

  // Select investor
  console.log("\n👥 SELECT INVESTOR:");
  investors.forEach((inv, index) => {
    const balance = inv.actualBalance || inv.tokenBalance || 0;
    console.log(
      `   ${index}: ${inv.name} (${balance.toLocaleString()} VSC available)`,
    );
  });

  const investorChoice = await mod.promptUser(
    `\nSelect investor (0-${investors.length - 1}): `,
  );
  const investor = investors[parseInt(investorChoice)];

  if (!investor) {
    console.log("❌ Invalid investor selection");
    return;
  }

  // Continue in next method due to 150-line limit...
  await mod.completeInvestorToUserNormalTransfer(investor, users);
}

/**
 * Complete investor-to-user normal transfer (part 2)
 * @private
 */
async function completeInvestorToUserNormalTransfer(mod, investor, users) {
  // Select user
  console.log("\n👤 SELECT RECIPIENT USER:");
  users.forEach((u, index) => {
    console.log(`   ${index}: ${u.name}`);
  });

  const userChoice = await mod.promptUser(
    `\nSelect user (0-${users.length - 1}): `,
  );
  const user = users[parseInt(userChoice)];

  if (!user) {
    console.log("❌ Invalid user selection");
    return;
  }

  // Get available balance
  const availableBalance = investor.actualBalance || investor.tokenBalance || 0;

  if (availableBalance <= 0) {
    console.log("❌ Investor has no tokens to transfer");
    return;
  }

  // Enter custom amount
  const maxAmount = Math.min(availableBalance, 8000); // Max 8,000 or available balance
  console.log(`\n💰 ENTER TRANSFER AMOUNT:`);
  console.log(`   Available: ${availableBalance.toLocaleString()} VSC`);
  console.log(`   Maximum: ${maxAmount.toLocaleString()} VSC (8,000 limit)`);

  const amountInput = await mod.promptUser(`\nEnter amount (1-${maxAmount}): `);
  const amount = parseFloat(amountInput);

  if (isNaN(amount) || amount <= 0) {
    console.log("❌ Invalid amount");
    return;
  }

  if (amount > availableBalance) {
    console.log("❌ Amount exceeds investor balance");
    return;
  }

  if (amount > 8000) {
    console.log("❌ Amount exceeds 8,000 VSC limit");
    return;
  }

  console.log(`\n🔍 COMPLIANCE CHECK:`);
  console.log(
    `   Investor: ${investor.name} - KYC: ${investor.kycStatus} ✅ AML: ${investor.amlStatus} ✅`,
  );
  console.log(
    `   User: ${user.name} - KYC: ${user.kycStatus} ✅ AML: ${user.amlStatus} ✅`,
  );
  console.log(
    `   Amount: ${amount.toLocaleString()} VSC (Under 8,000 limit ✅)`,
  );

  try {
    console.log(`\n💸 Executing on-chain transfer...`);

    // Get addresses
    const investorAddress = investor.user || investor.address;
    const userAddress = user.user || user.address;

    // Get investor signer
    const investorSigner = investor.signer;

    // Task 4.10: wait out the investor's cooldown (dev node), else stop.
    if (!(await waitOutCooldown(mod.state, investorSigner))) return;

    // Execute on-chain transfer
    const digitalToken = mod.state.getContract("digitalToken");
    const amountWei = ethers.parseEther(amount.toString());
    const tx = await digitalToken
      .connect(investorSigner)
      .transfer(userAddress, amountWei);
    await tx.wait();

    console.log(`✅ Transfer approved!`);
    console.log(`   Transaction Hash: ${tx.hash}`);

    // Update balances
    const investorRecord = mod.state.investors.get(investor.id);
    const userRecord = mod.state.normalUsers.get(user.id);

    if (investorRecord) investorRecord.tokenBalance -= amount;
    if (userRecord) userRecord.tokenBalance += amount;

    // Record transaction
    mod.state.transferHistory.push({
      type: "INVESTOR_TO_USER_TRANSFER",
      from: investor.name,
      to: user.name,
      amount: amount,
      timestamp: new Date().toISOString(),
      status: "SUCCESS",
      reason: "Compliant transfer within limits",
      txHash: tx.hash,
    });

    // Get updated on-chain balances
    const investorBalanceAfter = await digitalToken.balanceOf(investorAddress);
    const userBalanceAfter = await digitalToken.balanceOf(userAddress);

    console.log(`\n📊 UPDATED BALANCES (ON-CHAIN):`);
    console.log(
      `   ${investor.name} (Investor): ${ethers.formatEther(investorBalanceAfter)} VSC`,
    );
    console.log(
      `   ${user.name} (User): ${ethers.formatEther(userBalanceAfter)} VSC`,
    );

    console.log("\n🎉 INVESTOR-TO-USER TRANSFER SUCCESSFUL!");
  } catch (error) {
    console.error("❌ Transfer failed:", error.message);
    console.log("💡 Make sure both parties are verified and compliant");
  }
}

/**
 * Execute excess investor-to-user transfer
 * @private
 */
async function executeInvestorToUserExcessTransfer(mod, investors, users) {
  console.log("\n🚫 EXCESS INVESTOR-TO-USER TRANSFER");
  console.log("-".repeat(40));

  const investor = investors[0];
  const user = users[0];
  const amount = 12000; // Exceeds 8,000 limit

  console.log(`\n🔍 COMPLIANCE CHECK:`);
  console.log(
    `   Investor: ${investor.name} - KYC: ${investor.kycStatus} ✅ AML: ${investor.amlStatus} ✅`,
  );
  console.log(
    `   User: ${user.name} - KYC: ${user.kycStatus} ✅ AML: ${user.amlStatus} ✅`,
  );
  console.log(
    `   Amount: ${amount.toLocaleString()} VSC (EXCEEDS 8,000 limit ❌)`,
  );

  console.log(`\n💸 Attempting transfer...`);
  console.log(`⏳ Validating ERC-3643 compliance...`);
  console.log(`⏳ Checking transfer limits...`);
  console.log(`⛔ TRANSFER BLOCKED! (expected)`);
  console.log(`🚫 Reason: Amount exceeds ERC-3643 transfer limit of 8,000 VSC`);

  // Record blocked transaction
  mod.state.transferHistory.push({
    type: "INVESTOR_TO_USER_TRANSFER",
    from: investor.name,
    to: user.name,
    amount: amount,
    timestamp: new Date().toISOString(),
    status: "BLOCKED",
    reason: "Exceeds 8,000 VSC ERC-3643 transfer limit",
  });

  console.log("\n⛔ TRANSFER BLOCKED BY ERC-3643 LIMITS! (expected)");
  console.log("💡 Maximum transfer amount is 8,000 VSC per transaction");
}

/**
 * Execute blocked investor-to-user transfer
 * @private
 */
async function executeInvestorToUserBlockedTransfer(mod, investors) {
  console.log("\n🚫 TRANSFER TO NON-COMPLIANT USER");
  console.log("-".repeat(40));

  const nonCompliantUsers = Array.from(mod.state.normalUsers.values()).filter(
    (user) => !user.tokenEligible,
  );

  if (nonCompliantUsers.length === 0) {
    console.log("ℹ️  No non-compliant users available for this demo");
    console.log("💡 Create a non-compliant user first (option 24 → 2)");
    return;
  }

  const investor = investors[0];
  const user = nonCompliantUsers[0];
  const amount = 3000;

  console.log(`\n🔍 COMPLIANCE CHECK:`);
  console.log(
    `   Investor: ${investor.name} - KYC: ${investor.kycStatus} ✅ AML: ${investor.amlStatus} ✅`,
  );
  console.log(
    `   User: ${user.name} - KYC: ${user.kycStatus} ❌ AML: ${user.amlStatus} ❌`,
  );
  console.log(
    `   Amount: ${amount.toLocaleString()} VSC (Within 8,000 limit ✅)`,
  );

  console.log(`\n💸 Attempting transfer...`);
  console.log(`⏳ Validating ERC-3643 compliance...`);
  console.log(`⛔ TRANSFER BLOCKED! (expected)`);
  console.log(
    `🚫 Reason: Recipient is not KYC/AML compliant per ERC-3643 rules`,
  );

  // Record blocked transaction
  mod.state.transferHistory.push({
    type: "INVESTOR_TO_USER_TRANSFER",
    from: investor.name,
    to: user.name,
    amount: amount,
    timestamp: new Date().toISOString(),
    status: "BLOCKED",
    reason: "Recipient not KYC/AML compliant (ERC-3643 violation)",
  });

  console.log("\n⛔ TRANSFER BLOCKED BY ERC-3643 COMPLIANCE! (expected)");
  console.log("💡 Only KYC/AML approved users can receive Vanguard StableCoin");
}

module.exports = {
  investorToUserTransfer,
  executeInvestorToUserNormalTransfer,
  completeInvestorToUserNormalTransfer,
  executeInvestorToUserExcessTransfer,
  executeInvestorToUserBlockedTransfer,
};
