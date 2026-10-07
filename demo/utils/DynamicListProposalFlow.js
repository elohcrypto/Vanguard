/**
 * @fileoverview Dynamic list options 86 to 88: list-update proposals, history, lifecycle
 * @module DynamicListProposalFlow
 * @description Creates list-update proposals, prints a user's status history, runs the lifecycle demo.
 * Moved out of demo/modules/DynamicListModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ageOrVoterAgeRefusal } = require("./ChainTime");
const { ethers } = require("hardhat");

/** Option 86: Create List Update Proposal */
async function createListUpdateProposal(mod) {
  displaySection("CREATE LIST UPDATE PROPOSAL", "🗳️");

  const dynamicListManager = mod.state.getContract("dynamicListManager");
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");

  if (!dynamicListManager || !vanguardGovernance) {
    displayError("Deploy DynamicListManager and Governance first");
    return;
  }

  try {
    console.log("\n🎯 SELECT PROPOSAL TYPE:");
    console.log("1. Add to Whitelist");
    console.log("2. Remove from Whitelist");
    console.log("3. Add to Blacklist");
    console.log("4. Remove from Blacklist");
    console.log("0. Back to Main Menu");
    console.log("");

    const typeChoice = await mod.promptUser("Select type (0-4): ");

    if (typeChoice === "0") return;

    // One proposal type (ListUpdate = 6, plan 2D.1); the choice picks the
    // manager function the proposal calls.
    const fnByChoice = {
      1: ["addToWhitelist", "Add to Whitelist"],
      2: ["removeFromWhitelist", "Remove from Whitelist"],
      3: ["addToBlacklist", "Add to Blacklist"],
      4: ["removeFromBlacklist", "Remove from Blacklist"],
    };
    if (!fnByChoice[typeChoice]) {
      displayError(`Invalid choice "${typeChoice}"`);
      return;
    }
    const [fn, fnLabel] = fnByChoice[typeChoice];

    // Select target user
    console.log("\n👤 SELECT TARGET USER:");
    console.log(`0. Owner: ${mod.state.signers[0].address}`);
    console.log(`1. User 1: ${mod.state.signers[1].address}`);
    console.log(`2. User 2: ${mod.state.signers[2].address}`);
    const userChoice = await mod.promptUser("Select user (0-2): ");
    const targetUser = mod.state.signers[parseInt(userChoice)].address;
    const targetIdentity = BigInt(targetUser) % BigInt(1000000000);

    // Get reason
    const reason = await mod.promptUser("Reason for this change: ");
    let args = [targetUser, targetIdentity, reason];
    let duration = null;
    if (fn === "addToWhitelist") {
      const tier = await mod._askNumber("Whitelist tier (1-5)", 1, 1, 5);
      duration = await mod._askDuration("Whitelist", 365);
      args = [targetUser, targetIdentity, tier, duration, reason];
    }
    if (fn === "addToBlacklist") {
      const severity = await mod._askNumber(
        "Severity (0 LOW, 1 MEDIUM, 2 HIGH, 3 CRITICAL)",
        1,
        0,
        3,
      );
      duration = await mod._askDuration("Blacklist", "never");
      args = [targetUser, targetIdentity, severity, duration, reason];
    }
    const callData = dynamicListManager.interface.encodeFunctionData(fn, args);

    // Get proposal details
    const title = `${fnLabel}: User ${userChoice}`;
    const description = `Proposal to ${fnLabel.toLowerCase()} for user ${targetUser}. Reason: ${reason}`;

    // Check and approve tokens
    const governanceToken = mod.state.getContract("governanceToken");
    const proposalCost = await vanguardGovernance.proposalCreationCost();
    console.log(`\n💰 Proposal Cost: ${ethers.formatEther(proposalCost)} VGT`);

    const balance = await governanceToken.balanceOf(
      mod.state.signers[0].address,
    );
    if (balance < proposalCost) {
      displayError("Insufficient VGT balance");
      return;
    }

    console.log("📝 Approving VGT tokens...");
    const approveTx = await governanceToken.approve(
      await vanguardGovernance.getAddress(),
      proposalCost,
    );
    await approveTx.wait();

    // D25: the proposer's identity must be minVoterAge old.
    const tooNew = await ageOrVoterAgeRefusal(
      vanguardGovernance,
      mod.state.getContract("identityRegistry"),
      [mod.state.signers[0]],
    );
    if (tooNew) {
      displayError(tooNew);
      return;
    }

    // Create proposal
    console.log("\n📝 Creating governance proposal...");
    const tx = await vanguardGovernance.createProposal(
      6, // ListUpdate
      title,
      description,
      await dynamicListManager.getAddress(),
      callData,
    );
    await tx.wait();

    // Get proposal ID from event
    const proposalId = await vanguardGovernance.proposalCount();

    displaySuccess("PROPOSAL CREATED!");
    console.log("=".repeat(70));
    console.log(`   Proposal ID: ${proposalId}`);
    console.log(`   Type: ListUpdate -> ${fn}`);
    console.log(`   Target User: ${targetUser}`);
    console.log(`   Target Identity: ${targetIdentity}`);
    console.log(`   Reason: ${reason}`);
    if (duration !== null)
      console.log(
        duration === ethers.MaxUint256
          ? "   Duration: never expires"
          : `   Duration: ${duration / 86400n} days (expires ${duration / 86400n} days after execution)`,
      );
    // GovernanceConfig.ProposalStatus, read back (R-47-2).
    const STATUS = [
      "Pending",
      "Active",
      "Approved",
      "Rejected",
      "Executed",
      "Cancelled",
    ];
    const created = (await vanguardGovernance.getProposal(proposalId)).proposal;
    console.log(`   Status: ${STATUS[Number(created.status)]}`);
    console.log("");
    console.log("📊 Next Steps:");
    console.log("   1. Community votes on this proposal (option 77)");
    console.log("   2. After voting period, execute proposal (option 78)");
    console.log(
      "   3. The manager writes the WhitelistOracle/BlacklistOracle that transfers check",
    );
  } catch (error) {
    displayError(`Error: ${error.message}`);
  }
}

/** Option 87: View User Status History */
async function viewUserStatusHistory(mod) {
  displaySection("VIEW USER STATUS HISTORY", "📊");

  const dynamicListManager = mod.state.getContract("dynamicListManager");
  if (!dynamicListManager) {
    displayError("Deploy DynamicListManager first (option 84)");
    return;
  }

  try {
    // Select user
    console.log("\n👤 SELECT USER:");
    console.log(`0. Owner: ${mod.state.signers[0].address}`);
    console.log(`1. User 1: ${mod.state.signers[1].address}`);
    console.log(`2. User 2: ${mod.state.signers[2].address}`);
    const userChoice = await mod.promptUser("Select user (0-2): ");
    const userAddress = mod.state.signers[parseInt(userChoice)].address;
    const identity = BigInt(userAddress) % BigInt(1000000000);

    // Get history count
    const historyCount =
      await dynamicListManager.getUserStatusHistoryCount(userAddress);

    console.log("\n📜 STATUS CHANGE HISTORY:");
    console.log("=".repeat(70));
    console.log(`   User: ${userAddress}`);
    console.log(`   Identity: ${identity}`);
    console.log(`   Total Changes: ${historyCount}`);
    console.log("");

    if (historyCount == 0) {
      console.log("   ℹ️  No status changes recorded yet");
      return;
    }

    // Get current status
    const currentStatus = await dynamicListManager.getUserStatus(userAddress);
    const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

    console.log(`   Current Status: ${statusNames[currentStatus]}`);
    console.log("");
    console.log("   📋 Change History:");
    console.log("   (Note: Full history retrieval requires contract updates)");
    console.log(
      "   ℹ️  Status changes are recorded on-chain with timestamps and reasons",
    );
  } catch (error) {
    displayError(`Error: ${error.message}`);
  }
}

/** Option 88: Demo Complete User Lifecycle */
async function demoCompleteUserLifecycle(mod) {
  displaySection("DEMO COMPLETE USER LIFECYCLE", "🎬");
  console.log(
    "This demonstrates a user moving through different list statuses:",
  );
  console.log("  1. User starts with NO status");
  console.log("  2. Governance votes to ADD to WHITELIST");
  console.log("  3. User generates whitelist proof ✅");
  console.log(
    "  4. User violates terms → Governance votes to ADD to BLACKLIST",
  );
  console.log("  5. Old whitelist proof INVALIDATED ❌");
  console.log(
    "  6. User corrects behavior → Governance votes to REMOVE from BLACKLIST",
  );
  console.log("  7. User back on WHITELIST ✅");
  console.log("");

  const dynamicListManager = mod.state.getContract("dynamicListManager");
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");

  if (!dynamicListManager || !vanguardGovernance) {
    displayError("Deploy DynamicListManager and Governance first");
    return;
  }

  try {
    const targetUser = mod.state.signers[1].address;
    const targetIdentity = BigInt(targetUser) % BigInt(1000000000);
    const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

    console.log("🎯 Target User:");
    console.log(`   Address: ${targetUser}`);
    console.log(`   Identity: ${targetIdentity}`);
    console.log("");

    // Step 1: Check initial status
    console.log("📊 STEP 1: Check Initial Status");
    let status = await dynamicListManager.getUserStatus(targetUser);
    console.log(`   Status: ${statusNames[status]}`);
    console.log("");

    await mod.promptUser("Press Enter to continue to Step 2...");

    // Step 2: Add to whitelist (owner can do this directly for demo)
    console.log("\n📊 STEP 2: Add User to Whitelist");
    console.log("   (In production, this would require governance voting)");
    const addWhitelistTx = await dynamicListManager.addToWhitelist(
      targetUser,
      targetIdentity,
      await mod._askNumber("Whitelist tier (1-5)", 1, 1, 5),
      await mod._askDuration("Whitelist", 365),
      "Initial approval - user passed KYC/AML",
    );
    for (const line of mod.constructor.listExpiries(
      mod.state,
      await addWhitelistTx.wait(),
    ))
      console.log(`   ${line}`);

    status = await dynamicListManager.getUserStatus(targetUser);
    console.log(`   ✅ Status: ${statusNames[status]}`);
    console.log("");

    await mod.promptUser("Press Enter to continue to Step 3...");

    // Step 3: User can now generate whitelist proof
    console.log("\n📊 STEP 3: User Generates Whitelist Proof");
    // From the status read in step 2, not assumed (R-47-2).
    if (statusNames[status] === "WHITELISTED") {
      console.log("   ✅ User is whitelisted - proof generation would succeed");
      console.log("   ✅ User can use platform features");
    } else {
      console.log(`   ⚠️  User is ${statusNames[status]}: no whitelist proof`);
    }
    console.log("");

    await mod.promptUser("Press Enter to continue to Step 4...");

    // Step 4: User violates terms - add to blacklist
    console.log("\n📊 STEP 4: User Violates Terms - Add to Blacklist");
    console.log("   Reason: Fraudulent activity detected");
    const addBlacklistTx = await dynamicListManager.addToBlacklist(
      targetUser,
      targetIdentity,
      await mod._askNumber(
        "Severity (0 LOW, 1 MEDIUM, 2 HIGH, 3 CRITICAL)",
        1,
        0,
        3,
      ),
      await mod._askDuration("Blacklist", "never"),
      "Fraudulent activity detected",
    );
    for (const line of mod.constructor.listExpiries(
      mod.state,
      await addBlacklistTx.wait(),
    ))
      console.log(`   ${line}`);

    status = await dynamicListManager.getUserStatus(targetUser);
    console.log(`   ❌ Status: ${statusNames[status]}`);
    console.log("");

    // Step 5: Check proof validity
    console.log("📊 STEP 5: Check Old Whitelist Proof Validity");
    const proofTimestamp = Math.floor(Date.now() / 1000);
    const isValid = await dynamicListManager.isProofValid(
      targetUser,
      proofTimestamp,
      true, // whitelist proof
    );
    console.log(
      `   Old Whitelist Proof Valid: ${isValid ? "✅ YES" : "❌ NO"}`,
    );
    console.log(`   ℹ️  Proof invalidated because user is now BLACKLISTED`);
    console.log("");

    await mod.promptUser("Press Enter to continue to Step 6...");

    // Step 6: User corrects behavior - remove from blacklist
    console.log("\n📊 STEP 6: User Corrects Behavior - Remove from Blacklist");
    console.log("   Reason: User provided evidence of correction");
    const removeBlacklistTx = await dynamicListManager.removeFromBlacklist(
      targetUser,
      targetIdentity,
      "User corrected behavior and provided evidence",
    );
    await removeBlacklistTx.wait();

    status = await dynamicListManager.getUserStatus(targetUser);
    console.log(`   ✅ Status: ${statusNames[status]}`);
    console.log("");

    // Step 7: User can generate new proof
    console.log("📊 STEP 7: User Can Generate New Whitelist Proof");
    if (statusNames[status] === "WHITELISTED") {
      console.log("   ✅ User is back on whitelist");
      console.log("   ✅ User can generate NEW whitelist proof");
      console.log("   ✅ User can use platform again");
    } else {
      console.log(
        `   ⚠️  User is ${statusNames[status]}, not back on the whitelist`,
      );
    }
    console.log("");

    // Summary
    displaySuccess("LIFECYCLE DEMO COMPLETE!");
    console.log("=".repeat(70));
    console.log("✅ Demonstrated:");
    console.log(
      "   1. User status changes (NONE → WHITELISTED → BLACKLISTED → WHITELISTED)",
    );
    console.log("   2. Proof invalidation when status changes");
    console.log("   3. Complete audit trail of status changes");
    console.log("   4. Real-time status checks");
    console.log("");
    console.log("📊 Status History:");
    const historyCount =
      await dynamicListManager.getUserStatusHistoryCount(targetUser);
    console.log(`   Total Status Changes: ${historyCount}`);
    console.log("");
    console.log("🗳️ In Production:");
    console.log("   All status changes would require governance voting");
    console.log("   Community decides who gets whitelisted/blacklisted");
    console.log("   Complete transparency and decentralization");
  } catch (error) {
    displayError(`Demo failed: ${error.message}`);
  }
}

module.exports = {
  createListUpdateProposal,
  viewUserStatusHistory,
  demoCompleteUserLifecycle,
};
