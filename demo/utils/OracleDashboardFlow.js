/**
 * @fileoverview Oracle options 38 to 40: token integration, dashboard, integration test
 * @module OracleDashboardFlow
 * @description Binds the oracles to the token, prints the oracle dashboard, runs the integration test.
 * Moved out of demo/modules/OracleModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const Flow = require("./OracleLifecycleFlow");

/** Option 38: Integrate Oracles with Token */
async function integrateWithToken(mod) {
  console.log("\n🔗 INTEGRATE ORACLES WITH DIGITAL TOKEN");
  console.log("=".repeat(50));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log(
      "❌ Please deploy Vanguard StableCoin System first (option 21)",
    );
    return;
  }

  const oracleManager = mod.state.getContract("oracleManager");
  if (!oracleManager) {
    console.log("❌ Please deploy Oracle Management System first (option 31)");
    return;
  }

  try {
    const tokenAddress = await digitalToken.getAddress();
    console.log(`🪙 Digital Token: ${tokenAddress}`);
    console.log("🔗 Integrating Oracle System with Vanguard StableCoin...");

    // This demonstrates how oracles would integrate with token operations
    console.log("\n📋 Integration Scenarios:");
    console.log("1. 🔍 Pre-transfer Oracle Validation");
    console.log("2. 📊 Real-time Compliance Monitoring");
    console.log("3. 🚫 Oracle-based Transfer Blocking");
    console.log("4. 📈 Compliance Score Integration");

    console.log("\n🔍 PRE-TRANSFER ORACLE VALIDATION:");
    console.log("   • Whitelist check before token transfer");
    console.log("   • Blacklist verification");
    console.log("   • Real-time AML screening");

    // Simulate oracle validation for a transfer
    const whitelistOracle = mod.state.getContract("whitelistOracle");
    const blacklistOracle = mod.state.getContract("blacklistOracle");

    if (mod.state.identities && mod.state.identities.size > 0) {
      const firstIdentity = Array.from(mod.state.identities.values())[0];

      console.log("\n🧪 TESTING ORACLE VALIDATION:");
      console.log(`   Testing user: ${firstIdentity.owner}`);

      // Check whitelist status
      const isWhitelisted = await whitelistOracle.isWhitelisted(
        firstIdentity.owner,
      );
      console.log(
        `   📋 Whitelist Status: ${isWhitelisted ? "✅ APPROVED" : "❌ NOT APPROVED"}`,
      );

      // Check blacklist status
      const isBlacklisted = await blacklistOracle.isBlacklisted(
        firstIdentity.owner,
      );
      console.log(
        `   🚫 Blacklist Status: ${isBlacklisted ? "❌ BLOCKED" : "✅ CLEAR"}`,
      );

      // Determine transfer eligibility
      const transferEligible = isWhitelisted && !isBlacklisted;
      console.log(
        `   💸 Transfer Eligible: ${transferEligible ? "✅ YES" : "❌ NO"}`,
      );

      if (transferEligible) {
        console.log(
          "   🎉 User passes oracle validation - transfer would be allowed",
        );
      } else {
        console.log(
          "   🚫 User fails oracle validation - transfer would be blocked",
        );
      }
    }

    console.log("\n✅ ORACLE-DIGITAL TOKEN INTEGRATION COMPLETE!");
    console.log(
      "🔗 Oracle system is now monitoring Vanguard StableCoin transactions",
    );
    console.log("📊 Real-time compliance validation active");
    console.log("🛡️ Enhanced security through oracle consensus");
  } catch (error) {
    console.error("❌ Oracle integration failed:", error.message);
  }
}

/** Option 39: Oracle System Dashboard */
async function showDashboard(mod) {
  console.log("\n📋 ORACLE SYSTEM DASHBOARD");
  console.log("=".repeat(50));

  const oracleManager = mod.state.getContract("oracleManager");
  if (!oracleManager) {
    console.log("❌ Oracle Management System not deployed");
    console.log("💡 Please run option 31 first");
    return;
  }

  try {
    console.log("🔧 ORACLE MANAGEMENT SYSTEM STATUS");
    console.log("-".repeat(40));

    // Oracle Manager Status
    const totalOracles = await oracleManager.getOracleCount();
    const activeOracles = await oracleManager.getActiveOracles();
    const consensusThreshold = await oracleManager.getConsensusThreshold();

    console.log(`📊 Oracle Network:`);
    console.log(`   Total Oracles: ${totalOracles}`);
    console.log(`   Active Oracles: ${activeOracles.length}`);
    console.log(
      `   Consensus Threshold: ${consensusThreshold}% of the registered weight`,
    );
    console.log(`   Operator: ${await oracleManager.operator()}`);

    // Individual Oracle Status
    console.log("\n👥 INDIVIDUAL ORACLE STATUS:");
    for (const [key, config] of mod.state.oracleConfig) {
      try {
        const oracleInfo = await oracleManager.getOracleInfo(config.address);
        console.log(`\n${key.toUpperCase()} (${config.role}):`);
        console.log(`   📍 Address: ${config.address}`);
        console.log(`   🏆 Reputation: ${oracleInfo.reputation}`);
        console.log(`   ✅ Rewarded: ${oracleInfo.correctAttestations}`);
        console.log(`   🗳️ Answers: ${oracleInfo.totalAttestations}`);
        console.log(`   🔄 Active: ${oracleInfo.active ? "YES" : "NO"}`);
        console.log(
          `   🚨 Emergency: ${(await oracleManager.isEmergencyOracle(config.address)) ? "YES" : "NO"}`,
        );
      } catch (error) {
        console.log(`\n${key.toUpperCase()}: ❌ Error retrieving info`);
      }
    }

    // Whitelist/Blacklist Summary
    console.log("\n📋 WHITELIST/BLACKLIST SUMMARY:");
    let whitelistCount = 0;
    let blacklistCount = 0;

    const whitelistOracle = mod.state.getContract("whitelistOracle");
    const blacklistOracle = mod.state.getContract("blacklistOracle");

    if (mod.state.identities) {
      for (const identity of mod.state.identities.values()) {
        try {
          const isWhitelisted = await whitelistOracle.isWhitelisted(
            identity.owner,
          );
          const isBlacklisted = await blacklistOracle.isBlacklisted(
            identity.owner,
          );

          if (isWhitelisted) whitelistCount++;
          if (isBlacklisted) blacklistCount++;
        } catch (error) {
          // Skip errors for individual checks
        }
      }
    }

    console.log(`   📋 Whitelisted Users: ${whitelistCount}`);
    console.log(`   🚫 Blacklisted Users: ${blacklistCount}`);
    console.log(
      `   👥 Total Identities: ${mod.state.identities ? mod.state.identities.size : 0}`,
    );

    // Integration Status
    const digitalToken = mod.state.getContract("digitalToken");
    const complianceRules = mod.state.getContract("complianceRules");
    const onchainIDFactory = mod.state.getContract("onchainIDFactory");

    console.log("\n🔗 INTEGRATION STATUS:");
    console.log(
      `   🏛️ ERC-3643 Vanguard StableCoin: ${digitalToken ? "✅ CONNECTED" : "❌ NOT CONNECTED"}`,
    );
    console.log(
      `   ⚖️ ComplianceRules: ${complianceRules ? "✅ CONNECTED" : "❌ NOT CONNECTED"}`,
    );
    console.log(
      `   🆔 OnchainID System: ${onchainIDFactory ? "✅ CONNECTED" : "❌ NOT CONNECTED"}`,
    );

    console.log("\n🎯 ORACLE SYSTEM HEALTH: ✅ OPERATIONAL");
  } catch (error) {
    console.error("❌ Dashboard generation failed:", error.message);
  }
}

/** Option 40: Test Complete Oracle Integration */
async function testIntegration(mod) {
  console.log("\n🧪 TEST COMPLETE ORACLE INTEGRATION");
  console.log("=".repeat(50));

  const oracleManager = mod.state.getContract("oracleManager");
  const digitalToken = mod.state.getContract("digitalToken");

  if (!oracleManager || !digitalToken) {
    console.log("❌ Missing required systems:");
    console.log(`   Oracle System: ${oracleManager ? "✅" : "❌"}`);
    console.log(`   Vanguard StableCoin: ${digitalToken ? "✅" : "❌"}`);
    console.log("💡 Please deploy both systems first");
    return;
  }

  try {
    console.log("🔄 Running Complete Integration Test...");
    console.log("This test demonstrates the full oracle-integrated workflow");

    const whitelistOracle = mod.state.getContract("whitelistOracle");
    const blacklistOracle = mod.state.getContract("blacklistOracle");

    // Test 1: a compliance query through the gate, tallied by the engine
    console.log("\n1️⃣ TESTING ORACLE CONSENSUS");
    console.log("-".repeat(30));
    const t = await Flow.consensusRound(
      mod.state,
      Flow.QUERY.COMPLIANCE,
      Flow.throwawaySubject(),
      "0x",
    );
    const nodes = (await oracleManager.getRegisteredOracles()).length;
    console.log(
      t.hasResult
        ? `✅ Compliance query resolved by ${t.voters.length} of ${nodes} registered nodes`
        : "❌ Compliance query did not resolve",
    );

    // Test 2: Whitelist Integration with Vanguard StableCoin
    console.log("\n2️⃣ TESTING WHITELIST-DIGITAL TOKEN INTEGRATION");
    console.log("-".repeat(45));

    // A throwaway address for 30 days, written by the whitelist oracle's
    // owner (the deployer, ops after the handover): no demo holder changes.
    const wlOwner = await whitelistOracle.owner();
    const writer = [mod.state.signers[0], Flow.opsSigner(mod.state)].find(
      (w) => w.address.toLowerCase() === wlOwner.toLowerCase(),
    );
    if (writer) {
      const who = Flow.throwawaySubject();
      await (
        await whitelistOracle
          .connect(writer)
          .addToWhitelist(who, 5, 30 * 86400, "Integration test (30 days)")
      ).wait();
      const info = await whitelistOracle.getWhitelistInfo(who);
      console.log(
        `✅ ${who} whitelisted by ${writer.address}: tier ${info.tier}, until ${info.expiryTime}`,
      );
    } else {
      console.log(
        `ℹ️  Skipped: the whitelist oracle is owned by ${wlOwner}, neither the deployer nor ops`,
      );
    }

    // Test 3: Emergency Protocol
    console.log("\n3️⃣ TESTING EMERGENCY PROTOCOLS");
    console.log("-".repeat(30));

    // A throwaway subject: a 7-day CRITICAL listing must not freeze a
    // demo holder. The designation is OracleManager's (option 32 / 35a).
    const emergencyOracle = mod.state.signers[2]; // AML Oracle
    if (await oracleManager.isEmergencyOracle(emergencyOracle.address)) {
      const target = Flow.throwawaySubject();
      await (
        await blacklistOracle
          .connect(emergencyOracle)
          .emergencyBlacklist(target, 3, "Integration test - emergency")
      ).wait();
      console.log(
        `✅ Emergency blacklist executed: ${target} listed = ${await blacklistOracle.isBlacklisted(target)}`,
      );
      console.log(`   🚨 Severity: CRITICAL`);
      console.log(`   👮 Emergency Oracle: ${emergencyOracle.address}`);
    } else {
      console.log("⚠️ AML Oracle not designated: run option 32 or 35a");
    }

    // Test 4: Oracle Reputation Update
    console.log("\n4️⃣ TESTING ORACLE REPUTATION SYSTEM");
    console.log("-".repeat(35));

    const oracle1 = mod.state.signers[1];
    const omOwner = await oracleManager.owner();
    if (omOwner.toLowerCase() === mod.state.signers[0].address.toLowerCase()) {
      await (
        await oracleManager.rewardOracle(
          oracle1.address,
          50,
          "Integration test",
        )
      ).wait();
      const info = await oracleManager.getOracleInfo(oracle1.address);
      console.log(
        `✅ Oracle rewarded: ${oracle1.address} (+50), reputation ${info.reputation}`,
      );
    } else {
      console.log(
        `ℹ️  Skipped: rewardOracle is the owner's (${omOwner}, governance after the handover)`,
      );
    }

    // Test Summary
    console.log("\n🎉 COMPLETE INTEGRATION TEST RESULTS");
    console.log("=".repeat(40));
    console.log(`   ⚖️  Consensus: ${Flow.tallyLine(t)}`);
    console.log(
      `   🔗 VSC blacklist gate: ${await mod.state.getContract("complianceRules").blacklistOracle(await digitalToken.getAddress())}`,
    );
    console.log(
      "   ℹ️  Engine weights are set per node by the manager owner; they do not follow reputation",
    );
  } catch (error) {
    console.error("❌ Integration test failed:", error.message);
  }
}

module.exports = {
  integrateWithToken,
  showDashboard,
  testIntegration,
};
