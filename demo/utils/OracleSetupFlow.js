/**
 * @fileoverview Oracle options 31 and 32: deploy the oracle system, register oracles
 * @module OracleSetupFlow
 * @description Deploys the oracle layer and registers the demo oracles.
 * Moved out of demo/modules/OracleModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const Flow = require("./OracleLifecycleFlow");
const { governOracleManager } = require("./GovernedCalls");

/** Option 31: Deploy Oracle Management System */
async function deployOracleSystem(mod) {
  displaySection("DEPLOY ORACLE MANAGEMENT SYSTEM", "🏗️");

  try {
    // One oracle deploy path (Task 2A.1): ContractDeployer.deployOracleSystem
    // is the only implementation that binds the blacklist oracle into
    // ComplianceRules (see setBlacklistOracle there). This module used to
    // duplicate the whole deployment and never did that binding.
    await mod.deployer.deployOracleSystem();

    const oracleManager = mod.state.getContract("oracleManager");
    const whitelistOracle = mod.state.getContract("whitelistOracle");
    const blacklistOracle = mod.state.getContract("blacklistOracle");
    const consensusOracle = mod.state.getContract("consensusOracle");
    mod.state.oracleManager = oracleManager; // Alias
    mod.state.whitelistOracle = whitelistOracle; // Alias
    mod.state.blacklistOracle = blacklistOracle; // Alias
    mod.state.consensusOracle = consensusOracle; // Alias

    displaySuccess("ORACLE MANAGEMENT SYSTEM DEPLOYED SUCCESSFULLY!");
    console.log("📊 System Status:");
    console.log(`   🏛️ Oracle Manager: ${await oracleManager.getAddress()}`);
    console.log(
      `   📋 Whitelist Oracle: ${await whitelistOracle.getAddress()}`,
    );
    console.log(
      `   🚫 Blacklist Oracle: ${await blacklistOracle.getAddress()}`,
    );
    console.log(
      `   🤝 Consensus engine (ConsensusOracle): ${await consensusOracle.getAddress()}`,
    );
    console.log(
      `   👥 Registered Oracles: ${await oracleManager.getOracleCount()}`,
    );
    console.log(
      `   ⚖️ Consensus Threshold: ${await oracleManager.getConsensusThreshold()}% of the registered weight`,
    );
  } catch (error) {
    displayError(`Oracle system deployment failed: ${error.message}`);
  }
}

/** Option 32: Register & Configure Oracles */
async function registerOracles(mod) {
  console.log("\n👥 REGISTER & CONFIGURE ORACLES");
  console.log("=".repeat(50));

  const oracleManager = mod.state.getContract("oracleManager");
  if (!oracleManager) {
    console.log("ℹ️  Please deploy Oracle Management System first (option 31)");
    return;
  }

  try {
    console.log("\n🔧 ORACLE REGISTRATION & CONFIGURATION");
    console.log("-".repeat(40));

    // Check if oracles are already registered
    const totalOracles = await oracleManager.getOracleCount();
    console.log(`📊 Currently registered oracles: ${totalOracles}`);

    if (totalOracles >= 3) {
      console.log(
        "✅ Oracles already registered. Showing current configuration...",
      );

      // Display current oracle configuration
      for (const [key, config] of mod.state.oracleConfig) {
        const oracleInfo = await oracleManager.getOracleInfo(config.address);
        console.log(`\n${key.toUpperCase()} Oracle:`);
        console.log(`   📍 Address: ${config.address}`);
        console.log(`   🏆 Reputation: ${oracleInfo.reputation}`);
        console.log(
          `   ✅ Status: ${oracleInfo.active ? "ACTIVE" : "INACTIVE"}`,
        );
        console.log(`   📝 Role: ${config.role}`);
      }
    } else {
      console.log("\n🔄 Registering additional oracles...");

      // Register additional oracles if needed
      const oraclesToRegister = [
        {
          address: mod.state.signers[4].address,
          name: "RISK_ORACLE",
          description: "Risk assessment oracle for transaction monitoring",
        },
        {
          address: mod.state.signers[5].address,
          name: "FRAUD_ORACLE",
          description: "Fraud detection oracle for suspicious activity",
        },
      ];

      for (const oracle of oraclesToRegister) {
        try {
          await oracleManager.registerOracle(
            oracle.address,
            oracle.name,
            oracle.description,
            500, // Initial reputation (above MIN_REPUTATION)
          );
          console.log(`✅ ${oracle.name} registered: ${oracle.address}`);

          // Add to local config
          mod.state.oracleConfig.set(
            oracle.name.toLowerCase().replace("_", ""),
            {
              address: oracle.address,
              role: oracle.name,
              reputation: 500,
            },
          );
        } catch (error) {
          console.log(
            `⚠️ ${oracle.name} registration failed: ${error.message}`,
          );
        }
      }
    }

    // Configure oracle permissions
    console.log("\n🔐 CONFIGURING ORACLE PERMISSIONS");
    console.log("-".repeat(35));

    // Task 4.4: one emergency designation, OracleManager's (owner or
    // operator); BlacklistOracle.emergencyBlacklist reads it.
    const aml = mod.state.signers[2].address;
    if (await oracleManager.isEmergencyOracle(aml)) {
      console.log("✅ AML Oracle already designated for emergency listings");
    } else {
      const ops = Flow.opsSigner(mod.state);
      const byOps =
        (await oracleManager.operator()).toLowerCase() ===
        ops.address.toLowerCase();
      try {
        const r = byOps
          ? await (
              await oracleManager.connect(ops).setEmergencyOracle(aml, true)
            ).wait()
          : await governOracleManager(mod.state, "setEmergencyOracle", [
              aml,
              true,
            ]);
        console.log(
          r.proposalId
            ? `🗳️ AML Oracle designation proposed (#${r.proposalId}); vote with 77/78`
            : r.refused
              ? `⚠️ Emergency designation: ${r.refused}`
              : `✅ AML Oracle designated in OracleManager for emergency listings (by ${byOps ? "ops" : "the owner"})`,
        );
      } catch (error) {
        console.log(`⚠️ Emergency oracle setup: ${error.message}`);
      }
    }

    // Configure consensus thresholds
    console.log("\n⚖️ CONFIGURING CONSENSUS THRESHOLDS");
    console.log("-".repeat(35));

    try {
      // A percent of the registered weight (Task 4.4): 66 = two of three.
      const current = Number(await oracleManager.getConsensusThreshold());
      console.log(`📊 Current consensus threshold: ${current}%`);
      if (current === Flow.THRESHOLD) {
        console.log(
          `✅ Consensus threshold is ${Flow.THRESHOLD}%: two of three equal nodes`,
        );
      } else {
        const r = await governOracleManager(
          mod.state,
          "setConsensusThreshold",
          [Flow.THRESHOLD],
        );
        console.log(
          r.direct
            ? `✅ Consensus threshold updated to: ${await oracleManager.getConsensusThreshold()}%`
            : r.proposalId
              ? `🗳️ Threshold ${Flow.THRESHOLD}% proposed (#${r.proposalId}); vote with 77/78`
              : `⚠️ Threshold configuration: ${r.refused}`,
        );
      }
    } catch (error) {
      console.log(`⚠️ Threshold configuration: ${error.message}`);
    }

    // Test oracle connectivity
    console.log("\n🔍 TESTING ORACLE CONNECTIVITY");
    console.log("-".repeat(30));

    for (const [key, config] of mod.state.oracleConfig) {
      try {
        const oracleInfo = await oracleManager.getOracleInfo(config.address);
        const status = oracleInfo.active ? "🟢 ONLINE" : "🔴 OFFLINE";
        console.log(`   ${key.toUpperCase()}: ${status}`);
      } catch (error) {
        console.log(`   ${key.toUpperCase()}: 🔴 ERROR - ${error.message}`);
      }
    }

    console.log("\n🎉 ORACLE REGISTRATION & CONFIGURATION COMPLETE!");
    console.log("📊 System Status:");
    console.log(`   👥 Total Oracles: ${await oracleManager.getOracleCount()}`);
    console.log(
      `   ⚖️ Consensus Threshold: ${await oracleManager.getConsensusThreshold()}% of the registered weight`,
    );
    console.log(`   🔗 Oracle Manager: ${await oracleManager.getAddress()}`);
  } catch (error) {
    console.error("❌ Oracle registration failed:", error.message);
  }
}

module.exports = {
  deployOracleSystem,
  registerOracles,
};
