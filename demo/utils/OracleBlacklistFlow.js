/**
 * @fileoverview Oracle options 34 and 35: blacklist management, emergency actions
 * @module OracleBlacklistFlow
 * @description Adds, removes, views and re-rates blacklist entries; emergency blacklist.
 * Moved out of demo/modules/OracleModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

/** Option 34: Manage Oracle Blacklist */
async function manageBlacklist(mod) {
  console.log("\n🚫 MANAGE ORACLE BLACKLIST (ACCESS RESTRICTION)");
  console.log("=".repeat(60));

  const blacklistOracle = mod.state.getContract("blacklistOracle");
  if (!blacklistOracle) {
    console.log("❌ Please deploy Oracle Management System first (option 31)");
    return;
  }

  console.log("\n🎯 BLACKLIST MANAGEMENT OPTIONS:");
  console.log("1. Add User to Blacklist (AML Failure)");
  console.log("2. Emergency Blacklist");
  console.log("3. Remove from Blacklist");
  console.log("4. View Blacklist Status");
  console.log("5. Update Blacklist Severity");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select blacklist action (0-5): ");

  try {
    switch (choice) {
      case "1":
        await mod.addUserToBlacklist();
        break;
      case "2":
        await mod.emergencyBlacklist();
        break;
      case "3":
        await mod.removeFromBlacklist();
        break;
      case "4":
        await mod.viewBlacklistStatus();
        break;
      case "5":
        await mod.updateBlacklistSeverity();
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Blacklist management failed:", error.message);
  }
}

async function addUserToBlacklist(mod) {
  console.log("\n🚫 ADD USER TO BLACKLIST");
  console.log("-".repeat(40));

  const blacklistOracle = mod.state.getContract("blacklistOracle");

  // Show available identities
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log(
      "❌ No OnchainID identities found. Please create identities first (option 3)",
    );
    return;
  }

  console.log("🆔 Available Identities:");
  let index = 0;
  const identityArray = Array.from(mod.state.identities.values());
  const seenAddresses = new Set();
  const uniqueIdentities = [];

  for (const identity of identityArray) {
    if (seenAddresses.has(identity.owner)) continue;

    console.log(
      `   ${index}: ${identity.owner} (OnchainID: ${identity.address})`,
    );
    uniqueIdentities.push(identity);
    seenAddresses.add(identity.owner);
    index++;
  }

  const identityIndex = await mod.promptUser(
    `Select identity (0-${uniqueIdentities.length - 1}): `,
  );
  const selectedIdentity = uniqueIdentities[parseInt(identityIndex)];

  if (!selectedIdentity) {
    console.log("❌ Invalid identity selection");
    return;
  }

  console.log("\n🚨 Severity Levels:");
  console.log("   0: LOW - Minor compliance issue");
  console.log("   1: MEDIUM - Moderate risk");
  console.log("   2: HIGH - Serious violation");
  console.log("   3: CRITICAL - Immediate threat");

  const severity = await mod.promptUser("Blacklist severity (0-3): ");
  const duration = await mod.promptUser("Duration in days (0=permanent): ");
  const reason = await mod.promptUser("Reason for blacklisting: ");

  const durationSeconds = parseInt(duration) * 24 * 60 * 60;

  const tx = await blacklistOracle.addToBlacklist(
    selectedIdentity.owner,
    parseInt(severity),
    durationSeconds,
    reason,
  );
  const receipt = await tx.wait();

  const severityNames = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  console.log("\n🚫 USER ADDED TO BLACKLIST!");
  console.log(`   👤 User: ${selectedIdentity.owner}`);
  console.log(
    `   🚨 Severity: ${severityNames[parseInt(severity)]} (${severity})`,
  );
  console.log(
    `   ⏰ Duration: ${duration === "0" ? "Permanent" : duration + " days"}`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function emergencyBlacklist(mod) {
  console.log("\n🚨 EMERGENCY BLACKLIST");
  console.log("-".repeat(40));
  console.log("💡 This is a shortcut to Option 35: Emergency Oracle Actions");
  console.log("⚠️  Redirecting to full emergency protocol...\n");
  await mod.emergencyActions();
}

async function removeFromBlacklist(mod) {
  console.log("\n✅ REMOVE FROM BLACKLIST");
  console.log("-".repeat(40));

  const blacklistOracle = mod.state.getContract("blacklistOracle");

  // Show blacklisted identities
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("❌ No OnchainID identities found");
    return;
  }

  console.log("🆔 Blacklisted Users:");
  let index = 0;
  const blacklistedUsers = [];

  for (const identity of mod.state.identities.values()) {
    try {
      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        identity.owner,
      );
      const isBlacklisted =
        blacklistInfo[0] || blacklistInfo.isBlacklistedStatus;

      if (isBlacklisted) {
        const severityNames = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
        console.log(
          `   ${index}: ${identity.owner} (Severity: ${severityNames[Number(blacklistInfo.severity)]})`,
        );
        blacklistedUsers.push(identity);
        index++;
      }
    } catch (error) {
      // Skip
    }
  }

  if (blacklistedUsers.length === 0) {
    console.log("❌ No blacklisted users found");
    return;
  }

  const userIndex = await mod.promptUser(
    `Select user to remove (0-${blacklistedUsers.length - 1}): `,
  );
  const selectedUser = blacklistedUsers[parseInt(userIndex)];

  if (!selectedUser) {
    console.log("❌ Invalid selection");
    return;
  }

  const reason = await mod.promptUser("Reason for removal: ");

  const tx = await blacklistOracle.removeFromBlacklist(
    selectedUser.owner,
    reason,
  );
  const receipt = await tx.wait();

  console.log("\n✅ USER REMOVED FROM BLACKLIST!");
  console.log(`   👤 User: ${selectedUser.owner}`);
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function viewBlacklistStatus(mod) {
  console.log("\n📊 VIEW BLACKLIST STATUS");
  console.log("-".repeat(40));

  const blacklistOracle = mod.state.getContract("blacklistOracle");

  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("❌ No identities to check");
    return;
  }

  console.log("📋 BLACKLIST STATUS REPORT:\n");
  let blacklistedCount = 0;
  const severityNames = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

  for (const identity of mod.state.identities.values()) {
    try {
      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        identity.owner,
      );
      const isBlacklisted =
        blacklistInfo[0] || blacklistInfo.isBlacklistedStatus;

      if (isBlacklisted) {
        blacklistedCount++;
        console.log(`🚫 ${identity.owner}`);
        console.log(
          `   🚨 Severity: ${severityNames[Number(blacklistInfo.severity)]}`,
        );
        console.log(`   📝 Reason: ${blacklistInfo.reason}`);
        console.log(
          `   ⏰ Added: ${new Date(Number(blacklistInfo.timestamp) * 1000).toLocaleString()}`,
        );
        console.log("");
      }
    } catch (error) {
      // Skip
    }
  }

  console.log(
    `📊 Total Blacklisted: ${blacklistedCount}/${mod.state.identities.size}`,
  );
}

async function updateBlacklistSeverity(mod) {
  console.log("\n⚠️ UPDATE BLACKLIST SEVERITY");
  console.log("-".repeat(40));

  const blacklistOracle = mod.state.getContract("blacklistOracle");

  // Show blacklisted identities
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("❌ No identities found");
    return;
  }

  console.log("🆔 Blacklisted Users:");
  let index = 0;
  const blacklistedUsers = [];
  const severityNames = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

  for (const identity of mod.state.identities.values()) {
    try {
      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        identity.owner,
      );
      const isBlacklisted =
        blacklistInfo[0] || blacklistInfo.isBlacklistedStatus;

      if (isBlacklisted) {
        console.log(
          `   ${index}: ${identity.owner} (Current: ${severityNames[Number(blacklistInfo.severity)]})`,
        );
        blacklistedUsers.push({
          identity,
          currentSeverity: Number(blacklistInfo.severity),
        });
        index++;
      }
    } catch (error) {
      // Skip
    }
  }

  if (blacklistedUsers.length === 0) {
    console.log("❌ No blacklisted users found");
    return;
  }

  const userIndex = await mod.promptUser(
    `Select user (0-${blacklistedUsers.length - 1}): `,
  );
  const selectedUser = blacklistedUsers[parseInt(userIndex)];

  if (!selectedUser) {
    console.log("❌ Invalid selection");
    return;
  }

  console.log(
    `\nCurrent severity: ${severityNames[selectedUser.currentSeverity]}`,
  );
  console.log("\n🚨 Severity Levels:");
  console.log("   0: LOW - Minor compliance issue");
  console.log("   1: MEDIUM - Moderate risk");
  console.log("   2: HIGH - Serious violation");
  console.log("   3: CRITICAL - Immediate threat");

  const newSeverity = await mod.promptUser("New severity (0-3): ");
  const reason = await mod.promptUser("Reason for severity update: ");

  // Remove and re-add with new severity
  await blacklistOracle.removeFromBlacklist(
    selectedUser.identity.owner,
    "Severity update",
  );
  const tx = await blacklistOracle.addToBlacklist(
    selectedUser.identity.owner,
    parseInt(newSeverity),
    0, // Permanent
    reason,
  );
  const receipt = await tx.wait();

  console.log("\n✅ BLACKLIST SEVERITY UPDATED!");
  console.log(`   👤 User: ${selectedUser.identity.owner}`);
  console.log(
    `   🚨 Old Severity: ${severityNames[selectedUser.currentSeverity]} → New: ${severityNames[parseInt(newSeverity)]}`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

/** Option 35: Emergency Oracle Actions */
async function emergencyActions(mod) {
  console.log("\n🚨 EMERGENCY ORACLE ACTIONS");
  console.log("=".repeat(50));

  const blacklistOracle = mod.state.getContract("blacklistOracle");
  if (!blacklistOracle) {
    console.log("❌ Please deploy Oracle Management System first (option 31)");
    return;
  }

  console.log("⚠️  EMERGENCY PROTOCOLS ACTIVATED");
  console.log(
    "This simulates critical security threats requiring immediate action",
  );
  console.log("");

  // Show available users
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("❌ No identities available for emergency action");
    return;
  }

  console.log("🆔 Available Users for Emergency Action:");
  let index = 0;
  const identityArray = Array.from(mod.state.identities.values());
  for (const identity of identityArray) {
    console.log(`   ${index}: ${identity.owner}`);
    index++;
  }

  const identityIndex = await mod.promptUser(
    `Select user for emergency blacklist (0-${identityArray.length - 1}): `,
  );
  const selectedIdentity = identityArray[parseInt(identityIndex)];

  if (!selectedIdentity) {
    console.log("❌ Invalid selection");
    return;
  }

  const reason = await mod.promptUser("Emergency reason: ");

  try {
    // Emergency oracle (Oracle 2 - AML Oracle) performs emergency blacklist;
    // OracleManager holds the designation (option 32 or 35a sets it).
    const emergencyOracle = mod.state.signers[2];
    const om = mod.state.getContract("oracleManager");
    if (!(await om.isEmergencyOracle(emergencyOracle.address))) {
      console.log(
        "❌ AML Oracle is not designated in OracleManager: run option 32 or 35a",
      );
      return;
    }

    console.log("🚨 Executing emergency blacklist...");
    const tx = await blacklistOracle
      .connect(emergencyOracle)
      .emergencyBlacklist(
        selectedIdentity.owner,
        3, // CRITICAL severity
        reason,
      );
    const receipt = await tx.wait();

    console.log("\n🚨 EMERGENCY BLACKLIST EXECUTED!");
    console.log(`   👤 User: ${selectedIdentity.owner}`);
    console.log(`   🚨 Severity: CRITICAL (3)`);
    console.log(`   👮 Emergency Oracle: ${emergencyOracle.address}`);
    console.log(`   📝 Reason: ${reason}`);
    console.log(`   🔗 Transaction: ${receipt.hash}`);
    console.log("   ⚡ Action: IMMEDIATE - No consensus required");
  } catch (error) {
    console.error("❌ Emergency action failed:", error.message);
  }
}

module.exports = {
  manageBlacklist,
  addUserToBlacklist,
  emergencyBlacklist,
  removeFromBlacklist,
  viewBlacklistStatus,
  updateBlacklistSeverity,
  emergencyActions,
};
