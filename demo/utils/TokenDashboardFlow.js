/**
 * @fileoverview Token options 29-30: dashboard, transaction summary
 * @module TokenDashboardFlow
 * @description The ERC-3643 dashboard (investors, users, metrics) and the transaction
 * summary.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");

/** Option 29: ERC-3643 Dashboard */
async function showDashboard(mod) {
  console.log("\n📊 ERC-3643 DIGITAL TOKEN DASHBOARD");
  console.log("=".repeat(50));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ ERC-3643 Digital Token system not deployed yet");
    console.log("💡 Deploy the system first (option 21)");
    return;
  }

  try {
    // Token Issuer Status
    const centralBank = Array.from(mod.state.bankingInstitutions.values()).find(
      (bank) => bank.type === "CENTRAL_BANK",
    );
    console.log("\n🏛️ CENTRAL BANK (Token Issuer) STATUS:");
    if (centralBank) {
      console.log(`   Name: ${centralBank.name}`);
      console.log(`   Address: ${centralBank.address}`);

      // Get balance from blockchain
      const balance = await digitalToken.balanceOf(centralBank.address);
      console.log(`   Balance: ${ethers.formatEther(balance)} VSC`);

      // Check if agent
      const isAgent = await digitalToken.isAgent(centralBank.address);
      console.log(
        `   Minting Authority: ${isAgent ? "✅ ACTIVE" : "❌ INACTIVE"}`,
      );
    } else {
      console.log("   Status: ❌ NOT CREATED");
      console.log("   💡 Create token issuer (option 22)");
    }

    // Continue in next method due to 150-line limit...
    await mod.showDashboardInvestors(digitalToken);
  } catch (error) {
    console.error("❌ Dashboard error:", error.message);
  }
}

/**
 * Show investor details in dashboard (part 2)
 * @private
 */
async function showDashboardInvestors(mod, digitalToken) {
  // Investor Overview
  const investorCount = mod.state.investors ? mod.state.investors.size : 0;
  const compliantInvestors = mod.state.investors
    ? Array.from(mod.state.investors.values()).filter(
        (inv) => inv.tokenEligible,
      ).length
    : 0;

  console.log("\n👥 INVESTOR OVERVIEW:");
  console.log(`   Total Investors: ${investorCount}`);
  console.log(`   Compliant: ${compliantInvestors}`);

  // Get detailed balance from blockchain for each investor
  let investorTotalBalance = 0;
  if (mod.state.investors && mod.state.investors.size > 0) {
    console.log("\n   📋 INVESTOR DETAILS:");
    let index = 1;
    const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");

    for (const investor of mod.state.investors.values()) {
      // Skip investors without valid address
      if (!investor.address || investor.address === null) {
        console.log(`\n   ${index}. ${investor.name} - ⚠️ No address assigned`);
        index++;
        continue;
      }

      // Get total balance
      const totalBalance = await digitalToken.balanceOf(investor.address);
      const totalBalanceFormatted = parseFloat(
        ethers.formatEther(totalBalance),
      );

      // Get frozen (locked) tokens
      const frozenTokens = await digitalToken.frozenTokens(investor.address);
      const frozenBalanceFormatted = parseFloat(
        ethers.formatEther(frozenTokens),
      );

      // Get free (available) balance
      const freeBalance = await digitalToken.getFreeBalance(investor.address);
      const freeBalanceFormatted = parseFloat(ethers.formatEther(freeBalance));

      investorTotalBalance += totalBalanceFormatted;

      // Get investor type and limits
      let investorTypeStr = "Unknown";
      let maxTransfer = "N/A";
      if (investorTypeRegistry) {
        const investorType = await investorTypeRegistry.getInvestorType(
          investor.address,
        );
        const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];
        investorTypeStr = typeNames[investorType] || "Unknown";

        const config =
          await investorTypeRegistry.getInvestorTypeConfig(investorType);
        maxTransfer = ethers.formatEther(config.maxTransferAmount);
      }

      console.log(`\n   ${index}. ${investor.name}`);
      console.log(`      🆔 Address: ${investor.address}`);
      console.log(`      📋 Type: ${investorTypeStr}`);
      console.log(
        `      💰 Total Balance: ${totalBalanceFormatted.toLocaleString()} VSC`,
      );

      // Show breakdown if an agent froze tokens
      if (frozenBalanceFormatted > 0) {
        console.log(
          `         🧊 Frozen: ${frozenBalanceFormatted.toLocaleString()} VSC`,
        );
        console.log(
          `         💵 Available: ${freeBalanceFormatted.toLocaleString()} VSC`,
        );
      }
      // The lock lives in the 2-of-2 MultiSigWallet (Task 4.3).
      if (investor.multiSigWallet) {
        const held = await digitalToken.balanceOf(
          investor.multiSigWallet.address,
        );
        console.log(
          `         🔐 Multi-Sig ${investor.multiSigWallet.address.substring(0, 10)}... holds ${parseFloat(ethers.formatEther(held)).toLocaleString()} VSC (bank + user to release)`,
        );
      }

      console.log(`      📊 Max Transfer: ${maxTransfer} VSC`);
      console.log(`      ✅ KYC: ${investor.kycStatus || "ISSUED"}`);
      console.log(`      ✅ AML: ${investor.amlStatus || "ISSUED"}`);
      index++;
    }
    console.log(
      `\n   💰 Total Balance: ${investorTotalBalance.toLocaleString()} VSC`,
    );
  } else {
    console.log("   💡 No investors created yet (use option 23)");
  }

  // Continue in next method...
  await mod.showDashboardUsers(digitalToken);
}

/**
 * Show user details and system status in dashboard (part 3)
 * @private
 */
async function showDashboardUsers(mod, digitalToken) {
  // Normal User Overview
  const userCount = mod.state.normalUsers ? mod.state.normalUsers.size : 0;
  const compliantUsers = mod.state.normalUsers
    ? Array.from(mod.state.normalUsers.values()).filter(
        (user) => user.tokenEligible,
      ).length
    : 0;

  console.log("\n👤 NORMAL USER OVERVIEW:");
  console.log(`   Total Users: ${userCount}`);
  console.log(`   Compliant: ${compliantUsers}`);

  // Get detailed balance from blockchain for each user
  let userTotalBalance = 0;
  if (mod.state.normalUsers && mod.state.normalUsers.size > 0) {
    console.log("\n   📋 USER DETAILS:");
    let index = 1;
    for (const user of mod.state.normalUsers.values()) {
      // Skip users without valid address
      if (!user.address || user.address === null) {
        console.log(`\n   ${index}. ${user.name} - ⚠️ No address assigned`);
        index++;
        continue;
      }

      const balance = await digitalToken.balanceOf(user.address);
      const balanceFormatted = parseFloat(ethers.formatEther(balance));
      userTotalBalance += balanceFormatted;

      console.log(`\n   ${index}. ${user.name}`);
      console.log(`      🆔 Address: ${user.address}`);
      console.log(`      💰 Balance: ${balanceFormatted.toLocaleString()} VSC`);
      console.log(`      ✅ KYC: ${user.kycStatus || "ISSUED"}`);
      console.log(`      ✅ AML: ${user.amlStatus || "ISSUED"}`);
      index++;
    }
    console.log(
      `\n   💰 Total Balance: ${userTotalBalance.toLocaleString()} VSC`,
    );
  } else {
    console.log("   💡 No users created yet (use option 24)");
  }

  // Continue in next method...
  await mod.showDashboardMetrics(digitalToken);
}

/**
 * Show compliance metrics and system status (part 4)
 * @private
 */
async function showDashboardMetrics(mod, digitalToken) {
  // ERC-3643 Compliance Metrics
  console.log("\n🔒 ERC-3643 COMPLIANCE METRICS:");
  console.log(`   Standard: ERC-3643 (T-REX)`);

  // Get on-chain transfer limits
  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (investorTypeRegistry) {
    const retailConfig = await investorTypeRegistry.getInvestorTypeConfig(1);
    console.log(
      `   Transfer Limit (Retail): ${ethers.formatEther(retailConfig.maxTransferAmount)} VSC`,
    );
  } else {
    console.log(`   Transfer Limit: 8,000 VSC (default)`);
  }

  // What VSC enforces, read from VSC: the registry it asks isVerified
  // (KYC/AML), its compliance module, its investor-type registry.
  const idReg = await digitalToken.identityRegistry();
  const rules = await digitalToken.compliance();
  const types = await digitalToken.investorTypeRegistry();
  console.log(`   Identity Registry (KYC/AML gate): ${idReg} (chain)`);
  console.log(`   Compliance: ${rules} (chain)`);
  if (types === ethers.ZeroAddress) {
    console.log(`   Investor Type Registry: none (chain)`);
  } else {
    const reg = await ethers.getContractAt("InvestorTypeRegistry", types);
    const authorized = await reg.isTokenAuthorized(digitalToken.target);
    console.log(`   Investor Type Registry: ${types} (chain)`);
    console.log(
      `   Registry authorizes VSC: ${authorized ? "✅ yes" : "⚠️  no (mints and transfers refused)"} (chain)`,
    );
  }

  // Transaction History
  const totalTransactions = mod.state.transferHistory.length;
  const successfulTransactions = mod.state.transferHistory.filter(
    (tx) => tx.status === "SUCCESS",
  ).length;
  const blockedTransactions = mod.state.transferHistory.filter(
    (tx) => tx.status === "BLOCKED",
  ).length;

  console.log("\n📈 TRANSACTION OVERVIEW:");
  console.log(`   Total Transactions: ${totalTransactions}`);
  console.log(
    `   Successful: ${successfulTransactions} (${totalTransactions > 0 ? ((successfulTransactions / totalTransactions) * 100).toFixed(1) : 0}%)`,
  );
  console.log(
    `   Blocked: ${blockedTransactions} (${totalTransactions > 0 ? ((blockedTransactions / totalTransactions) * 100).toFixed(1) : 0}%)`,
  );

  // Show recent transactions
  if (mod.state.transferHistory.length > 0) {
    console.log("\n   📋 RECENT TRANSACTIONS (Last 5):");
    const recentTxs = mod.state.transferHistory.slice(-5).reverse();
    recentTxs.forEach((tx, index) => {
      const statusIcon = tx.status === "SUCCESS" ? "✅" : "❌";
      console.log(`\n   ${index + 1}. ${statusIcon} ${tx.type || "TRANSFER"}`);
      console.log(`      From: ${tx.from || tx.fromBank || "N/A"}`);
      console.log(`      To: ${tx.to || tx.toBank || "N/A"}`);
      console.log(
        `      Amount: ${tx.amount ? tx.amount.toLocaleString() : "N/A"} VSC`,
      );
      console.log(`      Status: ${tx.status || "PENDING"}`);
      if (tx.reason) {
        console.log(`      Reason: ${tx.reason}`);
      }
      if (tx.timestamp) {
        console.log(`      Time: ${new Date(tx.timestamp).toLocaleString()}`);
      }
    });
  } else {
    console.log("   💡 No transactions yet");
  }

  // System Status
  const centralBank = Array.from(mod.state.bankingInstitutions.values()).find(
    (bank) => bank.type === "CENTRAL_BANK",
  );
  console.log("\n🎯 SYSTEM STATUS:");
  const systemStatus =
    digitalToken && centralBank ? "OPERATIONAL" : "SETUP_REQUIRED";
  console.log(`   ERC-3643 Digital Token: ${systemStatus}`);
  const paused = await digitalToken.paused();
  console.log(
    `   Transfers: ${paused ? "⏸️  PAUSED" : "▶️  not paused"} (chain: paused())`,
  );

  if (systemStatus === "SETUP_REQUIRED") {
    console.log("\n💡 NEXT STEPS:");
    if (!digitalToken) {
      console.log("   • Deploy ERC-3643 Digital Token System (option 21)");
    }
    if (!centralBank) {
      console.log("   • Create Token Issuer (option 22)");
    }
  }
}

/** Option 30: Transaction Summary */
async function showTransactionSummary(mod) {
  console.log("\n📈 TRANSACTION & DEPLOYMENT SUMMARY");
  console.log("=".repeat(50));

  try {
    // Display deployment summary
    mod.logger.displayComprehensiveSummary();

    // Additional statistics
    const deployedContracts = mod.logger.getDeployedContracts();
    const transactionHistory = mod.logger.getTransactionHistory();

    console.log("\n📊 DEPLOYMENT STATISTICS");
    console.log("-".repeat(50));
    console.log(`🏗️  Total Contracts Deployed: ${deployedContracts.size}`);
    console.log(
      `🔄 Total Blockchain Transactions: ${transactionHistory.length}`,
    );

    const successfulTxs = transactionHistory.filter(
      (tx) => tx.status === "SUCCESS",
    ).length;
    const failedTxs = transactionHistory.filter(
      (tx) => tx.status === "FAILED",
    ).length;

    console.log(`✅ Successful: ${successfulTxs}`);
    console.log(`${failedTxs > 0 ? "❌" : "▫️ "} Failed: ${failedTxs}`);

    if (transactionHistory.length > 0) {
      const successRate = (
        (successfulTxs / transactionHistory.length) *
        100
      ).toFixed(2);
      console.log(`📈 Success Rate: ${successRate}%`);
    }

    // Token Transfer Statistics
    if (mod.state.transferHistory && mod.state.transferHistory.length > 0) {
      console.log("\n💸 TOKEN TRANSFER STATISTICS");
      console.log("-".repeat(50));

      const totalTransfers = mod.state.transferHistory.length;
      const successfulTransfers = mod.state.transferHistory.filter(
        (tx) => tx.status === "SUCCESS",
      ).length;
      const blockedTransfers = mod.state.transferHistory.filter(
        (tx) => tx.status === "BLOCKED",
      ).length;

      console.log(`📊 Total Transfer Attempts: ${totalTransfers}`);
      console.log(`✅ Successful Transfers: ${successfulTransfers}`);
      console.log(
        `${blockedTransfers > 0 ? "⛔" : "▫️ "} Blocked Transfers: ${blockedTransfers}`,
      );
      console.log(
        `📈 Transfer Success Rate: ${((successfulTransfers / totalTransfers) * 100).toFixed(1)}%`,
      );

      // Calculate total volume
      const totalVolume = mod.state.transferHistory
        .filter((tx) => tx.status === "SUCCESS")
        .reduce((sum, tx) => sum + (tx.amount || 0), 0);
      console.log(
        `💰 Total Volume Transferred: ${totalVolume.toLocaleString()} VSC`,
      );

      // Transfer type breakdown
      const transferTypes = {};
      mod.state.transferHistory.forEach((tx) => {
        const type = tx.type || "UNKNOWN";
        transferTypes[type] = (transferTypes[type] || 0) + 1;
      });

      console.log("\n📋 Transfer Type Breakdown:");
      Object.entries(transferTypes).forEach(([type, count]) => {
        console.log(`   ${type}: ${count}`);
      });
    }

    // Show recent blockchain transactions
    if (transactionHistory.length > 0) {
      console.log("\n🕒 RECENT BLOCKCHAIN TRANSACTIONS (Last 5)");
      console.log("-".repeat(50));

      const recentTxs = transactionHistory.slice(-5);
      recentTxs.forEach((tx, index) => {
        console.log(`${index + 1}. ${tx.name || "Unknown Operation"}`);
        console.log(`   Hash: ${tx.transactionHash || "N/A"}`);
        console.log(`   Status: ${tx.status}`);
        console.log(
          `   Gas Used: ${tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : "N/A"}`,
        );
        console.log("");
      });
    }

    // Show contract addresses
    if (deployedContracts.size > 0) {
      console.log("\n📋 DEPLOYED CONTRACT ADDRESSES");
      console.log("-".repeat(50));

      deployedContracts.forEach((info, name) => {
        console.log(`${name}:`);
        console.log(`   Address: ${info.contractAddress}`);
        console.log(`   Block: ${info.blockNumber}`);
        console.log(`   Gas Used: ${Number(info.gasUsed).toLocaleString()}`);
        console.log("");
      });
    }

    // System Overview
    console.log("\n🎯 SYSTEM OVERVIEW");
    console.log("-".repeat(50));
    console.log(`👥 Total Investors: ${mod.state.investors.size}`);
    console.log(`👤 Total Normal Users: ${mod.state.normalUsers.size}`);
    console.log(
      `🏛️  Banking Institutions: ${mod.state.bankingInstitutions.size}`,
    );
    console.log(`🆔 OnchainID Identities: ${mod.state.identities.size}`);
    console.log(`📜 Claims Issued: ${mod.state.claims.size}`);

    console.log("\n✅ Summary display completed!");
  } catch (error) {
    console.error(`❌ Error displaying summary: ${error.message}`);
  }
}

module.exports = {
  showDashboard,
  showDashboardInvestors,
  showDashboardUsers,
  showDashboardMetrics,
  showTransactionSummary,
};
