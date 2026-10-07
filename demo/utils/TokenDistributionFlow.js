/**
 * @fileoverview Token option 25 -> 2..4: distribute VSC to investors
 * @module TokenDistributionFlow
 * @description Distribution to all approved investors or one, and the distribution
 * rules.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");

/**
 * Distribute to all approved investors (menu wrapper)
 * @private
 */
async function distributeToAllApprovedFromMenu(mod, centralBank) {
  // Check if there are investors
  if (mod.state.investors.size === 0) {
    console.log(
      "❌ No investors created yet. Create investors first (option 23)",
    );
    return;
  }

  const approvedInvestors = Array.from(mod.state.investors.values()).filter(
    (inv) => inv.tokenEligible,
  );

  if (approvedInvestors.length === 0) {
    console.log("\n❌ No approved investors found!");
    console.log("💡 Create compliant investors first (option 23 → 1)");
    return;
  }

  await mod.distributeToAllApproved(centralBank, approvedInvestors);
}

/**
 * Distribute to specific investor (menu wrapper)
 * @private
 */
async function distributeToSpecificInvestorFromMenu(mod, centralBank) {
  // Check if there are investors
  if (mod.state.investors.size === 0) {
    console.log(
      "❌ No investors created yet. Create investors first (option 23)",
    );
    return;
  }

  const approvedInvestors = Array.from(mod.state.investors.values()).filter(
    (inv) => inv.tokenEligible,
  );

  if (approvedInvestors.length === 0) {
    console.log("\n❌ No approved investors found!");
    console.log("💡 Create compliant investors first (option 23 → 1)");
    return;
  }

  await mod.distributeToSpecificInvestor(centralBank, approvedInvestors);
}

/**
 * Distribute to all approved investors
 * @private
 */
async function distributeToAllApproved(mod, centralBank, approvedInvestors) {
  console.log("\n🎯 DISTRIBUTING TO ALL APPROVED INVESTORS - ON-CHAIN");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  const amountPerInvestor = 50000; // 50,000 VSC each
  const totalAmount = amountPerInvestor * approvedInvestors.length;

  console.log(`\n📊 DISTRIBUTION PLAN:`);
  console.log(`   Approved Investors: ${approvedInvestors.length}`);
  console.log(
    `   Amount per Investor: ${amountPerInvestor.toLocaleString()} VSC`,
  );
  console.log(`   Total Distribution: ${totalAmount.toLocaleString()} VSC`);

  console.log("\n🔍 COMPLIANCE VALIDATION:");
  approvedInvestors.forEach((investor, index) => {
    console.log(`   ${index + 1}. ${investor.name}: KYC ✅ AML ✅ → APPROVED`);
  });

  // Continue in next method due to 150-line limit...
  await mod.completeDistributeToAllApproved(
    centralBank,
    approvedInvestors,
    amountPerInvestor,
    digitalToken,
  );
}

/**
 * Complete distribution to all approved investors (part 2)
 * @private
 */
async function completeDistributeToAllApproved(
  mod,
  centralBank,
  approvedInvestors,
  amountPerInvestor,
  digitalToken,
) {
  try {
    let totalGasUsed = 0n;

    console.log("\n🪙 Minting tokens on blockchain...");

    const identityRegistry = mod.state.getContract("identityRegistry");

    // Mint to each approved investor
    for (let i = 0; i < approvedInvestors.length; i++) {
      const investor = approvedInvestors[i];
      const amountWei = ethers.parseEther(amountPerInvestor.toString());

      console.log(
        `\n📝 Investor ${i + 1}/${approvedInvestors.length}: ${investor.name}`,
      );

      // Verify compliance on-chain
      const isVerified = await identityRegistry.isVerified(investor.address);
      console.log(`   ${isVerified ? "✅" : "❌"} Verified: ${isVerified}`);

      if (!isVerified) {
        console.log(`   ⚠️  Skipping ${investor.name} - not verified on-chain`);
        continue;
      }

      const refusal = await mod._mintRefusal(
        digitalToken,
        investor.address,
        amountWei,
      );
      if (refusal) {
        console.log(`   ⚠️  Skipping ${investor.name} - ${refusal}`);
        continue;
      }

      // Mint tokens on-chain
      const tx = await digitalToken
        .connect(centralBank.signer)
        .mint(investor.address, amountWei);
      const receipt = await tx.wait();
      totalGasUsed += receipt.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
      console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

      // Verify balance on-chain
      const balance = await digitalToken.balanceOf(investor.address);
      console.log(`   💰 Balance: ${ethers.formatEther(balance)} VSC`);

      // Update JavaScript record
      const investorRecord = mod.state.investors.get(investor.id);
      if (investorRecord) {
        investorRecord.tokenBalance = parseFloat(ethers.formatEther(balance));
      }
    }

    console.log("\n🎉 DISTRIBUTION COMPLETE!");
    console.log("=".repeat(60));
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    console.log("💡 All approved investors received tokens on-chain");
    console.log("💡 Transfer limits enforced by smart contract");
  } catch (error) {
    console.error("❌ Distribution failed:", error.message);
  }
}

/**
 * Distribute to specific investor
 * @private
 */
async function distributeToSpecificInvestor(
  mod,
  centralBank,
  approvedInvestors,
) {
  console.log("\n🎯 DISTRIBUTE TO SPECIFIC INVESTOR - ON-CHAIN");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  console.log("\n👥 APPROVED INVESTORS:");
  approvedInvestors.forEach((investor, index) => {
    console.log(`   ${index}: ${investor.name} - ${investor.address}`);
  });

  const investorIndex = await mod.promptUser(
    `Select investor (0-${approvedInvestors.length - 1}): `,
  );
  const selectedInvestor = approvedInvestors[parseInt(investorIndex)];

  if (!selectedInvestor) {
    console.log("❌ Invalid investor selection");
    return;
  }

  const amount = await mod.promptUser("Enter amount to mint (VSC): ");
  const amountWei = ethers.parseEther(amount);

  try {
    let totalGasUsed = 0n;

    console.log("\n🔗 MINTING TOKENS ON-CHAIN...");
    console.log(`👤 Investor: ${selectedInvestor.name}`);
    console.log(`🆔 Address: ${selectedInvestor.address}`);
    console.log(`💰 Amount: ${amount} VSC`);

    // Step 1: Verify investor compliance on-chain
    console.log("\n📝 Step 1: Verifying investor compliance on blockchain...");
    const identityRegistry = mod.state.getContract("identityRegistry");
    const isVerified = await identityRegistry.isVerified(
      selectedInvestor.address,
    );
    console.log(
      `   ${isVerified ? "✅" : "❌"} Investor Verified: ${isVerified}`,
    );

    if (!isVerified) {
      console.log("❌ Investor not verified on-chain! Cannot mint tokens.");
      return;
    }

    // Step 2: Check current balance on-chain
    console.log("\n📝 Step 2: Checking current balance on blockchain...");
    const balanceBefore = await digitalToken.balanceOf(
      selectedInvestor.address,
    );
    console.log(
      `   💰 Current Balance: ${ethers.formatEther(balanceBefore)} VSC`,
    );

    const refusal = await mod._mintRefusal(
      digitalToken,
      selectedInvestor.address,
      amountWei,
    );
    if (refusal) {
      console.log(`❌ Mint refused: ${refusal}`);
      return;
    }

    // Step 3: Mint tokens on-chain
    console.log("\n📝 Step 3: Minting tokens on blockchain...");
    const tx = await digitalToken
      .connect(centralBank.signer)
      .mint(selectedInvestor.address, amountWei);
    const receipt = await tx.wait();
    totalGasUsed += receipt.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
    console.log(`   🧱 Block Number: ${receipt.blockNumber}`);
    console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

    // Step 4: Verify new balance on-chain
    console.log("\n📝 Step 4: Verifying new balance on blockchain...");
    const balanceAfter = await digitalToken.balanceOf(selectedInvestor.address);
    console.log(`   💰 New Balance: ${ethers.formatEther(balanceAfter)} VSC`);
    console.log(
      `   📈 Increase: ${ethers.formatEther(balanceAfter - balanceBefore)} VSC`,
    );

    // Step 5: Verify total supply on-chain
    console.log("\n📝 Step 5: Verifying total supply on blockchain...");
    const totalSupply = await digitalToken.totalSupply();
    console.log(`   📊 Total Supply: ${ethers.formatEther(totalSupply)} VSC`);

    // Record transaction in history
    mod.state.transferHistory.push({
      type: "MINT",
      from: centralBank.name,
      to: selectedInvestor.name,
      toAddress: selectedInvestor.address,
      amount: amount,
      timestamp: new Date().toISOString(),
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: "SUCCESS",
    });

    console.log("\n🎉 TOKENS MINTED ON-CHAIN SUCCESSFULLY!");
    console.log("=".repeat(60));
    console.log(`👤 Investor: ${selectedInvestor.name}`);
    console.log(`💰 Amount Minted: ${amount} VSC`);
    console.log(`📊 New Balance: ${ethers.formatEther(balanceAfter)} VSC`);
    console.log(`🔗 Transaction: ${receipt.hash}`);
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

    console.log("\n💡 Next Steps:");
    console.log("   • Investor can now transfer tokens (option 26)");
    console.log("   • Maximum transfer: 8,000 VSC per transaction");
    console.log("   • All transfers verified on-chain");
  } catch (error) {
    console.error("❌ Minting failed:", error.message);
    if (error.message.includes("AccessControl")) {
      console.error("💡 Only Token Issuer can mint tokens");
    }
  }
}

/**
 * Show distribution rules
 * @private
 */
async function showDistributionRules(mod) {
  console.log("\n📋 DIGITAL TOKEN DISTRIBUTION RULES");
  console.log("-".repeat(40));

  console.log("\n🏛️ CENTRAL BANK AUTHORITY:");
  console.log(
    "   • Only Token Issuer can mint and distribute Vanguard StableCoin",
  );
  console.log("   • Distribution only to KYC/AML approved investors");
  console.log("   • All distributions are monitored and recorded");

  console.log("\n✅ INVESTOR ELIGIBILITY:");
  console.log("   • KYC Status: ISSUED (required)");
  console.log("   • AML Status: ISSUED (required)");
  console.log("   • Compliance Status: COMPLIANT (required)");

  console.log("\n🚫 DISTRIBUTION RESTRICTIONS:");
  console.log("   • Non-compliant investors: BLOCKED");
  console.log("   • Rejected KYC/AML: BLOCKED");
  console.log("   • Pending compliance: BLOCKED");

  console.log("\n💸 TRANSFER LIMITS:");
  console.log("   • Investor-to-Investor: 8,000 VSC max per transaction");
  console.log("   • Token Issuer Distribution: No limit");
  console.log("   • All transfers monitored by Token Issuer");

  console.log("\n📊 COMPLIANCE MONITORING:");
  console.log("   • Real-time transaction tracking");
  console.log("   • Automatic compliance validation");
  console.log("   • Audit trail for all operations");
}

module.exports = {
  distributeToAllApprovedFromMenu,
  distributeToSpecificInvestorFromMenu,
  distributeToAllApproved,
  completeDistributeToAllApproved,
  distributeToSpecificInvestor,
  showDistributionRules,
};
