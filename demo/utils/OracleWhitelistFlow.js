/**
 * @fileoverview Oracle option 33: whitelist management
 * @module OracleWhitelistFlow
 * @description Adds, upgrades, removes, views and batch-lists whitelist entries.
 * Moved out of demo/modules/OracleModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

/** Option 33: Manage Oracle Whitelist */
async function manageWhitelist(mod) {
  console.log("\n📋 MANAGE ORACLE WHITELIST (ACCESS APPROVAL)");
  console.log("=".repeat(60));

  const whitelistOracle = mod.state.getContract("whitelistOracle");
  if (!whitelistOracle) {
    console.log("ℹ️  Please deploy Oracle Management System first (option 31)");
    return;
  }

  console.log("\n🎯 WHITELIST MANAGEMENT OPTIONS:");
  console.log("1. Add User to Whitelist (KYC Success)");
  console.log("2. Upgrade Whitelist Tier (AML Success)");
  console.log("3. Remove from Whitelist");
  console.log("4. View Whitelist Status");
  console.log("5. Batch Whitelist Operations");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select whitelist action (0-5): ");

  try {
    switch (choice) {
      case "1":
        await mod.addUserToWhitelist();
        break;
      case "2":
        await mod.upgradeWhitelistTier();
        break;
      case "3":
        await mod.removeFromWhitelist();
        break;
      case "4":
        await mod.viewWhitelistStatus();
        break;
      case "5":
        await mod.batchWhitelistOperations();
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Whitelist management failed:", error.message);
  }
}

async function addUserToWhitelist(mod) {
  console.log("\n✅ ADD USER TO WHITELIST");
  console.log("-".repeat(40));

  const whitelistOracle = mod.state.getContract("whitelistOracle");

  // Show available identities
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log(
      "ℹ️  No OnchainID identities found. Please create identities first (option 3)",
    );
    return;
  }

  console.log("🆔 Available Identities:");
  let index = 0;
  const identityArray = Array.from(mod.state.identities.values());
  const seenAddresses = new Set(); // Prevent duplicates
  const uniqueIdentities = [];

  for (const identity of identityArray) {
    // Skip if we've already seen this address
    if (seenAddresses.has(identity.owner)) {
      continue;
    }

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

  const tier = await mod.promptUser("Whitelist tier (1-5, 5=highest): ");
  const duration = await mod.promptUser("Duration in days (0=permanent): ");
  const reason = await mod.promptUser("Reason for whitelisting: ");

  const durationSeconds = parseInt(duration) * 24 * 60 * 60;

  const tx = await whitelistOracle.addToWhitelist(
    selectedIdentity.owner,
    parseInt(tier),
    durationSeconds,
    reason,
  );
  const receipt = await tx.wait();

  console.log("\n✅ USER ADDED TO WHITELIST!");
  console.log(`   👤 User: ${selectedIdentity.owner}`);
  console.log(`   🏆 Tier: ${tier}`);
  console.log(
    `   ⏰ Duration: ${duration === "0" ? "Permanent" : duration + " days"}`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function upgradeWhitelistTier(mod) {
  console.log("\n⬆️ UPGRADE WHITELIST TIER");
  console.log("-".repeat(40));

  const whitelistOracle = mod.state.getContract("whitelistOracle");

  // Show available identities
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log(
      "ℹ️  No OnchainID identities found. Please create identities first (option 3)",
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

    // Check if already whitelisted
    try {
      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        identity.owner,
      );
      // The contract returns: (isWhitelistedStatus, timestamp, expiryTime, tier, reason, attestingOracles)
      // Access via index [0] or named property 'isWhitelistedStatus'
      const isWhitelisted =
        whitelistInfo[0] || whitelistInfo.isWhitelistedStatus;

      if (isWhitelisted) {
        console.log(
          `   ${index}: ${identity.owner} (Current Tier: ${whitelistInfo.tier})`,
        );
        uniqueIdentities.push(identity);
        seenAddresses.add(identity.owner);
        index++;
      }
    } catch (error) {
      // Skip if not whitelisted or error occurred
    }
  }

  if (uniqueIdentities.length === 0) {
    console.log("ℹ️  No whitelisted users found to upgrade");
    return;
  }

  const identityIndex = await mod.promptUser(
    `Select identity (0-${uniqueIdentities.length - 1}): `,
  );
  const selectedIdentity = uniqueIdentities[parseInt(identityIndex)];

  if (!selectedIdentity) {
    console.log("❌ Invalid identity selection");
    return;
  }

  const currentInfo = await whitelistOracle.getWhitelistInfo(
    selectedIdentity.owner,
  );
  console.log(`\nCurrent tier: ${currentInfo.tier}`);

  const newTier = await mod.promptUser("New tier (1-5, 5=highest): ");
  const duration = await mod.promptUser("Duration in days (0=permanent): ");
  const reason = await mod.promptUser("Reason for upgrade: ");

  const durationSeconds = parseInt(duration) * 24 * 60 * 60;

  const tx = await whitelistOracle.addToWhitelist(
    selectedIdentity.owner,
    parseInt(newTier),
    durationSeconds,
    reason,
  );
  const receipt = await tx.wait();

  console.log("\n✅ WHITELIST TIER UPGRADED!");
  console.log(`   👤 User: ${selectedIdentity.owner}`);
  console.log(`   🏆 Old Tier: ${currentInfo.tier} → New Tier: ${newTier}`);
  console.log(
    `   ⏰ Duration: ${duration === "0" ? "Permanent" : duration + " days"}`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function removeFromWhitelist(mod) {
  console.log("\n➖ REMOVE FROM WHITELIST");
  console.log("-".repeat(40));

  const whitelistOracle = mod.state.getContract("whitelistOracle");

  // Show whitelisted identities
  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("ℹ️  No OnchainID identities found");
    return;
  }

  console.log("🆔 Whitelisted Users:");
  let index = 0;
  const whitelistedUsers = [];

  for (const identity of mod.state.identities.values()) {
    try {
      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        identity.owner,
      );
      const isWhitelisted =
        whitelistInfo[0] || whitelistInfo.isWhitelistedStatus;

      if (isWhitelisted) {
        console.log(
          `   ${index}: ${identity.owner} (Tier: ${whitelistInfo.tier})`,
        );
        whitelistedUsers.push(identity);
        index++;
      }
    } catch (error) {
      // Skip
    }
  }

  if (whitelistedUsers.length === 0) {
    console.log("ℹ️  No whitelisted users found");
    return;
  }

  const userIndex = await mod.promptUser(
    `Select user to remove (0-${whitelistedUsers.length - 1}): `,
  );
  const selectedUser = whitelistedUsers[parseInt(userIndex)];

  if (!selectedUser) {
    console.log("❌ Invalid selection");
    return;
  }

  const reason = await mod.promptUser("Reason for removal: ");

  const tx = await whitelistOracle.removeFromWhitelist(
    selectedUser.owner,
    reason,
  );
  const receipt = await tx.wait();

  console.log("\n✅ USER REMOVED FROM WHITELIST!");
  console.log(`   👤 User: ${selectedUser.owner}`);
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function viewWhitelistStatus(mod) {
  console.log("\n📊 VIEW WHITELIST STATUS");
  console.log("-".repeat(40));

  const whitelistOracle = mod.state.getContract("whitelistOracle");

  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("ℹ️  No identities to check");
    return;
  }

  console.log("📋 WHITELIST STATUS REPORT:\n");
  let whitelistedCount = 0;

  for (const identity of mod.state.identities.values()) {
    try {
      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        identity.owner,
      );
      const isWhitelisted =
        whitelistInfo[0] || whitelistInfo.isWhitelistedStatus;

      if (isWhitelisted) {
        whitelistedCount++;
        console.log(`✅ ${identity.owner}`);
        console.log(`   🏆 Tier: ${whitelistInfo.tier}`);
        console.log(`   📝 Reason: ${whitelistInfo.reason}`);
        console.log(
          `   ⏰ Added: ${new Date(Number(whitelistInfo.timestamp) * 1000).toLocaleString()}`,
        );
        console.log("");
      }
    } catch (error) {
      // Skip
    }
  }

  console.log(
    `📊 Total Whitelisted: ${whitelistedCount}/${mod.state.identities.size}`,
  );
}

async function batchWhitelistOperations(mod) {
  console.log("\n📦 BATCH WHITELIST OPERATIONS");
  console.log("-".repeat(40));

  const whitelistOracle = mod.state.getContract("whitelistOracle");

  if (!mod.state.identities || mod.state.identities.size === 0) {
    console.log("ℹ️  No identities available");
    return;
  }

  console.log("🆔 Available Identities:");
  const identityArray = Array.from(mod.state.identities.values());
  identityArray.forEach((identity, index) => {
    console.log(`   ${index}: ${identity.owner}`);
  });

  const indicesInput = await mod.promptUser(
    "Enter indices to whitelist (comma-separated, e.g., 0,1,2): ",
  );
  const indices = indicesInput.split(",").map((i) => parseInt(i.trim()));

  const selectedUsers = indices.map((i) => identityArray[i]).filter((u) => u);

  if (selectedUsers.length === 0) {
    console.log("❌ No valid users selected");
    return;
  }

  const tier = await mod.promptUser("Whitelist tier for all (1-5): ");
  const duration = await mod.promptUser("Duration in days (0=permanent): ");
  const reason = await mod.promptUser("Reason for batch whitelisting: ");

  const addresses = selectedUsers.map((u) => u.owner);
  const tiers = new Array(addresses.length).fill(parseInt(tier));
  const durationSeconds = parseInt(duration) * 24 * 60 * 60;

  const tx = await whitelistOracle.batchAddToWhitelist(
    addresses,
    tiers,
    durationSeconds,
    reason,
  );
  const receipt = await tx.wait();

  console.log("\n✅ BATCH WHITELIST COMPLETE!");
  console.log(`   👥 Users Added: ${addresses.length}`);
  console.log(`   🏆 Tier: ${tier}`);
  console.log(
    `   ⏰ Duration: ${duration === "0" ? "Permanent" : duration + " days"}`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
  console.log("\n📋 Whitelisted Users:");
  addresses.forEach((addr) => console.log(`   ✅ ${addr}`));
}

module.exports = {
  manageWhitelist,
  addUserToWhitelist,
  upgradeWhitelistTier,
  removeFromWhitelist,
  viewWhitelistStatus,
  batchWhitelistOperations,
};
