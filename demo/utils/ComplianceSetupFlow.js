/**
 * @fileoverview Compliance options 13 and 14: deploy ComplianceRules, jurisdiction rules
 * @module ComplianceSetupFlow
 * @description Deploys ComplianceRules with the chosen countries and edits its jurisdiction rules.
 * Moved out of demo/modules/ComplianceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { displaySection, displayError } = require("./DisplayHelpers");

/**
 * Option 13: Deploy ComplianceRules contract
 *
 * @returns {Promise<void>}
 *
 * @example
 * await module.deployComplianceRules();
 */
async function deployComplianceRules(mod) {
  displaySection("DEPLOYING COMPLIANCE RULES CONTRACT", "🏗️");

  if (!mod.state.getContract("onchainIDFactory")) {
    displayError("Please deploy contracts first (option 1)");
    return;
  }

  try {
    // Display jurisdiction rules information
    console.log("\n🌍 INITIAL JURISDICTION RULES");
    console.log("=".repeat(50));
    console.log("\n📋 How Jurisdiction Rules Work:");
    console.log(
      "   • WHITELIST (Allowed Countries): If set, ONLY these countries can participate",
    );
    console.log(
      "   • BLACKLIST (Blocked Countries): These countries are ALWAYS blocked",
    );
    console.log(
      "   • If NO whitelist: All countries allowed EXCEPT blocked ones",
    );
    console.log(
      "   • If whitelist exists: ONLY allowed countries, AND blocked are still blocked",
    );
    console.log("");
    console.log("📋 Common Country Codes (ISO 3166-1 numeric):");
    console.log("   840 - United States");
    console.log("   826 - United Kingdom");
    console.log("   124 - Canada");
    console.log("   276 - Germany");
    console.log("   250 - France");
    console.log("   392 - Japan");
    console.log("   702 - Singapore");
    console.log("   36  - Australia");
    console.log("   344 - Hong Kong");
    console.log("   756 - Switzerland");
    console.log("");
    console.log("📋 Common Sanctioned Countries:");
    console.log("   156 - China");
    console.log("   643 - Russia");
    console.log("   850 - North Korea");
    console.log("   364 - Iran");
    console.log("   760 - Syria");
    console.log("");
    console.log("💡 After deployment, only governance can update these rules");
    console.log("");

    // Ask for allowed countries (whitelist)
    const allowedInput = await mod.promptUser(
      "Enter ALLOWED countries (whitelist, comma-separated, or press Enter for none): ",
    );
    let allowedCountries = [];

    if (allowedInput.trim() !== "") {
      allowedCountries = allowedInput.split(",").map((c) => parseInt(c.trim()));
      console.log(
        `   ✅ Whitelist active: Only ${allowedCountries.join(", ")} allowed`,
      );
    } else {
      console.log(
        "   ℹ️  No whitelist: All countries allowed (except blocked)",
      );
    }

    // Ask for blocked countries (blacklist)
    const blockedInput = await mod.promptUser(
      "Enter BLOCKED countries (blacklist, comma-separated, or press Enter for default): ",
    );
    let blockedCountries;

    if (blockedInput.trim() === "") {
      // Default: Block sanctioned countries
      blockedCountries = [156, 643, 850, 364, 760];
      console.log(
        "   ✅ Using default blacklist: China, Russia, North Korea, Iran, Syria",
      );
    } else {
      blockedCountries = blockedInput.split(",").map((c) => parseInt(c.trim()));
      console.log(`   ✅ Blacklist: ${blockedCountries.join(", ")}`);
    }

    console.log("\n📊 Final Configuration:");
    if (allowedCountries.length > 0) {
      console.log(
        `   ✅ Whitelist: ${allowedCountries.join(", ")} (ONLY these allowed)`,
      );
    } else {
      console.log(
        "   ℹ️  Whitelist: None (all countries allowed except blocked)",
      );
    }
    console.log(
      `   ❌ Blacklist: ${blockedCountries.join(", ")} (ALWAYS blocked)`,
    );

    // Deploy with user-provided configuration
    await mod.deployer.deployComplianceRulesWithConfig(
      allowedCountries,
      blockedCountries,
    );

    console.log("\n🎉 COMPLIANCE RULES CONTRACT DEPLOYED SUCCESSFULLY!");
    console.log("📋 Features Available:");
    console.log("   • Jurisdiction rules applied on every transfer and mint");
    console.log("   • Blacklist/whitelist oracle and ZK whitelist gates");
    console.log("   • Trusted contracts (escrow, governance)");
    console.log("   • Governance-controlled updates");
    console.log(
      "   (Investor-type limits live in InvestorTypeRegistry: options 15-17)",
    );
  } catch (error) {
    displayError(`ComplianceRules deployment failed: ${error.message}`);
  }
}

/**
 * Option 14: Configure jurisdiction rules
 *
 * @returns {Promise<void>}
 *
 * @example
 * await module.configureJurisdictionRules();
 */
async function configureJurisdictionRules(mod) {
  console.log("\n🌍 CONFIGURE JURISDICTION RULES");
  console.log("=".repeat(50));

  const complianceRules = mod.state.getContract("complianceRules");
  if (!complianceRules) {
    console.log("ℹ️  ComplianceRules contract not deployed!");
    console.log("💡 Please deploy ComplianceRules first using option 13");
    return;
  }

  try {
    // Use the ERC-3643 Digital Token for compliance testing
    const token = mod.state.getContract("digitalToken");
    if (!token) {
      console.log("ℹ️  Token not deployed!");
      console.log("💡 Please deploy contracts first using option 1");
      return;
    }
    const tokenAddress = await token.getAddress();

    console.log("\n🌍 Setting up jurisdiction rules for Digital Token...");
    console.log(`📦 Token: ${tokenAddress}`);

    // ⚠️ SHOW CURRENT RULES FIRST
    console.log("\n📊 CURRENT JURISDICTION RULES:");
    console.log("=".repeat(50));

    let currentAllowed = [];
    let currentBlocked = [];

    try {
      const currentRule =
        await complianceRules.getJurisdictionRule(tokenAddress);
      currentAllowed = currentRule.allowedCountries.map((c) => Number(c));
      currentBlocked = currentRule.blockedCountries.map((c) => Number(c));

      console.log("\n✅ Current WHITELIST (Allowed Countries):");
      if (currentAllowed.length === 0) {
        console.log(
          "   ℹ️  No whitelist - All countries allowed (except blocked)",
        );
      } else {
        console.log(`   📊 Total: ${currentAllowed.length} countries`);
        console.log(`   📋 Countries: ${currentAllowed.join(", ")}`);
      }

      console.log("\n🚫 Current BLACKLIST (Blocked Countries):");
      if (currentBlocked.length === 0) {
        console.log("   ℹ️  No countries blocked");
      } else {
        console.log(`   📊 Total: ${currentBlocked.length} countries`);
        console.log(`   📋 Countries: ${currentBlocked.join(", ")}`);
      }
    } catch (error) {
      console.log("   ℹ️  No current rules found (first time setup)");
    }

    // Interactive management menu
    console.log("\n🔧 JURISDICTION RULES MANAGEMENT:");
    console.log("=".repeat(50));
    console.log("1. ➕ Add countries to whitelist");
    console.log("2. ➖ Remove countries from whitelist");
    console.log("3. ➕ Add countries to blacklist");
    console.log("4. ➖ Remove countries from blacklist");
    console.log("5. 🔄 Replace all rules (complete reset)");
    console.log("6. ❌ Cancel");
    console.log("");

    const action = await mod.promptUser("Select action (1-6): ");

    let allowedArray = [...currentAllowed];
    let blockedArray = [...currentBlocked];

    switch (action.trim()) {
      case "1": // Add to whitelist
        console.log("\n➕ ADD COUNTRIES TO WHITELIST");
        console.log(
          "   Examples: 840 (US), 826 (UK), 124 (Canada), 276 (Germany), 392 (Japan)",
        );
        const addAllowedInput = await mod.promptUser("Countries to add: ");
        if (addAllowedInput.trim()) {
          const toAdd = addAllowedInput
            .split(",")
            .map((c) => parseInt(c.trim()));
          toAdd.forEach((country) => {
            if (!allowedArray.includes(country)) {
              allowedArray.push(country);
              console.log(`   ✅ Added ${country} to whitelist`);
            } else {
              console.log(`   ℹ️  ${country} already in whitelist`);
            }
          });
        }
        break;

      case "2": // Remove from whitelist
        console.log("\n➖ REMOVE COUNTRIES FROM WHITELIST");
        console.log(`   Current whitelist: ${allowedArray.join(", ")}`);
        const removeAllowedInput = await mod.promptUser(
          "Countries to remove: ",
        );
        if (removeAllowedInput.trim()) {
          const toRemove = removeAllowedInput
            .split(",")
            .map((c) => parseInt(c.trim()));
          toRemove.forEach((country) => {
            const index = allowedArray.indexOf(country);
            if (index > -1) {
              allowedArray.splice(index, 1);
              console.log(`   ✅ Removed ${country} from whitelist`);
            } else {
              console.log(`   ℹ️  ${country} not in whitelist`);
            }
          });
        }
        break;

      case "3": // Add to blacklist
        console.log("\n➕ ADD COUNTRIES TO BLACKLIST");
        console.log(
          "   Examples: 643 (Russia), 156 (China), 850 (North Korea), 364 (Iran), 760 (Syria)",
        );
        const addBlockedInput = await mod.promptUser("Countries to add: ");
        if (addBlockedInput.trim()) {
          const toAdd = addBlockedInput
            .split(",")
            .map((c) => parseInt(c.trim()));
          toAdd.forEach((country) => {
            if (!blockedArray.includes(country)) {
              blockedArray.push(country);
              console.log(`   ✅ Added ${country} to blacklist`);
            } else {
              console.log(`   ℹ️  ${country} already in blacklist`);
            }
          });
        }
        break;

      case "4": // Remove from blacklist
        console.log("\n➖ REMOVE COUNTRIES FROM BLACKLIST");
        console.log(`   Current blacklist: ${blockedArray.join(", ")}`);
        const removeBlockedInput = await mod.promptUser(
          "Countries to remove: ",
        );
        if (removeBlockedInput.trim()) {
          const toRemove = removeBlockedInput
            .split(",")
            .map((c) => parseInt(c.trim()));
          toRemove.forEach((country) => {
            const index = blockedArray.indexOf(country);
            if (index > -1) {
              blockedArray.splice(index, 1);
              console.log(`   ✅ Removed ${country} from blacklist`);
            } else {
              console.log(`   ℹ️  ${country} not in blacklist`);
            }
          });
        }
        break;

      case "5": // Replace all
        console.log("\n🔄 REPLACE ALL RULES (COMPLETE RESET)");
        console.log("⚠️  This will completely replace current rules!");
        console.log("\n📋 Configure NEW allowed countries (comma-separated):");
        console.log(
          "   Examples: 840 (US), 826 (UK), 124 (Canada), 276 (Germany), 392 (Japan)",
        );
        console.log("   💡 Leave empty for no whitelist");
        const newAllowedInput = await mod.promptUser("Allowed countries: ");
        allowedArray = newAllowedInput.trim()
          ? newAllowedInput.split(",").map((c) => parseInt(c.trim()))
          : [];

        console.log("\n📋 Configure NEW blocked countries (comma-separated):");
        console.log(
          "   Examples: 643 (Russia), 156 (China), 850 (North Korea), 364 (Iran), 760 (Syria)",
        );
        console.log("   💡 Leave empty for no blacklist");
        const newBlockedInput = await mod.promptUser("Blocked countries: ");
        blockedArray = newBlockedInput.trim()
          ? newBlockedInput.split(",").map((c) => parseInt(c.trim()))
          : [];
        break;

      case "6": // Cancel
        console.log("\nℹ️  Operation cancelled");
        return;

      default:
        console.log("\n❌ Invalid option. Operation cancelled.");
        return;
    }

    // Set jurisdiction rules
    console.log("\n📝 UPDATING JURISDICTION RULES...");
    console.log(`🔍 DEBUG - Writing to blockchain:`);
    console.log(`   Token: ${tokenAddress}`);
    console.log(`   Allowed: [${allowedArray.join(", ")}]`);
    console.log(`   Blocked: [${blockedArray.join(", ")}]`);

    const tx = await complianceRules
      .connect(mod.state.signers[0])
      .setJurisdictionRule(tokenAddress, allowedArray, blockedArray);
    const receipt = await tx.wait();

    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    console.log("\n✅ JURISDICTION RULES UPDATED SUCCESSFULLY!");
    console.log("=".repeat(50));
    console.log("\n📊 NEW CONFIGURATION:");
    console.log(
      `   ✅ Whitelist (${allowedArray.length} countries): ${allowedArray.length > 0 ? allowedArray.join(", ") : "None (all allowed except blocked)"}`,
    );
    console.log(
      `   ❌ Blacklist (${blockedArray.length} countries): ${blockedArray.length > 0 ? blockedArray.join(", ") : "None"}`,
    );
    console.log(`\n🔗 Transaction: ${receipt.hash}`);
    console.log(`🧱 Block: ${receipt.blockNumber}`);
    console.log(`⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

    // Test the rules
    console.log("\n🧪 Testing jurisdiction validation...");
    for (const country of allowedArray.slice(0, 2)) {
      const [isValid, reason] = await complianceRules.validateJurisdiction(
        tokenAddress,
        country,
      );
      console.log(
        `   Country ${country}: ${isValid ? "✅ ALLOWED" : "❌ BLOCKED"} - ${reason}`,
      );
    }
    for (const country of blockedArray.slice(0, 2)) {
      const [isValid, reason] = await complianceRules.validateJurisdiction(
        tokenAddress,
        country,
      );
      console.log(
        `   Country ${country}: ${isValid ? "✅ ALLOWED" : "❌ BLOCKED"} - ${reason}`,
      );
    }
  } catch (error) {
    console.error("❌ Jurisdiction rules configuration failed:", error.message);
  }
}

module.exports = {
  deployComplianceRules,
  configureJurisdictionRules,
};
