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

const MODE = ["OracleOnly", "ZkOnly", "Either"];

/**
 * Option 38: what the oracles decide for VSC, read from chain (R-48-6,
 * Task 4.16): the oracles ComplianceRules binds for VSC and
 * token.canTransfer for the demo wallets. Nothing is written here: option
 * 31 binds the blacklist oracle, 38a the whitelist oracle (by vote after
 * the handover).
 */
async function integrateWithToken(mod) {
  console.log("\n🔗 ORACLES ON VSC (chain reads)");
  console.log("=".repeat(50));

  const digitalToken = mod.state.getContract("digitalToken");
  const rules = mod.state.getContract("complianceRules");
  if (!digitalToken || !rules) {
    console.log("ℹ️  Deploy VSC and ComplianceRules first (option 21)");
    return;
  }

  try {
    const vsc = await digitalToken.getAddress();
    const bl = await rules.blacklistOracle(vsc);
    const wl = await rules.whitelistOracle(vsc);
    const mode = MODE[Number(await rules.whitelistMode(vsc))];
    const none = "0x0000000000000000000000000000000000000000";
    console.log(`🪙 VSC: ${vsc}`);
    console.log(
      `   rules.blacklistOracle(VSC) = ${bl}${bl === none ? " (none: no blacklist gate; option 31 binds it)" : " (a listed party is refused)"}`,
    );
    console.log(
      `   rules.whitelistOracle(VSC) = ${wl}${wl === none ? " (none: no whitelist gate; option 38a binds it)" : ` (${mode}: an unlisted or tier-short party is refused)`}`,
    );
    console.log(`   rules.whitelistMode(VSC)   = ${mode}`);

    console.log(
      "\n💸 token.canTransfer(from, to, 1 wei) for the demo wallets:",
    );
    const wallets = mod.state.signers.slice(1, 5);
    for (let i = 0; i < wallets.length; i++) {
      const from = wallets[i].address;
      const to = wallets[(i + 1) % wallets.length].address;
      const ok = await digitalToken.canTransfer(from, to, 1n);
      console.log(
        `   ${from} -> ${to.slice(0, 10)}...: ${ok ? "✅ allowed" : "⛔ refused"}`,
      );
    }
    console.log(
      "\n💡 A refusal is the token's own verdict (identity, jurisdiction, oracles, caps, cooldown); options 17/20d and 29 read the parts",
    );
  } catch (error) {
    console.error("❌ Oracle reads failed:", error.message);
  }
}

/** Option 39: Oracle System Dashboard */
async function showDashboard(mod) {
  console.log("\n📋 ORACLE SYSTEM DASHBOARD");
  console.log("=".repeat(50));

  const oracleManager = mod.state.getContract("oracleManager");
  if (!oracleManager) {
    console.log("ℹ️  Oracle Management System not deployed");
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

    // Individual Oracle Status: the nodes registered on chain now (Task
    // 5.12: after a rotation by vote, not option 31's wallets).
    console.log("\n👥 INDIVIDUAL ORACLE STATUS:");
    for (const { address, signer } of await Flow.registeredNodes(mod.state)) {
      try {
        const oracleInfo = await oracleManager.getOracleInfo(address);
        const key = signer
          ? `wallet ${mod.state.signers.indexOf(signer)}`
          : "no demo key";
        console.log(`\n${oracleInfo.name} (${key}):`);
        console.log(`   📍 Address: ${address}`);
        console.log(`   🏆 Reputation: ${oracleInfo.reputation}`);
        console.log(`   ✅ Rewarded: ${oracleInfo.correctAttestations}`);
        console.log(`   🗳️ Answers: ${oracleInfo.totalAttestations}`);
        console.log(`   🔄 Active: ${oracleInfo.active ? "YES" : "NO"}`);
        console.log(
          `   🚨 Emergency: ${(await oracleManager.isEmergencyOracle(address)) ? "YES" : "NO"}`,
        );
      } catch (error) {
        console.log(`\n${address}: ❌ Error retrieving info`);
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
      `   🏛️ ERC-3643 Vanguard StableCoin: ${digitalToken ? "✅ DEPLOYED" : "❌ NOT DEPLOYED"}`,
    );
    console.log(
      `   ⚖️ ComplianceRules: ${complianceRules ? "✅ DEPLOYED" : "❌ NOT DEPLOYED"}`,
    );
    console.log(
      `   🆔 OnchainID System: ${onchainIDFactory ? "✅ DEPLOYED" : "❌ NOT DEPLOYED"}`,
    );

    // From the oracle counts read above, not a constant (R-47-2).
    console.log(
      `\n🎯 ORACLE SYSTEM HEALTH: ${activeOracles.length > 0 ? "✅" : "⚠️ "} ${activeOracles.length} of ${totalOracles} oracles active`,
    );
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
    console.log("ℹ️  Missing required systems:");
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
    // This path names its tier in the call; a consensus listing takes the
    // tier its query was raised with (option 33a, Task 4.12).
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
        `✅ ${who} whitelisted by ${writer.address} (addToWhitelist names tier 5): tier ${info.tier} (chain), until ${info.expiryTime}`,
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
