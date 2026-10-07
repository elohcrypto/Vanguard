/**
 * @fileoverview Oracle options 36 and 37: reputation, consensus operations
 * @module OracleReputationFlow
 * @description Rewards and penalises oracles, shows their stats, runs the consensus sub-menu.
 * Moved out of demo/modules/OracleModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const Consensus = require("./OracleConsensusOptions");

/** Option 36: Oracle Reputation Management */
async function manageReputation(mod) {
  console.log("\n📊 ORACLE REPUTATION MANAGEMENT");
  console.log("=".repeat(50));

  const oracleManager = mod.state.getContract("oracleManager");
  if (!oracleManager) {
    console.log("ℹ️  Please deploy Oracle Management System first (option 31)");
    return;
  }

  try {
    console.log("📊 Current Oracle Reputations:");

    // Check reputations for all registered oracles
    for (const [key, config] of mod.state.oracleConfig) {
      const oracleInfo = await oracleManager.getOracleInfo(config.address);
      console.log(`   ${key.toUpperCase()}: ${config.address}`);
      console.log(`     🏆 Reputation: ${oracleInfo.reputation}`);
      console.log(
        `     🏅 Rewards: ${oracleInfo.correctAttestations} (owner-granted)`,
      );
      console.log(`     🗳️ Answers: ${oracleInfo.totalAttestations}`);
      console.log(`     📊 Role: ${config.role}`);
      console.log("");
    }

    console.log("🎯 REPUTATION ACTIONS:");
    console.log("1. Reward Oracle (Good Performance)");
    console.log("2. Penalize Oracle (Poor Performance)");
    console.log("3. View Detailed Oracle Stats");
    console.log("0. Back to Main Menu");

    const choice = await mod.promptUser("Select action (0-3): ");

    switch (choice) {
      case "1":
        await mod.rewardOracle();
        break;
      case "2":
        await mod.penalizeOracle();
        break;
      case "3":
        await mod.viewDetailedOracleStats();
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Reputation management failed:", error.message);
  }
}

async function rewardOracle(mod) {
  console.log("\n🏆 REWARD ORACLE");
  console.log("-".repeat(40));

  const oracleManager = mod.state.getContract("oracleManager");

  if (!mod.state.oracleConfig || mod.state.oracleConfig.size === 0) {
    console.log("ℹ️  No oracles registered");
    return;
  }

  console.log("👥 Registered Oracles:");
  let index = 0;
  const oracleArray = [];

  for (const [key, config] of mod.state.oracleConfig) {
    try {
      const oracleInfo = await oracleManager.getOracleInfo(config.address);
      console.log(`   ${index}: ${key.toUpperCase()} - ${config.address}`);
      console.log(`      🏆 Current Reputation: ${oracleInfo.reputation}`);
      oracleArray.push({ key, config, info: oracleInfo });
      index++;
    } catch (error) {
      console.log(`   ${index}: ${key.toUpperCase()} - Error retrieving info`);
    }
  }

  const oracleIndex = await mod.promptUser(
    `Select oracle to reward (0-${oracleArray.length - 1}): `,
  );
  const selectedOracle = oracleArray[parseInt(oracleIndex)];

  if (!selectedOracle) {
    console.log("❌ Invalid selection");
    return;
  }

  const rewardAmount = await mod.promptUser(
    "Reward amount (reputation points): ",
  );
  const reason = await mod.promptUser("Reason for reward: ");

  const tx = await oracleManager.rewardOracle(
    selectedOracle.config.address,
    parseInt(rewardAmount),
    reason,
  );
  const receipt = await tx.wait();

  const updatedInfo = await oracleManager.getOracleInfo(
    selectedOracle.config.address,
  );

  console.log("\n🏆 ORACLE REWARDED!");
  console.log(`   👤 Oracle: ${selectedOracle.key.toUpperCase()}`);
  console.log(`   📍 Address: ${selectedOracle.config.address}`);
  console.log(
    `   ⬆️ Reputation: ${selectedOracle.info.reputation} → ${updatedInfo.reputation} (+${rewardAmount})`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function penalizeOracle(mod) {
  console.log("\n⚠️ PENALIZE ORACLE");
  console.log("-".repeat(40));

  const oracleManager = mod.state.getContract("oracleManager");

  if (!mod.state.oracleConfig || mod.state.oracleConfig.size === 0) {
    console.log("ℹ️  No oracles registered");
    return;
  }

  console.log("👥 Registered Oracles:");
  let index = 0;
  const oracleArray = [];

  for (const [key, config] of mod.state.oracleConfig) {
    try {
      const oracleInfo = await oracleManager.getOracleInfo(config.address);
      console.log(`   ${index}: ${key.toUpperCase()} - ${config.address}`);
      console.log(`      🏆 Current Reputation: ${oracleInfo.reputation}`);
      oracleArray.push({ key, config, info: oracleInfo });
      index++;
    } catch (error) {
      console.log(`   ${index}: ${key.toUpperCase()} - Error retrieving info`);
    }
  }

  const oracleIndex = await mod.promptUser(
    `Select oracle to penalize (0-${oracleArray.length - 1}): `,
  );
  const selectedOracle = oracleArray[parseInt(oracleIndex)];

  if (!selectedOracle) {
    console.log("❌ Invalid selection");
    return;
  }

  const penaltyAmount = await mod.promptUser(
    "Penalty amount (reputation points): ",
  );
  const reason = await mod.promptUser("Reason for penalty: ");

  const tx = await oracleManager.penalizeOracle(
    selectedOracle.config.address,
    parseInt(penaltyAmount),
    reason,
  );
  const receipt = await tx.wait();

  const updatedInfo = await oracleManager.getOracleInfo(
    selectedOracle.config.address,
  );

  console.log("\n⚠️ ORACLE PENALIZED!");
  console.log(`   👤 Oracle: ${selectedOracle.key.toUpperCase()}`);
  console.log(`   📍 Address: ${selectedOracle.config.address}`);
  console.log(
    `   ⬇️ Reputation: ${selectedOracle.info.reputation} → ${updatedInfo.reputation} (-${penaltyAmount})`,
  );
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   🔗 Transaction: ${receipt.hash}`);
}

async function viewDetailedOracleStats(mod) {
  console.log("\n📊 DETAILED ORACLE STATISTICS");
  console.log("-".repeat(40));

  const oracleManager = mod.state.getContract("oracleManager");

  if (!mod.state.oracleConfig || mod.state.oracleConfig.size === 0) {
    console.log("ℹ️  No oracles registered");
    return;
  }

  console.log("📈 COMPREHENSIVE ORACLE PERFORMANCE REPORT\n");

  for (const [key, config] of mod.state.oracleConfig) {
    try {
      const oracleInfo = await oracleManager.getOracleInfo(config.address);

      console.log(`${"=".repeat(50)}`);
      console.log(`🔷 ${key.toUpperCase()} ORACLE`);
      console.log(`${"=".repeat(50)}`);
      console.log(`📍 Address: ${config.address}`);
      console.log(`📊 Role: ${config.role}`);
      console.log(`🏆 Reputation: ${oracleInfo.reputation}/1000`);
      // correctAttestations counts the owner's rewardOracle calls only
      // (OracleManager.sol:431), not correct answers.
      console.log(
        `🏅 Rewards: ${oracleInfo.correctAttestations} (owner-granted)`,
      );
      console.log(`🗳️ Answers: ${oracleInfo.totalAttestations}`);
      console.log(
        `🔄 Active Status: ${oracleInfo.active ? "✅ ACTIVE" : "❌ INACTIVE"}`,
      );

      console.log("");
    } catch (error) {
      console.log(`❌ ${key.toUpperCase()}: Error retrieving detailed stats`);
      console.log("");
    }
  }

  console.log(`${"=".repeat(50)}`);
}

/** Option 37: Oracle Consensus Operations */
async function consensusOperations(mod) {
  console.log("\n🤝 ORACLE CONSENSUS OPERATIONS");
  console.log("=".repeat(50));

  const consensusOracle = mod.state.getContract("consensusOracle");
  if (!consensusOracle) {
    console.log("ℹ️  Please deploy Oracle Management System first (option 31)");
    return;
  }

  console.log("\n🎯 CONSENSUS OPERATIONS:");
  console.log("1. Raise a Query (OracleManager.submitQuery)");
  console.log("2. Node Answers (OracleManager.submitResponse)");
  console.log("3. Check Consensus Result (engine tally)");
  console.log("4. View Recent Queries");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("\nSelect action (0-4): ");

  try {
    switch (choice) {
      case "1":
        await mod.createConsensusQuery();
        break;
      case "2":
        await mod.submitOracleVote();
        break;
      case "3":
        await mod.checkConsensusResult();
        break;
      case "4":
        await mod.viewActiveQueries();
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Consensus operation failed:", error.message);
  }
}

// Option 37 sub-options: the real path (Task 4.4), OracleConsensusOptions.js.
async function createConsensusQuery(mod) {
  return Consensus.createQueryInteractive(mod.state, mod.promptUser);
}

async function submitOracleVote(mod) {
  return Consensus.voteInteractive(mod.state, mod.promptUser);
}

async function checkConsensusResult(mod) {
  return Consensus.resultInteractive(mod.state, mod.promptUser);
}

async function viewActiveQueries(mod) {
  return Consensus.listQueries(mod.state);
}

module.exports = {
  manageReputation,
  rewardOracle,
  penalizeOracle,
  viewDetailedOracleStats,
  consensusOperations,
  createConsensusQuery,
  submitOracleVote,
  checkConsensusResult,
  viewActiveQueries,
};
