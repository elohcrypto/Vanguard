/**
 * @fileoverview Investor type options 57 to 60: large transfers, cooldowns, full run, dashboard
 * @module InvestorTypeRunFlow
 * @description Tests large-transfer detection and cooldowns, runs every test, prints the dashboard.
 * Moved out of demo/modules/InvestorTypeModule.js (plan v2 Task 4.8). Each
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
const { runOption58 } = require("./InvestorTypeProof");

/** Option 57: Test Large Transfer Detection */
async function testLargeTransferDetection(mod) {
  displaySection("TEST LARGE TRANSFER DETECTION", "🚨");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    console.log("\n🧪 TESTING LARGE TRANSFER DETECTION FOR EACH TYPE");

    const testUsers = mod.state.signers.slice(0, 4);
    const investorTypes = [0, 1, 2, 3];
    const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];

    console.log(
      "\n📊 LARGE TRANSFER DETECTION (recorded: no transfer reads isLargeTransfer):",
    );

    // Counted for option 59: a type passes when the amount under its
    // threshold is normal and the amount over it is large.
    let checked = 0;
    let flagged = 0;
    const wallets = []; // per wallet, with its actual type (option 59)
    for (let i = 0; i < testUsers.length; i++) {
      const config = await investorTypeRegistry.getInvestorTypeConfig(
        investorTypes[i],
      );
      const threshold = config.largeTransferThreshold;
      const normalAmount = threshold - ethers.parseEther("1000");
      const largeAmount = threshold + ethers.parseEther("1000");

      console.log(`\n${typeNames[i]} Investor (${testUsers[i].address}):`);
      console.log(
        `   🚨 Large Transfer Threshold: ${ethers.formatEther(threshold)} VSC`,
      );

      // Test normal transfer
      const isNormalLarge = await investorTypeRegistry.isLargeTransfer(
        testUsers[i].address,
        normalAmount,
      );
      console.log(
        `   📊 ${ethers.formatEther(normalAmount)} VSC: ${isNormalLarge ? "🚨 LARGE" : "✅ NORMAL"}`,
      );

      // Test large transfer
      const isLarge = await investorTypeRegistry.isLargeTransfer(
        testUsers[i].address,
        largeAmount,
      );
      console.log(
        `   📊 ${ethers.formatEther(largeAmount)} VSC: ${isLarge ? "🚨 LARGE" : "✅ NORMAL"}`,
      );
      checked++;
      if (!isNormalLarge && isLarge) flagged++;
      wallets.push({
        address: testUsers[i].address,
        actual:
          typeNames[
            await investorTypeRegistry.getInvestorType(testUsers[i].address)
          ],
        cap: typeNames[i],
        ok: !isNormalLarge && isLarge,
      });
    }

    displaySuccess("LARGE TRANSFER DETECTION TESTING COMPLETE");
    return { checked, flagged, wallets };
  } catch (error) {
    displayError(`Large transfer detection testing failed: ${error.message}`);
    return { failed: true };
  }
}

/** Option 58: prove the cooldown and the tier on chain (Task 4.10) */
async function testTransferCooldowns(mod) {
  return runOption58(mod.state);
}

/** Option 59: Run Complete Investor Type Tests */
async function runCompleteTests(mod) {
  displaySection("RUN COMPLETE INVESTOR TYPE TESTS", "🧪");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!investorTypeRegistry) {
    displayError(
      "InvestorTypeRegistry not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    console.log("\n🎯 RUNNING COMPREHENSIVE INVESTOR TYPE SYSTEM TESTS");
    console.log("");

    // Test 1: Show configurations
    console.log("1️⃣  Testing: Show Investor Type Configurations");
    const shown = await mod.showInvestorTypeConfigurations();
    console.log("");

    // Test 2: Holding limits
    console.log("2️⃣  Testing: Holding Limits by Type");
    const holding = await mod.testHoldingLimits();
    console.log("");

    // Test 3: Large transfer detection
    console.log("3️⃣  Testing: Large Transfer Detection");
    const large = await mod.testLargeTransferDetection();
    console.log("");

    // Test 4: the cooldown and the tier, proven on chain (option 58)
    console.log("4️⃣  Proving: transfer cooldown and whitelist tier");
    const proof = await mod.testTransferCooldowns();
    console.log("");

    displaySuccess("ALL INVESTOR TYPE TESTS COMPLETED!");
    // Each line from the counted result of the step that ran (R-47-2).
    // A step that threw says "failed"; one that never ran, "not run".
    const unrun = (r, label) =>
      r?.failed
        ? `   ❌ ${label} failed (see above)`
        : `   ℹ️  ${label} not run`;
    console.log(
      typeof shown === "number"
        ? `   ✅ Configurations displayed: ${shown} of 4 types read`
        : unrun(shown, "Configurations"),
    );
    // Steps 2 and 3 check wallet i against type i's caps, while the
    // registry applies each wallet's actual type: counted per wallet.
    const perWallet = (r, label, what) => {
      if (!r?.checked) return console.log(unrun(r, label));
      const ok = r.wallets.filter((w) => w.ok).length;
      console.log(
        `   ${ok === r.checked ? "✅" : "⚠️ "} ${label} tested: ${ok} of ${r.checked} wallets ${what}`,
      );
      for (const w of r.wallets)
        console.log(
          `      ${w.ok ? "✅" : "⚠️ "} ${w.address} (actual type ${w.actual}, tested at the ${w.cap} caps)`,
        );
    };
    perWallet(
      holding,
      "Holding limits",
      "allowed under the cap and blocked over it",
    );
    perWallet(
      large,
      "Large transfer detection",
      "flagged only over the threshold",
    );
    for (const [k, label] of [
      ["cooldown", "Transfer cooldown"],
      ["tier", "Whitelist tier"],
    ])
      console.log(
        `   ${proof?.[k] ? "✅" : "⚠️ "} ${label} ${proof?.[k] ? "enforced on chain" : "not proven this run (see 58)"}`,
      );
    console.log("");
    console.log("💡 Use Option 60 to view the complete dashboard");
  } catch (error) {
    displayError(`Complete tests failed: ${error.message}`);
  }
}

/** Option 60: Investor Type System Dashboard */
async function showDashboard(mod) {
  displaySection("INVESTOR TYPE SYSTEM DASHBOARD", "📋");

  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");

  if (!investorTypeRegistry) {
    displayError(
      "Investor Type System not deployed. Please deploy first (option 51).",
    );
    return;
  }

  try {
    console.log("\n📊 SYSTEM STATUS:");
    console.log("=".repeat(50));
    const registryAddress = await investorTypeRegistry.getAddress();
    console.log(`   📋 InvestorTypeRegistry: ${registryAddress}`);
    // Owners as the chain reports them, not signer 0 (R-47-2).
    const registryOwner = await investorTypeRegistry.owner();
    const registryPending = await investorTypeRegistry.pendingOwner();
    console.log(`   👮 Owner: ${registryOwner}`);
    if (registryPending !== ethers.ZeroAddress) {
      console.log(`   ⏳ Pending owner: ${registryPending}`);
    }

    // Governance integration: whether it owns (or is nominated for) the
    // registry, read from chain.
    const governance =
      mod.state.getContract("governance") ||
      mod.state.getContract("vanguardGovernance");
    let governanceState = "Not integrated";
    if (governance) {
      const governanceAddress = await governance.getAddress();
      // A vote can target only the registry governance was built with.
      const bound = (await governance.boundTarget(0)) === registryAddress;
      governanceState =
        registryOwner === governanceAddress
          ? "Integrated (owns the registry)"
          : !bound
            ? "Not integrated (governance bound to another registry)"
            : registryPending === governanceAddress
              ? "Nominated (accepts by vote, 83b)"
              : "Not integrated (does not own the registry)";
      console.log(`   🗳️ Governance: ${governanceState}`);
      console.log(`   📍 Governance Address: ${governanceAddress}`);
      console.log(`   👮 Governance owner: ${await governance.owner()}`);
    } else {
      console.log(`   🗳️ Governance: Not integrated`);
    }

    // The rules bind transfers only when the token reads this registry.
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const enforced =
      !!token && (await token.investorTypeRegistry()) === registryAddress;

    // Show investor type configurations
    console.log("\n📋 INVESTOR TYPE CONFIGURATIONS:");
    console.log("=".repeat(50));

    const investorTypes = [0, 1, 2, 3];
    const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];
    const typeEmojis = ["👤", "🛒", "💼", "🏛️"];

    for (let i = 0; i < investorTypes.length; i++) {
      const config = await investorTypeRegistry.getInvestorTypeConfig(
        investorTypes[i],
      );
      console.log(
        `\n${typeEmojis[i]} ${typeNames[i]} Investor (Type ${investorTypes[i]}):`,
      );
      console.log(
        `   💰 Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`,
      );
      console.log(
        `   🏦 Max Holding: ${ethers.formatEther(config.maxHoldingAmount)} VSC`,
      );
      console.log(
        `   ⏰ Cooldown: ${config.transferCooldownMinutes} minutes ${enforced ? "(enforced)" : "(not enforced: no token reads this registry)"}`,
      );

      const thresholdDisplay =
        config.largeTransferThreshold.toString() ===
        ethers.MaxUint256.toString()
          ? "No threshold"
          : `${ethers.formatEther(config.largeTransferThreshold)} VSC`;
      console.log(`   🚨 Large Transfer: ${thresholdDisplay}`);
    }

    // Show assigned investors
    if (mod.state.investors && mod.state.investors.size > 0) {
      console.log("\n👥 ASSIGNED INVESTORS:");
      console.log("=".repeat(50));

      let index = 1;
      for (const investor of mod.state.investors.values()) {
        const investorType = await investorTypeRegistry.getInvestorType(
          investor.address,
        );
        console.log(
          `${index}. ${investor.name} - Type: ${typeNames[investorType]}`,
        );
        index++;
      }
    } else {
      console.log("\n👥 ASSIGNED INVESTORS:");
      console.log("=".repeat(50));
      console.log("   ℹ️  No investors assigned yet");
      console.log("   💡 Use Option 23 to create investors");
      console.log("   💡 Use Option 53 to assign types");
    }

    console.log("\n📈 SYSTEM STATISTICS:");
    console.log("=".repeat(50));
    console.log(`   📊 Total Investor Types: 4`);
    console.log(
      `   👥 Assigned Investors: ${mod.state.investors ? mod.state.investors.size : 0}`,
    );
    console.log(
      `   🔒 Compliance Checks: ${enforced ? "Active" : "Not active (no token reads this registry)"}`,
    );
    console.log(`   ⚖️ Governance: ${governanceState}`);

    displaySuccess("DASHBOARD DISPLAYED SUCCESSFULLY");
  } catch (error) {
    displayError(`Dashboard display failed: ${error.message}`);
  }
}

module.exports = {
  testLargeTransferDetection,
  testTransferCooldowns,
  runCompleteTests,
  showDashboard,
};
