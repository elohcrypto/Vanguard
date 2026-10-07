/**
 * @fileoverview Token option 23 -> 3..9a: custody, approval, investor views
 * @module TokenInvestorFlow
 * @description Bank transfer, the 2-of-2 MultiSigWallet, locking, approval and
 * downgrade, and the request, investor and signer views.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { displayError } = require("./DisplayHelpers");
const Custody = require("./CustodyFlow");
const { ethers } = require("hardhat");

/**
 * Bank transfers tokens to user
 * @private
 */
async function bankTransfersTokensToUser(mod) {
  console.log("\n💸 BANK TRANSFERS TOKENS TO USER");
  console.log("=".repeat(60));
  console.log("Phase 2: Token Transfer (Required before locking)");
  console.log("");

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed!");
    console.log("💡 Deploy Digital Token system first (Option 21)");
    return;
  }

  // Get central bank
  const centralBank = Array.from(mod.state.bankingInstitutions.values()).find(
    (bank) => bank.type === "CENTRAL_BANK",
  );
  if (!centralBank) {
    console.log("❌ Token Issuer (Central Bank) not found!");
    console.log("💡 Create Token Issuer first (Option 22)");
    return;
  }

  // Show users with pending requests
  if (!mod.state.investors || mod.state.investors.size === 0) {
    console.log("❌ No investors found!");
    console.log(
      "💡 Create normal users and request investor status first (Options 1-2)",
    );
    return;
  }

  const usersWithRequests = Array.from(mod.state.investors.values()).filter(
    (u) =>
      u.investorRequest &&
      u.investorRequest.status === "PENDING" &&
      !u.investorRequest.tokensReceived,
  );

  if (usersWithRequests.length === 0) {
    console.log("❌ No users with pending requests needing tokens!");
    console.log("💡 Users must request investor status first (23 -> 2)");
    return;
  }

  console.log("\n👥 USERS NEEDING TOKENS:");
  usersWithRequests.forEach((user, index) => {
    console.log(
      `${index + 1}. ${user.name} - ${user.investorRequest.requestedType} (Needs: ${user.investorRequest.lockRequired} VSC)`,
    );
    console.log(`   Current Balance: ${user.tokenBalance} VSC`);
  });

  const userChoice = await mod.promptUser(
    `\nSelect user (1-${usersWithRequests.length}): `,
  );
  const selectedUser = usersWithRequests[parseInt(userChoice) - 1];

  if (!selectedUser) {
    console.log("❌ Invalid selection");
    return;
  }

  const transferAmount = selectedUser.investorRequest.lockRequired.replace(
    /,/g,
    "",
  );

  try {
    console.log(`\n💸 Transferring ${transferAmount} VSC tokens...`);
    console.log(
      `   From: Central Bank (${centralBank.address.substring(0, 10)}...)`,
    );
    console.log(
      `   To: ${selectedUser.name} (${selectedUser.address.substring(0, 10)}...)`,
    );

    // Transfer tokens on-chain
    const tx = await digitalToken
      .connect(centralBank.signer)
      .transfer(selectedUser.address, ethers.parseEther(transferAmount));
    const receipt = await tx.wait();

    // Update balances
    const newBalance = await digitalToken.balanceOf(selectedUser.address);
    selectedUser.tokenBalance = Number(ethers.formatEther(newBalance));
    selectedUser.investorRequest.tokensReceived = true;

    console.log(`\n✅ TOKENS TRANSFERRED SUCCESSFULLY!`);
    console.log("=".repeat(60));
    console.log(`💰 Amount Transferred: ${transferAmount} VSC`);
    console.log(`👤 Recipient: ${selectedUser.name}`);
    console.log(`📊 New Balance: ${selectedUser.tokenBalance} VSC`);
    console.log(`⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
    console.log(`📝 Transaction Hash: ${receipt.hash}`);
    console.log("");
    console.log("🎯 NEXT STEPS:");
    console.log("   1. Bank creates multi-sig wallet (23 -> 4)");
    console.log("   2. User locks tokens (23 -> 5)");
    console.log("   3. Bank approves request (23 -> 6)");
  } catch (error) {
    console.error("❌ Token transfer failed:", error.message);
    if (error.message.includes("insufficient balance")) {
      console.log("💡 Central Bank needs to mint tokens first (Option 25)");
    }
  }
}

/**
 * Option 23 -> 4: the bank (ops) creates the user's 2-of-2 MultiSigWallet
 * through InvestorRequestManager (Task 4.3); the address is read back.
 * @private
 */
async function createMultiSigWalletForInvestor(mod) {
  console.log("\n🔐 CREATE MULTI-SIG WALLET (BANK)");
  console.log("=".repeat(60));
  console.log("Phase 2: Multi-Sig Wallet Creation");
  console.log("");

  const selectedUser = await mod._pickInvestor(
    (u) =>
      u.investorRequest &&
      u.investorRequest.status === "PENDING" &&
      !u.multiSigWallet,
    "USERS WITH PENDING REQUESTS",
    "💡 Users must request investor status first (23 -> 2)",
  );
  if (!selectedUser) return;

  try {
    console.log(`\n🔐 Creating 2-of-2 Multi-Sig Wallet...`);
    await Custody.createWallet(mod.state, selectedUser);
    console.log(`\n✅ MULTI-SIG WALLET CREATED!`);
    console.log("🎯 NEXT STEP: User locks tokens (23 -> 5)");
  } catch (error) {
    displayError(`Wallet creation failed: ${error.message}`);
  }
}

/**
 * Pick a tracked investor matching `filter`; null (reason printed) when
 * there is none or the choice is invalid.
 * @private
 */
async function _pickInvestor(mod, filter, title, hint) {
  const users = mod.state.investors
    ? Array.from(mod.state.investors.values()).filter(filter)
    : [];
  if (users.length === 0) {
    console.log(`❌ No users found for this step!`);
    console.log(hint);
    return null;
  }
  console.log(`\n👥 ${title}:`);
  users.forEach((u, i) => {
    const r = u.investorRequest;
    console.log(
      `${i + 1}. ${u.name} - ${r ? r.requestedType : u.type}${r ? ` (Lock: ${r.lockRequired} VSC)` : ""}`,
    );
  });
  const choice = await mod.promptUser(`\nSelect user (1-${users.length}): `);
  const picked = users[parseInt(choice) - 1];
  if (!picked) console.log("❌ Invalid selection");
  return picked || null;
}

/**
 * Option 23 -> 5: the user approves the wallet and locks the required
 * amount; the tokens move into the MultiSigWallet (Task 4.3, D13 b).
 * @private
 */
async function lockTokensInMultiSig(mod) {
  console.log("\n💰 LOCK TOKENS IN MULTI-SIG WALLET");
  console.log("=".repeat(60));
  console.log("Phase 2: Token Locking (the tokens move into the wallet)");
  console.log("");

  const selectedUser = await mod._pickInvestor(
    (u) => u.multiSigWallet && u.multiSigWallet.tokensLocked === 0,
    "USERS READY TO LOCK TOKENS",
    "💡 Bank must create multi-sig wallet first (23 -> 4)",
  );
  if (!selectedUser) return;

  try {
    await Custody.lock(mod.state, selectedUser);
  } catch (error) {
    displayError(`Lock failed: ${error.message}`);
    return;
  }
  console.log(`\n✅ TOKENS LOCKED IN THE MULTI-SIG WALLET`);
  console.log(`   🔐 Wallet: ${selectedUser.multiSigWallet.address}`);
  console.log(
    `   👥 Unlock needs BOTH: bank ${selectedUser.multiSigWallet.bank}`,
  );
  console.log(
    `                        user ${selectedUser.multiSigWallet.user}`,
  );
  console.log(`🎯 NEXT STEP: Bank approves request (23 -> 6)`);
}

/**
 * Option 23 -> 6: the bank approves through InvestorRequestManager,
 * which checks the lock is still held and assigns the type.
 * @private
 */
async function approveInvestorRequest(mod) {
  console.log("\n✅ APPROVE INVESTOR REQUEST (BANK)");
  console.log("=".repeat(60));
  console.log("Phase 2: Request Approval");
  console.log("");

  const selectedUser = await mod._pickInvestor(
    (u) =>
      u.investorRequest &&
      u.investorRequest.tokensLocked &&
      u.investorRequest.status === "PENDING",
    "REQUESTS READY FOR APPROVAL",
    "💡 Users must lock tokens first (23 -> 5)",
  );
  if (!selectedUser) return;

  try {
    await Custody.approve(mod.state, selectedUser);
    selectedUser.type = selectedUser.investorRequest.requestedType;
    selectedUser.investorRequest.status = "APPROVED";
    selectedUser.investorRequest.approvedAt = new Date().toISOString();
    console.log(`\n✅ INVESTOR REQUEST APPROVED!`);
    console.log(`👤 User: ${selectedUser.name}`);
    console.log(`📋 New Type: ${selectedUser.type}`);
    console.log(`🔐 Multi-Sig Wallet: ${selectedUser.multiSigWallet.address}`);
  } catch (error) {
    console.error("❌ Approval failed:", error.message);
  }
}

/**
 * Option 23 -> 8: the user proposes and signs, the bank signs: the
 * MultiSigWallet pays everything it holds back to the user (2-of-2,
 * never a bare unfreeze); then the type returns to Normal.
 * @private
 */
async function downgradeToNormalUser(mod) {
  console.log("\n🔓 DOWNGRADE TO NORMAL USER");
  console.log("=".repeat(60));
  console.log("Phase 4: Downgrade Process (2-of-2 on-chain unlock)");
  console.log("");

  const selectedUser = await mod._pickInvestor(
    (u) => u.type !== "NORMAL" && u.type !== "NORMAL_USER" && u.multiSigWallet,
    "ACTIVE INVESTORS",
    "💡 Create and approve investors first (Options 1-6)",
  );
  if (!selectedUser) return;

  try {
    const { released } = await Custody.downgrade(mod.state, selectedUser);
    selectedUser.type = "NORMAL";
    selectedUser.investorRequest = null;
    console.log(`\n✅ DOWNGRADE COMPLETE!`);
    console.log(`👤 User: ${selectedUser.name}`);
    console.log(
      `💰 Released by bank + user: ${ethers.formatEther(released)} VSC`,
    );
    console.log("✅ User can request investor status again (23 -> 2)");
  } catch (error) {
    // A Normal-type holding cap the released balance would exceed is a
    // chain rule refusing, not a demo failure.
    if (/Holding limit exceeded/.test(error.message)) {
      console.log("⛔ Downgrade refused (expected, chain rule): Holding limit");
      console.log("   exceeded: as Normal the user could not hold the release");
    } else console.error("❌ Downgrade failed:", error.message);
  }
}

/**
 * View all investor requests
 * @private
 */
async function viewInvestorRequests(mod) {
  console.log("\n📊 VIEW ALL INVESTOR REQUESTS");
  console.log("=".repeat(60));

  if (!mod.state.investors || mod.state.investors.size === 0) {
    console.log("\n❌ No investors found!");
    console.log(
      "💡 Create normal users and request investor status (Options 1-2)",
    );
    return;
  }

  const usersWithRequests = Array.from(mod.state.investors.values()).filter(
    (u) => u.investorRequest,
  );

  if (usersWithRequests.length === 0) {
    console.log("\n❌ No investor requests found!");
    console.log(
      "💡 Create normal users and request investor status (Options 1-2)",
    );
    return;
  }

  console.log(`\n📊 Total Requests: ${usersWithRequests.length}`);
  console.log("");

  usersWithRequests.forEach((user, index) => {
    const req = user.investorRequest;
    console.log(`${index + 1}. ${user.name}`);
    console.log(`   Address: ${user.address.substring(0, 10)}...`);
    console.log(`   Requested Type: ${req.requestedType}`);
    console.log(`   Lock Required: ${req.lockRequired} VSC`);
    console.log(`   Status: ${req.status}`);
    console.log(
      `   Multi-Sig Wallet: ${user.multiSigWallet ? user.multiSigWallet.address.substring(0, 10) + "..." : "Not Created"}`,
    );
    console.log(`   Tokens Locked: ${req.tokensLocked ? "YES" : "NO"}`);
    console.log(`   Created: ${new Date(req.createdAt).toLocaleString()}`);
    if (req.approvedAt) {
      console.log(`   Approved: ${new Date(req.approvedAt).toLocaleString()}`);
    }
    console.log("");
  });

  const pending = usersWithRequests.filter(
    (u) => u.investorRequest.status === "PENDING",
  ).length;
  const approved = usersWithRequests.filter(
    (u) => u.investorRequest.status === "APPROVED",
  ).length;

  console.log("📊 SUMMARY:");
  console.log(`   Pending: ${pending}`);
  console.log(`   Approved: ${approved}`);
}

/**
 * View all investors and users
 * @private
 */
async function viewAllInvestors(mod) {
  console.log("\n👥 ALL INVESTORS OVERVIEW");
  console.log("-".repeat(40));

  // Combine investors and normal users
  const allUsers = new Map();

  // Add investors from this.state.investors (if exists)
  if (mod.state.investors && mod.state.investors.size > 0) {
    for (const [id, user] of mod.state.investors) {
      allUsers.set(id, user);
    }
  }

  // Add normal users from this.state.normalUsers (if exists)
  if (mod.state.normalUsers && mod.state.normalUsers.size > 0) {
    for (const [id, user] of mod.state.normalUsers) {
      allUsers.set(id, user);
    }
  }

  if (allUsers.size === 0) {
    console.log("\n📊 NO USERS CREATED YET");
    console.log("💡 Create users using:");
    console.log("   - Option 23 → 1: Normal User (Investor Onboarding)");
    console.log("   - Option 24 → 1: Normal User (Direct Creation)");
    console.log("   - Option 23 → 2: Request Investor Status");
    return;
  }

  // Count investors by compliance status and type
  let compliantCount = 0;
  let nonCompliantCount = 0;
  let partialCount = 0;
  let actualInvestorCount = 0;
  let normalUserCount = 0;

  console.log("\n📋 DETAILED USER LIST:");
  let index = 1;
  for (const [id, investor] of allUsers) {
    // Get actual on-chain balance
    let balance = 0;
    const investorAddress = investor.user || investor.address;

    const digitalToken = mod.state.getContract("digitalToken");
    if (digitalToken && investorAddress) {
      try {
        const onchainBalance = await digitalToken.balanceOf(investorAddress);
        balance = parseFloat(ethers.formatEther(onchainBalance));
      } catch (error) {
        balance = investor.tokenBalance || 0;
      }
    } else {
      balance = investor.tokenBalance || 0;
    }

    console.log(`\n${index}. ${investor.name}`);
    console.log(`   🆔 ID: ${id}`);
    console.log(`   📋 Type: ${investor.type}`);
    console.log(
      `   🎯 KYC: ${investor.kycStatus} ${investor.kycStatus === "ISSUED" ? "✅" : "❌"}`,
    );
    console.log(
      `   🔍 AML: ${investor.amlStatus} ${investor.amlStatus === "ISSUED" ? "✅" : investor.amlStatus === "PENDING" ? "⚠️" : "❌"}`,
    );
    console.log(
      `   💰 Token Eligible: ${investor.tokenEligible ? "YES ✅" : "NO ❌"}`,
    );
    console.log(`   💳 Balance: ${balance.toLocaleString()} VSC`);
    console.log(
      `   📅 Created: ${new Date(investor.createdAt).toLocaleString()}`,
    );

    if (investor.rejectionReason) {
      console.log(`   📝 Rejection: ${investor.rejectionReason}`);
    }

    // Count by user type
    if (investor.type !== "NORMAL" && investor.type !== "NORMAL_USER") {
      actualInvestorCount++;

      // Count by status
      if (investor.complianceStatus === "COMPLIANT") {
        compliantCount++;
      } else if (investor.complianceStatus === "NON_COMPLIANT") {
        nonCompliantCount++;
      } else if (investor.complianceStatus === "PARTIAL") {
        partialCount++;
      }
    } else {
      normalUserCount++;

      // Count normal users by compliance
      if (investor.complianceStatus === "COMPLIANT" || investor.tokenEligible) {
        compliantCount++;
      } else {
        nonCompliantCount++;
      }
    }

    index++;
  }

  console.log("\n📊 USER SUMMARY:");
  console.log(`   Total Users: ${allUsers.size}`);
  console.log(
    `   Active Investors: ${actualInvestorCount} (RETAIL/ACCREDITED/INSTITUTIONAL)`,
  );
  console.log(`   Normal Users: ${normalUserCount}`);
  console.log(`   ✅ Compliant: ${compliantCount}`);
  console.log(`   ❌ Non-Compliant: ${nonCompliantCount}`);
  console.log(`   ⚠️  Partial: ${partialCount}`);
  console.log("\n💡 Only compliant users can participate in token operations");
}

/**
 * Display signer allocation status
 * @private
 */
function displaySignerAllocation(mod) {
  mod.signerManager.displaySignerAllocation();
}

module.exports = {
  bankTransfersTokensToUser,
  createMultiSigWalletForInvestor,
  _pickInvestor,
  lockTokensInMultiSig,
  approveInvestorRequest,
  downgradeToNormalUser,
  viewInvestorRequests,
  viewAllInvestors,
  displaySignerAllocation,
};
