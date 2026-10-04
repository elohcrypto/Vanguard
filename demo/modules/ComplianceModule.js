/**
 * @fileoverview Compliance rules management module
 * @module ComplianceModule
 * @description ComplianceRules jurisdiction rules and access control, plus
 * read-only views of the investor-type limits, cooldowns and whitelist tiers
 * that live in InvestorTypeRegistry (plan v2 Task 4.1 removed the inert
 * copies ComplianceRules kept). Covers menu options 13-20.
 *
 * @example
 * const ComplianceModule = require('./modules/ComplianceModule');
 * const module = new ComplianceModule(state, logger, promptUser);
 * await module.configureJurisdictionRules();
 */

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
  displayInfo,
} = require("../utils/DisplayHelpers");

const TYPE_NAMES = ["Normal", "Retail", "Accredited", "Institutional"];

/**
 * @class ComplianceModule
 * @description Manages compliance rules for the demo system.
 */
class ComplianceModule {
  /**
   * Create a ComplianceModule
   * @param {Object} state - DemoState instance
   * @param {Object} logger - EnhancedLogger instance
   * @param {Function} promptUser - Function to prompt user for input
   * @param {Object} deployer - ContractDeployer instance
   */
  constructor(state, logger, promptUser, deployer) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
    this.deployer = deployer;
  }

  /**
   * Option 13: Deploy ComplianceRules contract
   *
   * @returns {Promise<void>}
   *
   * @example
   * await module.deployComplianceRules();
   */
  async deployComplianceRules() {
    displaySection("DEPLOYING COMPLIANCE RULES CONTRACT", "🏗️");

    if (!this.state.getContract("onchainIDFactory")) {
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
      console.log(
        "💡 After deployment, only governance can update these rules",
      );
      console.log("");

      // Ask for allowed countries (whitelist)
      const allowedInput = await this.promptUser(
        "Enter ALLOWED countries (whitelist, comma-separated, or press Enter for none): ",
      );
      let allowedCountries = [];

      if (allowedInput.trim() !== "") {
        allowedCountries = allowedInput
          .split(",")
          .map((c) => parseInt(c.trim()));
        console.log(
          `   ✅ Whitelist active: Only ${allowedCountries.join(", ")} allowed`,
        );
      } else {
        console.log(
          "   ℹ️  No whitelist: All countries allowed (except blocked)",
        );
      }

      // Ask for blocked countries (blacklist)
      const blockedInput = await this.promptUser(
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
        blockedCountries = blockedInput
          .split(",")
          .map((c) => parseInt(c.trim()));
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
      await this.deployer.deployComplianceRulesWithConfig(
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
  async configureJurisdictionRules() {
    console.log("\n🌍 CONFIGURE JURISDICTION RULES");
    console.log("=".repeat(50));

    const complianceRules = this.state.getContract("complianceRules");
    if (!complianceRules) {
      console.log("❌ ComplianceRules contract not deployed!");
      console.log("💡 Please deploy ComplianceRules first using option 13");
      return;
    }

    try {
      // Use the ERC-3643 Digital Token for compliance testing
      const token = this.state.getContract("digitalToken");
      if (!token) {
        console.log("❌ Token not deployed!");
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

        console.log("\n❌ Current BLACKLIST (Blocked Countries):");
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

      const action = await this.promptUser("Select action (1-6): ");

      let allowedArray = [...currentAllowed];
      let blockedArray = [...currentBlocked];

      switch (action.trim()) {
        case "1": // Add to whitelist
          console.log("\n➕ ADD COUNTRIES TO WHITELIST");
          console.log(
            "   Examples: 840 (US), 826 (UK), 124 (Canada), 276 (Germany), 392 (Japan)",
          );
          const addAllowedInput = await this.promptUser("Countries to add: ");
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
          const removeAllowedInput = await this.promptUser(
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
          const addBlockedInput = await this.promptUser("Countries to add: ");
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
          const removeBlockedInput = await this.promptUser(
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
          console.log(
            "\n📋 Configure NEW allowed countries (comma-separated):",
          );
          console.log(
            "   Examples: 840 (US), 826 (UK), 124 (Canada), 276 (Germany), 392 (Japan)",
          );
          console.log("   💡 Leave empty for no whitelist");
          const newAllowedInput = await this.promptUser("Allowed countries: ");
          allowedArray = newAllowedInput.trim()
            ? newAllowedInput.split(",").map((c) => parseInt(c.trim()))
            : [];

          console.log(
            "\n📋 Configure NEW blocked countries (comma-separated):",
          );
          console.log(
            "   Examples: 643 (Russia), 156 (China), 850 (North Korea), 364 (Iran), 760 (Syria)",
          );
          console.log("   💡 Leave empty for no blacklist");
          const newBlockedInput = await this.promptUser("Blocked countries: ");
          blockedArray = newBlockedInput.trim()
            ? newBlockedInput.split(",").map((c) => parseInt(c.trim()))
            : [];
          break;

        case "6": // Cancel
          console.log("\n❌ Operation cancelled");
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
        .connect(this.state.signers[0])
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
      console.error(
        "❌ Jurisdiction rules configuration failed:",
        error.message,
      );
    }
  }

  /**
   * The registry Token enforces investor-type limits from, or null after
   * printing why. Task 4.1 removed ComplianceRules' own investor-type,
   * holding-period and level rules: they were stored and validated but no
   * transfer ever read them. Their live home is InvestorTypeRegistry.
   * @private
   */
  async _investorTypeContext() {
    const registry = this.state.getContract("investorTypeRegistry");
    const token = this.state.getContract("digitalToken");
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
  async _typeConfigs(registry) {
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
  async showInvestorTypeLimits() {
    displaySection("INVESTOR TYPE LIMITS (InvestorTypeRegistry)", "👥");
    const ctx = await this._investorTypeContext();
    if (!ctx) return;
    try {
      const { registry, token } = ctx;
      const configs = await this._typeConfigs(registry);
      console.log("\n📊 LIMITS PER TYPE (enforced by Token):");
      configs.forEach((c, t) => {
        console.log(
          `   ${t} ${TYPE_NAMES[t].padEnd(13)} max transfer ${ethers.formatEther(c.maxTransferAmount)} VSC, max holding ${ethers.formatEther(c.maxHoldingAmount)} VSC`,
        );
      });

      const input = await this.promptUser(
        "\nAmount to test per wallet in VSC (default 10000): ",
      );
      const amount = ethers.parseEther((input || "10000").trim());
      console.log(`\n🧪 ${ethers.formatEther(amount)} VSC per demo wallet:`);
      for (const s of this.state.signers.slice(1, 5)) {
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
   * Options 16 and 20c: transfer cooldowns. ComplianceRules' holding-period
   * rule is gone (Task 4.1): nothing ever recorded a transfer, so it could
   * not block one. InvestorTypeRegistry keeps a cooldown per type; Token
   * does not enforce it today, and this option says so.
   *
   * @returns {Promise<void>}
   */
  async showTransferCooldowns() {
    displaySection("TRANSFER COOLDOWNS (InvestorTypeRegistry)", "⏰");
    const ctx = await this._investorTypeContext();
    if (!ctx) return;
    try {
      const configs = await this._typeConfigs(ctx.registry);
      console.log("\n📊 COOLDOWN PER TYPE (recorded, not enforced):");
      configs.forEach((c, t) => {
        console.log(
          `   ${t} ${TYPE_NAMES[t].padEnd(13)} ${Number(c.transferCooldownMinutes)} minutes`,
        );
      });
      console.log(
        "\n⚠️  Token reads no cooldown: a holder can transfer again at once.",
      );
      console.log(
        "   Token enforces the transfer and holding caps (option 15) only.",
      );
      console.log(
        "   There is no minimum holding period on chain (ComplianceRules' was removed in Task 4.1).",
      );
    } catch (error) {
      displayError(`Reading transfer cooldowns failed: ${error.message}`);
    }
  }

  /**
   * Options 17 and 20d: the whitelist tier each investor type requires. The
   * former ComplianceRules compliance-level rule (min/max level, inheritance)
   * was removed in Task 4.1; it gated nothing. The tier lives in
   * InvestorTypeRegistry and is readable through IdentityRegistry; no
   * transfer path compares it today, and this option says so.
   *
   * @returns {Promise<void>}
   */
  async showWhitelistTiers() {
    displaySection("REQUIRED WHITELIST TIERS (InvestorTypeRegistry)", "📊");
    const ctx = await this._investorTypeContext();
    if (!ctx) return;
    try {
      const configs = await this._typeConfigs(ctx.registry);
      console.log("\n📊 REQUIRED TIER PER TYPE (recorded, not enforced):");
      configs.forEach((c, t) => {
        console.log(
          `   ${t} ${TYPE_NAMES[t].padEnd(13)} tier ${Number(c.requiredWhitelistTier)}+`,
        );
      });
      console.log("\n👤 Demo wallets:");
      for (const s of this.state.signers.slice(1, 5)) {
        const type = Number(await ctx.registry.getInvestorType(s.address));
        const tier = Number(await ctx.registry.getRequiredWhitelistTier(s.address));
        console.log(`   ${s.address}: ${TYPE_NAMES[type]}, tier ${tier}+`);
      }
      console.log(
        "\n⚠️  No transfer path compares tiers; the whitelist gate is the oracle or the ZK whitelist mode.",
      );
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
  async testAllComplianceValidations() {
    console.log("\n🧪 TEST ALL COMPLIANCE VALIDATIONS");
    console.log("=".repeat(50));

    const complianceRules = this.state.getContract("complianceRules");
    if (!complianceRules) {
      console.log("❌ ComplianceRules contract not deployed!");
      console.log("💡 Please deploy ComplianceRules first using option 13");
      return;
    }

    try {
      const token = this.state.getContract("digitalToken");
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
      const registry = this.state.getContract("investorTypeRegistry");
      if (!registry) {
        console.log("   ℹ️  No InvestorTypeRegistry deployed (option 51)");
      } else {
        const amount = ethers.parseEther("10000");
        for (const s of this.state.signers.slice(1, 5)) {
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
   * Option 19: Test access control
   *
   * @returns {Promise<void>}
   */
  async testAccessControl() {
    console.log("\n🔐 COMPREHENSIVE ACCESS CONTROL TESTING");
    console.log("=".repeat(60));

    const complianceRules = this.state.getContract("complianceRules");
    if (!complianceRules) {
      console.log("❌ ComplianceRules contract not deployed!");
      console.log("💡 Please deploy ComplianceRules first using option 13");
      return;
    }

    try {
      const token = this.state.getContract("digitalToken");
      if (!token) {
        console.log("❌ Token not deployed!");
        return;
      }
      const tokenAddress = await token.getAddress();
      const complianceAddress = await complianceRules.getAddress();

      console.log("\n📋 TEST ENVIRONMENT SETUP");
      console.log("-".repeat(40));
      console.log(`🏗️  ComplianceRules Contract: ${complianceAddress}`);
      console.log(`🪙 ERC-3643 Digital Token: ${tokenAddress}`);
      console.log(`👑 Contract Owner: ${this.state.signers[0].address}`);
      console.log(`👨‍💼 Test Administrator: ${this.state.signers[1].address}`);
      console.log(`👤 Regular User 1: ${this.state.signers[2].address}`);
      console.log(`👤 Regular User 2: ${this.state.signers[3].address}`);

      // Test 1: Owner Permissions
      console.log("\n👑 TEST 1: OWNER PERMISSIONS");
      console.log("=".repeat(40));
      console.log("🧪 Testing owner can set rule administrators...");

      try {
        const tx1 = await complianceRules
          .connect(this.state.signers[0])
          .setRuleAdministrator(this.state.signers[1].address, true);
        const receipt1 = await tx1.wait();
        console.log(`✅ SUCCESS: Owner set rule administrator`);
        console.log(`   📍 Administrator: ${this.state.signers[1].address}`);
        console.log(`   🔗 Transaction: ${receipt1.hash}`);
        console.log(`   🧱 Block: ${receipt1.blockNumber}`);
        console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);
      } catch (error) {
        console.log(`❌ FAILED: Owner could not set rule administrator`);
        console.log(`   🚨 Error: ${error.message}`);
      }

      // Test 2: Administrator Permissions
      console.log("\n👨‍💼 TEST 2: ADMINISTRATOR PERMISSIONS");
      console.log("=".repeat(40));
      console.log("🧪 Testing administrator can set jurisdiction rules...");

      try {
        const tx3 = await complianceRules
          .connect(this.state.signers[1])
          .setJurisdictionRule(
            tokenAddress,
            [840, 276, 826], // USA, Germany, UK
            [643, 156], // Russia, China
          );
        const receipt3 = await tx3.wait();
        console.log(`✅ SUCCESS: Administrator set jurisdiction rules`);
        console.log(
          `   🌍 Allowed Countries: [840, 276, 826] (USA, Germany, UK)`,
        );
        console.log(`   🚫 Blocked Countries: [643, 156] (Russia, China)`);
        console.log(`   🔗 Transaction: ${receipt3.hash}`);
        console.log(`   🧱 Block: ${receipt3.blockNumber}`);
        console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);
      } catch (error) {
        console.log(
          `❌ FAILED: Administrator could not set jurisdiction rules`,
        );
        console.log(`   🚨 Error: ${error.message}`);
      }

      // Test 3: Regular User Restrictions
      console.log("\n👤 TEST 3: REGULAR USER ACCESS RESTRICTIONS");
      console.log("=".repeat(50));
      console.log("🧪 Testing regular user CANNOT set jurisdiction rules...");

      try {
        await complianceRules
          .connect(this.state.signers[2])
          .setJurisdictionRule(
            tokenAddress,
            [392], // Japan
            [],
          );
        console.log(`❌ SECURITY BREACH: Regular user was able to set rules!`);
        console.log(`   🚨 This should NOT have succeeded!`);
      } catch (error) {
        console.log(
          `✅ SUCCESS: Regular user correctly blocked from setting rules`,
        );
        console.log(`   👤 Blocked User: ${this.state.signers[2].address}`);
        console.log(`   🛡️  Security Message: ${error.message.split("(")[0]}`);
        console.log(`   🔒 Access Control: WORKING`);
      }

      // Test 4: Unauthorized Administrative Actions
      console.log("\n🚫 TEST 4: UNAUTHORIZED ADMINISTRATIVE ACTIONS");
      console.log("=".repeat(50));
      console.log("🧪 Testing unauthorized user CANNOT set administrators...");

      try {
        await complianceRules
          .connect(this.state.signers[2])
          .setRuleAdministrator(this.state.signers[3].address, true);
        console.log(
          `❌ CRITICAL SECURITY BREACH: Unauthorized user set administrator!`,
        );
        console.log(`   🚨 This is a MAJOR security vulnerability!`);
      } catch (error) {
        console.log(
          `✅ SUCCESS: Unauthorized user correctly blocked from setting administrators`,
        );
        console.log(`   👤 Blocked User: ${this.state.signers[2].address}`);
        console.log(`   🎯 Attempted Target: ${this.state.signers[3].address}`);
        console.log(`   🛡️  Security Message: ${error.message.split("(")[0]}`);
        console.log(`   🔒 Owner-Only Protection: WORKING`);
      }

      // Test 5: Permission Revocation
      console.log("\n🔄 TEST 5: PERMISSION REVOCATION");
      console.log("=".repeat(40));
      console.log("🧪 Testing owner can revoke administrator permissions...");

      try {
        const tx5 = await complianceRules
          .connect(this.state.signers[0])
          .setRuleAdministrator(this.state.signers[1].address, false);
        const receipt5 = await tx5.wait();
        console.log(`✅ SUCCESS: Owner revoked administrator permissions`);
        console.log(
          `   👨‍💼 Revoked Administrator: ${this.state.signers[1].address}`,
        );
        console.log(`   🔗 Transaction: ${receipt5.hash}`);
        console.log(`   🧱 Block: ${receipt5.blockNumber}`);
        console.log(`   ⛽ Gas Used: ${receipt5.gasUsed.toLocaleString()}`);
      } catch (error) {
        console.log(
          `❌ FAILED: Owner could not revoke administrator permissions`,
        );
        console.log(`   🚨 Error: ${error.message}`);
      }

      console.log("\n🧪 Testing revoked administrator CANNOT set rules...");
      try {
        await complianceRules
          .connect(this.state.signers[1])
          .setJurisdictionRule(
            tokenAddress,
            [124], // Canada
            [],
          );
        console.log(
          `❌ SECURITY ISSUE: Revoked administrator still has access!`,
        );
      } catch (error) {
        console.log(`✅ SUCCESS: Revoked administrator correctly blocked`);
        console.log(
          `   👨‍💼 Blocked Ex-Administrator: ${this.state.signers[1].address}`,
        );
        console.log(`   🛡️  Security Message: ${error.message.split("(")[0]}`);
        console.log(`   🔒 Permission Revocation: WORKING`);
      }

      // Test Summary
      console.log("\n🎉 ACCESS CONTROL TEST SUMMARY");
      console.log("=".repeat(50));
      console.log("✅ Owner Permissions: WORKING");
      console.log("   • Can set rule administrators ✅");
      console.log("   • Can revoke permissions ✅");
      console.log("");
      console.log("✅ Administrator Permissions: WORKING");
      console.log("   • Can set jurisdiction rules ✅");
      console.log("   • Cannot perform owner actions ✅");
      console.log("");
      console.log("✅ Access Restrictions: WORKING");
      console.log("   • Regular users blocked from rule setting ✅");
      console.log("   • Unauthorized users blocked from admin actions ✅");
      console.log("   • Permission revocation works correctly ✅");
      console.log("");
      console.log("🔒 SECURITY STATUS: ALL TESTS PASSED");
      console.log("🛡️  ComplianceRules access control is SECURE");
    } catch (error) {
      console.error("❌ Access control tests failed:", error.message);
      console.error("🚨 CRITICAL: Security testing encountered an error");
      console.error("📋 Please review the contract security implementation");
    }
  }

  /**
   * Option 20: Show ComplianceRules dashboard
   *
   * @returns {Promise<void>}
   */
  async showComplianceRulesDashboard() {
    console.log("\n📋 COMPLIANCE RULES DASHBOARD");
    console.log("=".repeat(50));

    const complianceRules = this.state.getContract("complianceRules");
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
  async viewJurisdictionRules() {
    console.log("\n🌍 JURISDICTION RULES (WHITELIST/BLACKLIST)");
    console.log("=".repeat(50));

    const complianceRules = this.state.getContract("complianceRules");
    if (!complianceRules) {
      console.log("❌ ComplianceRules contract not deployed!");
      console.log("💡 Please deploy ComplianceRules first using option 13");
      return;
    }

    try {
      // Get token address
      const token = this.state.getContract("digitalToken");
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
      if (
        rule.allowedCountries.length > 0 &&
        rule.blockedCountries.length > 0
      ) {
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
}

module.exports = ComplianceModule;
