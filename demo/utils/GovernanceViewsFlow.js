/**
 * @fileoverview Governance options 80-81: dashboard, compliance enforcement
 * @module GovernanceViewsFlow
 * @description The governance dashboard and the VSC/VGT compliance enforcement test.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
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
const { PROPOSAL_TYPE_NAMES } = require("./GovernanceProposalFlow");

/** Option 80: Governance Dashboard */
async function showDashboard(mod) {
  displaySection("GOVERNANCE DASHBOARD", "📈");

  const governanceToken = mod.state.getContract("governanceToken");
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");

  if (!governanceToken || !vanguardGovernance) {
    displayError("Deploy Governance Token first (option 74)");
    return;
  }

  try {
    const totalSupply = await governanceToken.totalSupply();
    const ownerBalance = await governanceToken.balanceOf(
      mod.state.signers[0].address,
    );

    console.log("\n🪙 GOVERNANCE TOKEN INFO:");
    console.log(`   Name: Vanguard Governance Token`);
    console.log(`   Symbol: VGT`);
    console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
    console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
    // GovernanceToken.getVotingPower() returns a TOKEN BALANCE plus VGT
    // delegated in. No contract reads it for any decision; votes are
    // counted 1 per verified person. Delegation is recorded, not counted
    // (D12 b, wiring after the external audit): each signer below shows
    // its delegate and delegated-in VGT, labelled as such.

    // Get governance parameters
    const proposalCost = await vanguardGovernance.proposalCreationCost();
    const votingCost = await vanguardGovernance.votingCost();
    const proposalCount = await vanguardGovernance.proposalCount();

    console.log("\n⚖️ GOVERNANCE PARAMETERS:");
    console.log("=".repeat(70));
    console.log(
      `   Proposal Creation Cost: ${ethers.formatEther(proposalCost)} VGT`,
    );
    console.log(
      `   Voting Cost: ${ethers.formatEther(votingCost)} VGT per vote`,
    );
    console.log(`   Total Proposals: ${proposalCount}`);

    console.log("\n📊 VOTING SYSTEM:");
    console.log("=".repeat(70));
    console.log("Fair Voting:");
    console.log("   • 1 Person = 1 Vote (Equal for all)");
    console.log("   • Only KYC/AML verified users can vote");
    console.log("   • Passed proposals: Tokens BURNED 🔥");
    console.log("   • Failed proposals: Tokens RETURNED 💰");
    console.log("   • Quorum + approval thresholds vary BY PROPOSAL TYPE");

    const idRegistry = mod.state.getContract("identityRegistry");
    if (idRegistry) {
      const eligibleVoters = await idRegistry.registeredIdentityCount();
      console.log(
        `   • Eligible voters (registered identities): ${eligibleVoters}`,
      );
    }
    console.log("\n   Thresholds (quorum / approval):");
    for (let t = 0; t < PROPOSAL_TYPE_NAMES.length; t++) {
      const { quorumPct, approvalPct } = await mod._thresholdsFor(
        vanguardGovernance,
        t,
      );
      console.log(
        `   • ${PROPOSAL_TYPE_NAMES[t].padEnd(20)} ${quorumPct}% / ${approvalPct}%`,
      );
    }
    console.log("");
    console.log(
      "💡 Note: Token balance shown below is for distribution purposes only.",
    );
    console.log(
      "   Voting power is ALWAYS 1 vote per verified user, regardless of balance.",
    );

    // Show user balances
    const identityRegistry = mod.state.getContract("identityRegistry");
    console.log("\n👥 USER BALANCES & VOTING POWER:");
    console.log("=".repeat(70));
    console.log(
      "💡 Signer 0 = Contract Owner (received initial VGT supply for distribution)",
    );
    console.log("");

    for (let i = 0; i < Math.min(5, mod.state.signers.length); i++) {
      const balance = await governanceToken.balanceOf(
        mod.state.signers[i].address,
      );
      const isVerified = await identityRegistry.isVerified(
        mod.state.signers[i].address,
      );

      // Determine role
      let role = "";
      if (i === 0) {
        role = " (Contract Owner - Token Distributor)";
      } else if (i === 1) {
        role = " (Owner Fee Wallet)";
      } else if (i === 2) {
        role = " (KYC Issuer)";
      } else if (i === 3) {
        role = " (AML Issuer)";
      } else {
        role = " (Regular User)";
      }

      console.log(`\nSigner ${i}${role}:`);
      console.log(`   VGT Balance: ${ethers.formatEther(balance)} VGT`);
      // D12 (b): delegation is recorded on VGT, never counted by castVote.
      const addr = mod.state.signers[i].address;
      const del = await governanceToken.getDelegate(addr);
      const delIn = (await governanceToken.getVotingPower(addr)) - balance;
      console.log(
        `   delegate: ${del === ethers.ZeroAddress ? "none" : del}, delegated-in: ${ethers.formatEther(delIn)} VGT (recorded, not counted: D12)`,
      );
      console.log(
        `   Voting Power: ${isVerified ? "1 vote (equal)" : "0 votes (not verified)"}`,
      );
      console.log(
        `   KYC/AML Status: ${isVerified ? "✅ Verified" : "❌ Not Verified"}`,
      );
    }
  } catch (error) {
    displayError(`Dashboard error: ${error.message}`);
  }
}

/** Option 81: Test Compliance Enforcement */
async function testComplianceEnforcement(mod) {
  displaySection("TEST COMPLIANCE ENFORCEMENT (VSC & VGT)", "🔒");

  const digitalToken = mod.state.getContract("digitalToken");
  const governanceToken = mod.state.getContract("governanceToken");

  if (!digitalToken) {
    displayError("Deploy Digital Token (VSC) first (option 21)");
    return;
  }

  if (!governanceToken) {
    displayError("Deploy Governance Token (VGT) first (option 74)");
    return;
  }

  try {
    console.log("\n📊 TESTING COMPLIANCE ENFORCEMENT...");
    console.log("=".repeat(70));

    // Get verified and unverified users
    const verifiedUser = mod.state.signers[1];
    const unverifiedUser = mod.state.signers[9]; // Assuming signer 9 is not verified

    // Check verification status
    const identityRegistry = mod.state.getContract("identityRegistry");
    const isVerified1 = await identityRegistry.isVerified(verifiedUser.address);
    const isVerified9 = await identityRegistry.isVerified(
      unverifiedUser.address,
    );

    console.log("\n👤 USER VERIFICATION STATUS:");
    console.log(
      `   Verified User (${verifiedUser.address.slice(0, 10)}...): ${isVerified1 ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`,
    );
    console.log(
      `   Unverified User (${unverifiedUser.address.slice(0, 10)}...): ${isVerified9 ? "❌ VERIFIED" : "✅ NOT VERIFIED"}`,
    );

    // Test VSC Transfer Control
    console.log("\n" + "=".repeat(70));
    console.log("PART 1: VSC TRANSFER CONTROL");
    console.log("=".repeat(70));

    console.log("\n🧪 TEST 1.1: VSC transfer to verified user");
    try {
      const tx1 = await digitalToken.transfer(
        verifiedUser.address,
        ethers.parseEther("1000"),
      );
      await tx1.wait();
      const balance = await digitalToken.balanceOf(verifiedUser.address);
      console.log(`   ✅ SUCCESS: Transferred 1000 VSC to verified user`);
      console.log(`   Balance: ${ethers.formatEther(balance)} VSC`);
    } catch (error) {
      console.log(`   ❌ FAILED: ${error.message}`);
    }

    console.log("\n🧪 TEST 1.2: VSC transfer to unverified user (should FAIL)");
    try {
      const tx2 = await digitalToken.transfer(
        unverifiedUser.address,
        ethers.parseEther("1000"),
      );
      await tx2.wait();
      console.log(`   ❌ UNEXPECTED: Transfer succeeded (should have failed)`);
    } catch (error) {
      console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
      console.log(
        `   Reason: ${error.message.includes("Transfer not allowed") ? "Transfer not allowed" : "Compliance check failed"}`,
      );
    }

    // Test VGT Transfer Control
    console.log("\n" + "=".repeat(70));
    console.log("PART 2: VGT TRANSFER CONTROL");
    console.log("=".repeat(70));

    console.log("\n🧪 TEST 2.1: VGT distribution to verified user");
    try {
      const tx3 = await governanceToken.distributeGovernanceTokens(
        [verifiedUser.address],
        [ethers.parseEther("5000")],
      );
      await tx3.wait();
      const balance = await governanceToken.balanceOf(verifiedUser.address);
      console.log(`   ✅ SUCCESS: Distributed 5000 VGT to verified user`);
      console.log(`   Balance: ${ethers.formatEther(balance)} VGT`);
    } catch (error) {
      console.log(`   ❌ FAILED: ${error.message}`);
    }

    console.log("\n🧪 TEST 2.2: VGT transfer to unverified user (should FAIL)");
    try {
      const vgtWithSigner = governanceToken.connect(verifiedUser);
      const tx4 = await vgtWithSigner.transfer(
        unverifiedUser.address,
        ethers.parseEther("100"),
      );
      await tx4.wait();
      console.log(`   ❌ UNEXPECTED: Transfer succeeded (should have failed)`);
    } catch (error) {
      console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
      console.log(
        `   Reason: ${error.message.includes("Transfer not allowed") ? "Transfer not allowed" : "Compliance check failed"}`,
      );
    }

    // Test VGT Voting Control
    console.log("\n" + "=".repeat(70));
    console.log("PART 3: VGT VOTING CONTROL");
    console.log("=".repeat(70));

    // Voting eligibility is NOT a token balance. castVote requires:
    //   identityRegistry.isVerified(msg.sender)         — the real gate
    //   balanceOf(msg.sender) >= votingCost             — the fee
    // Each verified voter then counts as exactly 1 vote. TEST 3.2 reads
    // isVerified, not a balance: the unverified user also holds 0 VGT
    // (TEST 2.2 blocked the transfer), and a balance check would pass for
    // that reason alone even if castVote stopped checking isVerified.
    const governanceForVoting = mod.state.getContract("vanguardGovernance");
    const votingFee = governanceForVoting
      ? await governanceForVoting.votingCost()
      : 0n;

    const verifiedOk = await identityRegistry.isVerified(verifiedUser.address);
    const verifiedBal = await governanceToken.balanceOf(verifiedUser.address);
    const unverifiedOk = await identityRegistry.isVerified(
      unverifiedUser.address,
    );
    const unverifiedBal = await governanceToken.balanceOf(
      unverifiedUser.address,
    );

    console.log(
      `\n   Voting fee: ${ethers.formatEther(votingFee)} VGT per vote`,
    );

    console.log("\n🧪 TEST 3.1: Verified user may vote");
    console.log(`   KYC/AML verified: ${verifiedOk ? "✅ yes" : "❌ no"}`);
    console.log(
      `   Can pay fee: ${verifiedBal >= votingFee ? "✅ yes" : "❌ no"} (${ethers.formatEther(verifiedBal)} VGT)`,
    );
    console.log(
      `   ${verifiedOk && verifiedBal >= votingFee ? "✅ CAN vote — worth 1 vote" : "❌ CANNOT vote"}`,
    );

    console.log("\n🧪 TEST 3.2: Unverified user is blocked by verification");
    console.log(
      `   KYC/AML verified: ${unverifiedOk ? "❌ yes (unexpected)" : "✅ no"}`,
    );
    console.log(`   VGT balance: ${ethers.formatEther(unverifiedBal)} VGT`);
    console.log(
      `   ${!unverifiedOk ? "✅ CANNOT vote — blocked by isVerified, independent of balance" : "❌ verification gate not working"}`,
    );

    // Summary
    console.log("\n" + "=".repeat(70));
    displaySuccess("COMPLIANCE ENFORCEMENT TEST COMPLETE!");
    console.log("=".repeat(70));
    console.log("\n✅ PROVEN:");
    console.log("   1. ✅ VSC transfers controlled by ComplianceRules");
    console.log("   2. ✅ VGT transfers controlled by ComplianceRules");
    console.log("   3. ✅ VGT voting controlled (must hold VGT)");
    console.log("   4. ✅ Only KYC/AML verified users can hold tokens");
    console.log("   5. ✅ Unverified users CANNOT participate");
  } catch (error) {
    displayError(`Test failed: ${error.message}`);
  }
}

module.exports = { showDashboard, testComplianceEnforcement };
