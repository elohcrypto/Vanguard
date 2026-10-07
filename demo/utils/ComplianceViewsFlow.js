/**
 * @fileoverview Compliance options 15 to 20d: limits, cooldowns, tiers, checks, dashboard
 * @module ComplianceViewsFlow
 * @description Prints the investor-type rules, runs the validation and access checks, prints the dashboard and the jurisdiction rules.
 * Moved out of demo/modules/ComplianceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const { runAccessControlChecks } = require("./AccessControlChecks");
const { printCooldowns, printTiers } = require("./InvestorTypeRules");
const { displaySection, displayError } = require("./DisplayHelpers");
const TYPE_NAMES = ["Normal", "Retail", "Accredited", "Institutional"];

/**
 * The registry Token enforces investor-type limits from, or null after
 * printing why. Task 4.1 removed ComplianceRules' own investor-type,
 * holding-period and level rules: they were stored and validated but no
 * transfer ever read them. Their live home is InvestorTypeRegistry.
 * @private
 */
async function _investorTypeContext(mod) {
  const registry = mod.state.getContract("investorTypeRegistry");
  const token = mod.state.getContract("digitalToken");
  if (!registry || !token) {
    console.log("❌ InvestorTypeRegistry or VSC not deployed!");
    console.log("💡 Deploy VSC (option 21) and the registry (option 51)");
    return null;
  }
  const regAddr = await registry.getAddress();
  const live = await token.investorTypeRegistry();
  const wired = live.toLowerCase() === regAddr.toLowerCase();
  console.log(`📦 InvestorTypeRegistry: ${regAddr}`);
  console.log(
    wired
      ? "   ✅ VSC enforces this registry on every transfer and mint"
      : `   ⚠️  VSC enforces ${live}, not this registry: nothing below gates VSC`,
  );
  return { registry, token, wired };
}

/** @private The four type configs, in enum order. */
async function _typeConfigs(mod, registry) {
  const out = [];
  for (let t = 0; t < TYPE_NAMES.length; t++) {
    out.push(await registry.getInvestorTypeConfig(t));
  }
  return out;
}

/**
 * Options 15 and 20b: investor-type limits, read from InvestorTypeRegistry,
 * and what Token would decide for each demo wallet. These caps are live:
 * Token refuses with "Transfer amount limit exceeded" or "Holding limit
 * exceeded". Change them with an InvestorTypeConfig vote (option 76, type 0)
 * or as the registry owner before the handover (options 51-60).
 *
 * @returns {Promise<void>}
 */
async function showInvestorTypeLimits(mod) {
  displaySection("INVESTOR TYPE LIMITS (InvestorTypeRegistry)", "👥");
  const ctx = await mod._investorTypeContext();
  if (!ctx) return;
  try {
    const { registry, token, wired } = ctx;
    const configs = await mod._typeConfigs(registry);
    const how = wired ? "enforced by Token" : "not wired to VSC";
    console.log(`\n📊 LIMITS PER TYPE (${how}):`);
    configs.forEach((c, t) => {
      console.log(
        `   ${t} ${TYPE_NAMES[t].padEnd(13)} max transfer ${ethers.formatEther(c.maxTransferAmount)} VSC, max holding ${ethers.formatEther(c.maxHoldingAmount)} VSC`,
      );
    });

    const input = await mod.promptUser(
      "\nAmount to test per wallet in VSC (default 10000): ",
    );
    const amount = ethers.parseEther((input || "10000").trim());
    console.log(`\n🧪 ${ethers.formatEther(amount)} VSC per demo wallet:`);
    for (const s of mod.state.signers.slice(1, 5)) {
      const type = Number(await registry.getInvestorType(s.address));
      const send = await registry.canTransferAmount(s.address, amount);
      const balance = await token.balanceOf(s.address);
      const hold = await registry.canHoldAmount(s.address, balance + amount);
      console.log(
        `   ${s.address} (${TYPE_NAMES[type]}): send ${send ? "✅ ALLOWED" : "❌ BLOCKED (Transfer amount limit exceeded)"}, receive ${hold ? "✅ ALLOWED" : "❌ BLOCKED (Holding limit exceeded)"}`,
      );
    }
    console.log(
      "\n💡 investorLimitExempt wallets (treasury, escrow fee wallets) skip both caps",
    );
    console.log(
      "💡 Change limits: InvestorTypeConfig vote (option 76, type 0) after the handover",
    );
  } catch (error) {
    displayError(`Reading investor type limits failed: ${error.message}`);
  }
}

/**
 * Options 16 and 20c: the per-type transfer cooldowns Token enforces
 * (Task 4.10, D37 = a) and each demo wallet's clock, read from chain.
 *
 * @returns {Promise<void>}
 */
async function showTransferCooldowns(mod) {
  displaySection("TRANSFER COOLDOWNS (InvestorTypeRegistry)", "⏰");
  try {
    await printCooldowns(mod.state);
  } catch (error) {
    displayError(`Reading transfer cooldowns failed: ${error.message}`);
  }
}

/**
 * Options 17 and 20d: the whitelist tier each investor type requires,
 * enforced by ComplianceRules where a party passes by its oracle entry
 * (Task 4.10); VSC's mode and oracle and each wallet's verdict from chain.
 *
 * @returns {Promise<void>}
 */
async function showWhitelistTiers(mod) {
  displaySection("REQUIRED WHITELIST TIERS (InvestorTypeRegistry)", "📊");
  try {
    await printTiers(mod.state);
  } catch (error) {
    displayError(`Reading whitelist tiers failed: ${error.message}`);
  }
}

/**
 * Option 18: every check this menu can evaluate against live state: the
 * jurisdiction verdict ComplianceRules applies in canTransfer, and the
 * investor-type caps Token applies from InvestorTypeRegistry.
 *
 * @returns {Promise<void>}
 */
async function testAllComplianceValidations(mod) {
  console.log("\n🧪 TEST ALL COMPLIANCE VALIDATIONS");
  console.log("=".repeat(50));

  const complianceRules = mod.state.getContract("complianceRules");
  if (!complianceRules) {
    console.log("❌ ComplianceRules contract not deployed!");
    console.log("💡 Please deploy ComplianceRules first using option 13");
    return;
  }

  try {
    const token = mod.state.getContract("digitalToken");
    if (!token) {
      console.log("❌ Token not deployed!");
      return;
    }
    const tokenAddress = await token.getAddress();
    console.log(
      `🪙 Testing compliance validations with ERC-3643 Digital Token: ${tokenAddress}`,
    );

    console.log("\n🌍 JURISDICTION VALIDATION TESTS (ComplianceRules)");
    console.log("-".repeat(40));
    const jurisdictionTests = [
      { country: 840, name: "United States" },
      { country: 826, name: "United Kingdom" },
      { country: 643, name: "Russia" },
      { country: 156, name: "China" },
      { country: 999, name: "Unknown Country" },
    ];

    for (const test of jurisdictionTests) {
      try {
        const [isValid, reason] = await complianceRules.validateJurisdiction(
          tokenAddress,
          test.country,
        );
        console.log(
          `   ${test.name} (${test.country}): ${isValid ? "✅ ALLOWED" : "❌ BLOCKED"} - ${reason}`,
        );
      } catch (error) {
        console.log(
          `   ${test.name} (${test.country}): ❌ ERROR - ${error.message}`,
        );
      }
    }

    console.log("\n👥 INVESTOR TYPE CAPS (InvestorTypeRegistry)");
    console.log("-".repeat(40));
    const registry = mod.state.getContract("investorTypeRegistry");
    if (!registry) {
      console.log("   ℹ️  No InvestorTypeRegistry deployed (option 51)");
    } else {
      const amount = ethers.parseEther("10000");
      for (const s of mod.state.signers.slice(1, 5)) {
        const type = Number(await registry.getInvestorType(s.address));
        const ok = await registry.canTransferAmount(s.address, amount);
        console.log(
          `   ${TYPE_NAMES[type]} ${s.address} sending 10,000 VSC: ${ok ? "✅ ALLOWED" : "❌ BLOCKED - Transfer amount limit exceeded"}`,
        );
      }
    }

    console.log("\n🎉 ALL COMPLIANCE VALIDATION TESTS COMPLETED!");
  } catch (error) {
    console.error("❌ Compliance validation tests failed:", error.message);
  }
}

/**
 * Option 19: ComplianceRules access control on VSC, counted from chain
 * (demo/utils/AccessControlChecks.js).
 */
async function testAccessControl(mod) {
  console.log("\n🔐 COMPREHENSIVE ACCESS CONTROL TESTING");
  console.log("=".repeat(60));
  try {
    return await runAccessControlChecks(mod.state);
  } catch (error) {
    console.error("❌ Access control tests failed:", error.message);
  }
}

/**
 * Option 20: Show ComplianceRules dashboard
 *
 * @returns {Promise<void>}
 */
async function showComplianceRulesDashboard(mod) {
  console.log("\n📋 COMPLIANCE RULES DASHBOARD");
  console.log("=".repeat(50));

  const complianceRules = mod.state.getContract("complianceRules");
  if (!complianceRules) {
    console.log("❌ ComplianceRules contract not deployed!");
    console.log("💡 Please deploy ComplianceRules first using option 13");
    return;
  }

  try {
    console.log("\n🔧 ORACLE SYSTEM STATUS:");
    console.log("   🚨 Emergency Oracle: AML Oracle");
    console.log("   ⚖️ Equal Voting Weights: 100 each");

    // Add more dashboard content here
    console.log("\n✅ COMPLIANCE RULES DASHBOARD LOADED");
  } catch (error) {
    console.error("❌ Oracle registration failed:", error.message);
  }
}

/**
 * Option 20a: View jurisdiction rules
 *
 * @returns {Promise<void>}
 */
async function viewJurisdictionRules(mod) {
  console.log("\n🌍 JURISDICTION RULES (WHITELIST/BLACKLIST)");
  console.log("=".repeat(50));

  const complianceRules = mod.state.getContract("complianceRules");
  if (!complianceRules) {
    console.log("❌ ComplianceRules contract not deployed!");
    console.log("💡 Please deploy ComplianceRules first using option 13");
    return;
  }

  try {
    // Get token address
    const token = mod.state.getContract("digitalToken");
    if (!token) {
      console.log("❌ Token not deployed!");
      return;
    }
    const tokenAddress = await token.getAddress();

    console.log(`\n📦 Token: ${tokenAddress}`);
    console.log("");

    // Get jurisdiction rule - FORCE FRESH READ FROM BLOCKCHAIN
    console.log("🔄 Reading current rules from blockchain...");
    const rule = await complianceRules.getJurisdictionRule(tokenAddress);

    // Debug: Show raw data
    console.log(`\n🔍 DEBUG - Raw blockchain data:`);
    console.log(
      `   Allowed (raw): [${rule.allowedCountries.map((c) => Number(c)).join(", ")}]`,
    );
    console.log(
      `   Blocked (raw): [${rule.blockedCountries.map((c) => Number(c)).join(", ")}]`,
    );

    console.log("📊 JURISDICTION RULE STATUS:");
    console.log(`   Active: ${rule.isActive ? "✅ YES" : "❌ NO"}`);
    console.log(
      `   Last Updated: ${new Date(Number(rule.lastUpdated) * 1000).toLocaleString()}`,
    );
    console.log("");

    // Display allowed countries (whitelist)
    console.log("✅ WHITELIST (Allowed Countries):");
    if (rule.allowedCountries.length === 0) {
      console.log("   ℹ️  No whitelist configured");
      console.log("   💡 All countries are allowed (except blocked ones)");
    } else {
      console.log(`   📊 Total: ${rule.allowedCountries.length} countries`);
      console.log("   📋 Countries:");

      const countryNames = {
        840: "United States",
        826: "United Kingdom",
        124: "Canada",
        276: "Germany",
        250: "France",
        380: "Italy",
        724: "Spain",
        392: "Japan",
        410: "South Korea",
        702: "Singapore",
        36: "Australia",
        156: "China",
        643: "Russia",
        850: "North Korea",
        364: "Iran",
        760: "Syria",
      };

      for (let i = 0; i < rule.allowedCountries.length; i++) {
        const code = Number(rule.allowedCountries[i]);
        const name = countryNames[code] || "Unknown";
        console.log(`      ${i + 1}. ${code} - ${name}`);
      }
      console.log("");
      console.log("   💡 ONLY these countries can participate");
    }
    console.log("");

    // Display blocked countries (blacklist)
    console.log("❌ BLACKLIST (Blocked Countries):");
    if (rule.blockedCountries.length === 0) {
      console.log("   ℹ️  No countries blocked");
      console.log("   💡 All countries are allowed");
    } else {
      console.log(`   📊 Total: ${rule.blockedCountries.length} countries`);
      console.log("   📋 Countries:");

      const countryNames = {
        840: "United States",
        826: "United Kingdom",
        124: "Canada",
        276: "Germany",
        250: "France",
        380: "Italy",
        724: "Spain",
        392: "Japan",
        410: "South Korea",
        702: "Singapore",
        36: "Australia",
        156: "China",
        643: "Russia",
        850: "North Korea",
        364: "Iran",
        760: "Syria",
      };

      for (let i = 0; i < rule.blockedCountries.length; i++) {
        const code = Number(rule.blockedCountries[i]);
        const name = countryNames[code] || "Unknown";
        console.log(`      ${i + 1}. ${code} - ${name}`);
      }
      console.log("");
      console.log("   💡 These countries are ALWAYS blocked");
    }
    console.log("");

    // Display logic explanation
    console.log("📋 HOW IT WORKS:");
    if (rule.allowedCountries.length > 0 && rule.blockedCountries.length > 0) {
      console.log("   1. Check if country is in BLACKLIST → ❌ BLOCKED");
      console.log("   2. Check if country is in WHITELIST → ✅ ALLOWED");
      console.log("   3. If not in WHITELIST → ❌ BLOCKED");
      console.log("");
      console.log("   💡 Whitelist + Blacklist mode");
      console.log(
        "   💡 Only whitelisted countries allowed, blacklist takes priority",
      );
    } else if (rule.allowedCountries.length > 0) {
      console.log("   1. Check if country is in WHITELIST → ✅ ALLOWED");
      console.log("   2. If not in WHITELIST → ❌ BLOCKED");
      console.log("");
      console.log("   💡 Whitelist-only mode");
      console.log("   💡 Only whitelisted countries allowed");
    } else if (rule.blockedCountries.length > 0) {
      console.log("   1. Check if country is in BLACKLIST → ❌ BLOCKED");
      console.log("   2. If not in BLACKLIST → ✅ ALLOWED");
      console.log("");
      console.log("   💡 Blacklist-only mode");
      console.log("   💡 All countries allowed except blacklisted");
    } else {
      console.log("   ✅ All countries are ALLOWED");
      console.log("");
      console.log("   💡 No restrictions mode");
      console.log("   💡 Global access");
    }
    console.log("");

    // Display governance info
    console.log("🗳️ GOVERNANCE:");
    console.log("   💡 To update these rules, use governance voting:");
    console.log("      79. Deploy Governance System");
    console.log("      81. Create Proposal (Type 1: Jurisdiction Rules)");
    console.log("      82. Vote on Proposal");
    console.log("      83. Execute Proposal");
    console.log("");
  } catch (error) {
    console.error("❌ Error viewing jurisdiction rules:", error.message);
  }
}

module.exports = {
  _investorTypeContext,
  _typeConfigs,
  showInvestorTypeLimits,
  showTransferCooldowns,
  showWhitelistTiers,
  testAllComplianceValidations,
  testAccessControl,
  showComplianceRulesDashboard,
  viewJurisdictionRules,
};
