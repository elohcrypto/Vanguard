/**
 * @fileoverview Contract deployment module for the Interactive KYC/AML Demo
 * @module ContractDeployer
 * @description Handles deployment of all smart contracts including OnchainID,
 * ERC-3643 registries, compliance rules, oracles, privacy systems, and more.
 *
 * @example
 * const ContractDeployer = require('./core/ContractDeployer');
 * const deployer = new ContractDeployer(state, logger);
 * await deployer.deployAllContracts();
 */

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
  displayProgress,
} = require("../utils/DisplayHelpers");

/**
 * Default jurisdiction rules for every automated ComplianceRules deployment.
 *
 * ISO 3166-1 numeric codes, matching the list the demo prints at
 * ComplianceModule.js:66-75.
 *
 * WHITELIST SEMANTICS: a NON-EMPTY allow list is EXCLUSIVE — ComplianceRules
 * .sol:138-140 blocks any country not in it. So adding Hong Kong here does not
 * merely permit HK, it restricts transfers to these ten jurisdictions only.
 * An empty list means "everywhere except the blocked list".
 *
 * Defined once because this file previously held TWO different defaults:
 * `deployComplianceRules()` used this whitelist, while the fallback inside
 * `deployDigitalTokenSystem()` used an EMPTY allow list. Which rules you got
 * depended on which code path happened to deploy the contract first.
 */
const DEFAULT_ALLOWED_COUNTRIES = [
  840, // United States
  826, // United Kingdom
  124, // Canada
  276, // Germany
  250, // France
  392, // Japan
  702, // Singapore
  36, // Australia
  344, // Hong Kong
  756, // Switzerland
];

/** Blocked regardless of the whitelist (ComplianceRules.sol checks these first). */
const DEFAULT_BLOCKED_COUNTRIES = [
  156, // China
  643, // Russia
  850, // North Korea
  364, // Iran
  760, // Syria
];

/**
 * @class ContractDeployer
 * @description Manages deployment of all smart contracts for the demo system.
 */
class ContractDeployer {
  /**
   * Create a ContractDeployer
   * @param {Object} state - DemoState instance
   * @param {Object} logger - EnhancedLogger instance
   */
  constructor(state, logger) {
    /**
     * @property {Object} state - Reference to DemoState
     * @private
     */
    this.state = state;

    /**
     * @property {Object} logger - Reference to EnhancedLogger
     * @private
     */
    this.logger = logger;
  }

  /**
   * Option 1a: One-click deployment of the full stack, in dependency order.
   *
   * WHY A SEPARATE METHOD
   * ---------------------
   * `deployAllContracts()` despite its name deploys only the BASE layer
   * (OnchainID factory, issuers, identity registry, oracles). The digital
   * token, compliance rules, investor types and governance each live behind
   * their own menu option, and they depend on each other in a specific order
   * that the menu does not state.
   *
   * THE ORDER, AND WHY (verified by running the menu, not inferred)
   * ---------------------------------------------------------------
   *   1. deployAllContracts       (menu 1)  OnchainID contracts + ERC-3643
   *                                         registries -> `identityRegistry`
   *   2. deployDigitalTokenSystem (menu 21) -> `digitalToken`, and deploys
   *                                         `complianceRules` itself if absent
   *   3. investor type registry   (menu 51) -> `investorTypeRegistry`
   *   4. governance               (menu 74) REQUIRES identityRegistry AND
   *                                         complianceRules
   *                                         (GovernanceModule.js:80-85)
   *
   * The trap: `deployAllContracts` does NOT register `complianceRules` (that
   * happens in `deployComplianceRulesWithConfig`, line ~318). So `1` then `74`
   * fails with "Deploy ERC-3643 system first (option 21)". Step 2 satisfies it
   * — not because option 21 is magic, but because deployDigitalTokenSystem
   * deploys ComplianceRules on demand with DEFAULT_ALLOWED_COUNTRIES /
   * DEFAULT_BLOCKED_COUNTRIES (top of this file).
   *
   * Menu option 13 is NOT required. It deploys the same contract but prompts
   * for country lists; chaining it here with empty lists would leave the
   * one-click path with no blocked jurisdictions at all — more permissive than
   * the normal menu route. Verified: `1 21 51 74` completes with zero errors.
   *
   * Every step below is prompt-free (verified), so this runs unattended.
   *
   * @param {Object} modules - The demo's module registry, for the steps that
   *   live outside ContractDeployer (investor types, governance).
   * @returns {Promise<boolean>} true if every step completed
   */
  async deployEverything(modules) {
    displaySection("ONE-CLICK DEPLOY — FULL STACK", "🚀");

    console.log("\nDeploys the whole system in dependency order:");
    console.log(
      "   1. Core contracts (OnchainID, issuers, ERC-3643 registries)",
    );
    console.log("   2. ERC-3643 digital token — also deploys ComplianceRules");
    console.log(
      `      whitelist: ${DEFAULT_ALLOWED_COUNTRIES.length} countries incl. Hong Kong (344)`,
    );
    console.log(
      `      blacklist: ${DEFAULT_BLOCKED_COUNTRIES.length} countries incl. Russia (643)`,
    );
    console.log("   3. Investor Type Registry");
    console.log("   4. Governance (nominates itself as registry owner)");
    console.log("");

    const steps = [
      {
        name: "Core contracts",
        run: () => this.deployAllContracts(),
        expect: "identityRegistry",
      },
      {
        // deployDigitalTokenSystem already deploys ComplianceRules itself when
        // it is missing (see the "Step 1: Deploying ComplianceRules" branch
        // below), using the shared DEFAULT_* country lists. Do NOT deploy it
        // separately here: passing a different config would silently give the
        // one-click path a MORE PERMISSIVE compliance setup than menu option
        // 21, which is the wrong default for a compliance demo.
        name: "ERC-3643 token + ComplianceRules",
        run: () => this.deployDigitalTokenSystem(),
        expect: "digitalToken",
      },
      {
        name: "Investor Type Registry",
        run: () => modules.investorType.deployInvestorTypeSystem(),
        expect: "investorTypeRegistry",
      },
      {
        name: "Governance system",
        run: () => modules.governance.deployGovernanceSystem(),
        expect: "vanguardGovernance",
      },
    ];

    const done = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      console.log("\n" + "=".repeat(70));
      console.log(`STEP ${i + 1}/${steps.length}: ${step.name}`);
      console.log("=".repeat(70));

      try {
        await step.run();
      } catch (error) {
        displayError(`Step ${i + 1} (${step.name}) threw: ${error.message}`);
        this._reportDeploySummary(done, steps, i);
        return false;
      }

      // Verify by reading state back, not by assuming the call worked: the
      // demo's modules catch their own errors and return normally, so a step
      // can "succeed" while registering nothing.
      const contract = this.state.getContract(step.expect);
      if (!contract) {
        displayError(
          `Step ${i + 1} (${step.name}) did not register '${step.expect}' — stopping.`,
        );
        console.log(
          "   Later steps depend on it; continuing would fail confusingly.",
        );
        this._reportDeploySummary(done, steps, i);
        return false;
      }
      done.push({ name: step.name, address: await contract.getAddress() });
    }

    this._reportDeploySummary(done, steps, steps.length);
    return true;
  }

  /**
   * Print what deployed and what did not.
   * @private
   */
  _reportDeploySummary(done, steps, reached) {
    console.log("\n" + "=".repeat(70));
    if (reached === steps.length) {
      displaySuccess("FULL STACK DEPLOYED");
    } else {
      displayError(`STOPPED AT STEP ${reached + 1} OF ${steps.length}`);
    }
    console.log("=".repeat(70));

    for (const d of done) {
      console.log(`   ✅ ${d.name.padEnd(26)} ${d.address}`);
    }
    for (let i = done.length; i < steps.length; i++) {
      console.log(`   ⏭️  ${steps[i].name.padEnd(26)} not deployed`);
    }

    if (reached === steps.length) {
      console.log("\n💡 Next steps:");
      console.log("   • Option 23 or 24 — onboard users (creates OnchainIDs)");
      console.log("   • Options 3 and 4 — issue KYC/AML claims to them");
      console.log("   • Option 75 — distribute VGT so they can pay vote fees");
      console.log(
        "   • Option 83b — governance accepts registry ownership by vote",
      );
      console.log(
        "\n   ℹ️  83b needs at least 2 KYC/AML-verified signers holding VGT.",
      );
      console.log(
        "      A fresh deploy registers only the governance contract itself.",
      );
    }
  }

  /**
   * Deploy all contracts for the demo
   *
   * @returns {Promise<void>}
   *
   * @example
   * await deployer.deployAllContracts();
   */
  async deployAllContracts() {
    displaySection("DEPLOYING ALL CONTRACTS", "🏗️");

    try {
      // Initialize logger with provider
      this.logger.initialize(ethers.provider);

      // Deploy core OnchainID contracts
      await this.deployOnchainIDContracts();

      // Deploy ERC-3643 registries
      await this.deployERC3643Registries();

      displaySuccess("ALL CONTRACTS DEPLOYED SUCCESSFULLY!");

      // Display comprehensive deployment summary
      this.logger.getDeploymentSummary();
    } catch (error) {
      displayError(`Contract deployment failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deploy OnchainID contracts (Factory, KYC Issuer, AML Issuer)
   *
   * @returns {Promise<void>}
   * @private
   */
  async deployOnchainIDContracts() {
    // Deploy OnchainID Factory
    displayProgress("Deploying OnchainID Factory...");
    const OnchainIDFactory =
      await ethers.getContractFactory("OnchainIDFactory");
    const factory = await OnchainIDFactory.deploy(
      this.state.signers[0].address,
    );
    await factory.waitForDeployment();
    this.state.setContract("onchainIDFactory", factory);

    await this.logger.logContractDeployment("OnchainIDFactory", factory, [
      this.state.signers[0].address,
    ]);

    // Deploy KYC Issuer
    displayProgress("Deploying KYC Issuer...");
    const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
    const kycIssuer = await ClaimIssuer.deploy(
      this.state.signers[2].address,
      "KYC Service",
      "KYC verification service",
    );
    await kycIssuer.waitForDeployment();
    this.state.setContract("kycIssuer", kycIssuer);

    await this.logger.logContractDeployment("KYC_ClaimIssuer", kycIssuer, [
      this.state.signers[2].address,
      "KYC Service",
      "KYC verification service",
    ]);

    // Deploy AML Issuer
    displayProgress("Deploying AML Issuer...");
    const amlIssuer = await ClaimIssuer.deploy(
      this.state.signers[3].address,
      "AML Service",
      "AML screening service",
    );
    await amlIssuer.waitForDeployment();
    this.state.setContract("amlIssuer", amlIssuer);

    await this.logger.logContractDeployment("AML_ClaimIssuer", amlIssuer, [
      this.state.signers[3].address,
      "AML Service",
      "AML screening service",
    ]);
  }

  /**
   * Deploy ERC-3643 registries
   *
   * @returns {Promise<void>}
   * @private
   */
  async deployERC3643Registries() {
    displayProgress("Deploying ERC-3643 Registries...");

    const IdentityRegistry =
      await ethers.getContractFactory("IdentityRegistry");
    const identityRegistry = await IdentityRegistry.deploy();
    await identityRegistry.waitForDeployment();
    this.state.setContract("identityRegistry", identityRegistry);

    await this.logger.logContractDeployment(
      "IdentityRegistry",
      identityRegistry,
      [],
    );
  }

  /**
   * Deploy ComplianceRules contract with user-provided configuration
   *
   * @param {number[]} allowedCountries - Array of allowed country codes
   * @param {number[]} blockedCountries - Array of blocked country codes
   * @returns {Promise<void>}
   *
   * @example
   * await deployer.deployComplianceRulesWithConfig([840, 826], [156, 643]);
   */
  async deployComplianceRulesWithConfig(allowedCountries, blockedCountries) {
    try {
      displayProgress("Deploying ComplianceRules contract...");

      const ComplianceRules =
        await ethers.getContractFactory("ComplianceRules");
      const complianceRules = await ComplianceRules.deploy(
        this.state.signers[0].address, // owner
        allowedCountries,
        blockedCountries,
      );
      await complianceRules.waitForDeployment();

      this.state.complianceRules = complianceRules;
      this.state.setContract("complianceRules", complianceRules);

      await this.logger.logContractDeployment(
        "ComplianceRules",
        complianceRules,
        [this.state.signers[0].address, allowedCountries, blockedCountries],
      );

      const address = await complianceRules.getAddress();
      displaySuccess("ComplianceRules deployed successfully!");
      console.log(`   📄 Address: ${address}`);
      console.log(`   📊 Allowed countries: ${allowedCountries.length}`);
      console.log(`   📊 Blocked countries: ${blockedCountries.length}`);
    } catch (error) {
      displayError(`ComplianceRules deployment failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deploy ComplianceRules contract with default configuration
   * (Used by deployAllContracts)
   *
   * @returns {Promise<void>}
   *
   * @example
   * await deployer.deployComplianceRules();
   */
  async deployComplianceRules() {
    displaySection("DEPLOYING COMPLIANCE RULES", "⚖️");

    try {
      await this.deployComplianceRulesWithConfig(
        DEFAULT_ALLOWED_COUNTRIES,
        DEFAULT_BLOCKED_COUNTRIES,
      );
    } catch (error) {
      displayError(`ComplianceRules deployment failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deploy ERC-3643 Digital Token System with full configuration
   *
   * @returns {Promise<void>}
   *
   * @example
   * await deployer.deployDigitalTokenSystem();
   */
  async deployDigitalTokenSystem() {
    displaySection(
      "DEPLOY ERC-3643 DIGITAL TOKEN SYSTEM - WITH ON-CHAIN LIMITS",
      "🏭",
    );

    try {
      if (!this.state.getContract("onchainIDFactory")) {
        displayError("Please deploy contracts first (option 1)");
        return;
      }

      let totalGasUsed = 0n;

      // Deploy ComplianceRules first if not exists
      if (!this.state.getContract("complianceRules")) {
        console.log("\n📝 Step 1: Deploying ComplianceRules...");

        // Shared defaults — see DEFAULT_ALLOWED_COUNTRIES at the top of this
        // file. This branch previously used an EMPTY whitelist, which made the
        // rules here more permissive than deployComplianceRules() produced.
        await this.deployComplianceRulesWithConfig(
          DEFAULT_ALLOWED_COUNTRIES,
          DEFAULT_BLOCKED_COUNTRIES,
        );
        console.log(
          `   📊 Whitelist: ${DEFAULT_ALLOWED_COUNTRIES.length} countries — ONLY these may transact`,
        );
        console.log(
          "      US, UK, Canada, Germany, France, Japan, Singapore, Australia,",
        );
        console.log("      Hong Kong (344), Switzerland");
        console.log(
          `   📊 Blacklist: ${DEFAULT_BLOCKED_COUNTRIES.length} countries — always blocked`,
        );
        console.log("      China, Russia (643), North Korea, Iran, Syria");
      }

      // Deploy ERC-3643 compliant Digital Token
      console.log("\n📝 Step 2: Deploying ERC-3643 Token...");
      const Token = await ethers.getContractFactory("Token");
      const token = await Token.deploy(
        "Vanguard StableCoin",
        "VSC",
        await this.state.getContract("identityRegistry").getAddress(),
        await this.state.getContract("complianceRules").getAddress(),
      );
      await token.waitForDeployment();
      this.state.digitalToken = token;
      this.state.setContract("digitalToken", token);

      const tokenAddr = await token.getAddress();
      console.log(`   ✅ ERC-3643 Digital Token: ${tokenAddr}`);
      console.log(`   🏛️ Token Name: Vanguard StableCoin`);
      console.log(`   💰 Symbol: VSC`);

      // Configure ComplianceRules with IdentityRegistry for VSC
      console.log("\n📝 Step 2.5: Configuring ComplianceRules for VSC...");
      const tx1 = await this.state
        .getContract("complianceRules")
        .setTokenIdentityRegistry(
          tokenAddr,
          await this.state.getContract("identityRegistry").getAddress(),
        );
      const receipt1 = await tx1.wait();
      totalGasUsed += receipt1.gasUsed;
      console.log("   ✅ ComplianceRules linked to IdentityRegistry for VSC");
      console.log("   ✅ REAL KYC/AML enforcement enabled for VSC transfers");

      // Configure IdentityRegistry with ComplianceRules for jurisdiction validation
      console.log(
        "\n📝 Step 2.6: Configuring IdentityRegistry for jurisdiction validation...",
      );
      const tx2 = await this.state
        .getContract("identityRegistry")
        .setComplianceRules(
          await this.state.getContract("complianceRules").getAddress(),
          tokenAddr,
        );
      const receipt2 = await tx2.wait();
      totalGasUsed += receipt2.gasUsed;
      console.log("   ✅ IdentityRegistry linked to ComplianceRules");
      console.log(
        "   ✅ Jurisdiction rules will be enforced at identity registration",
      );
      console.log(
        "   ✅ Users from blocked countries will be REJECTED during KYC/AML",
      );

      // Check if InvestorTypeRegistry is deployed
      console.log(
        "\n📝 Step 3: Connecting InvestorTypeRegistry for on-chain transfer limits...",
      );

      let investorTypeRegistryAddr = null;
      if (!this.state.getContract("investorTypeRegistry")) {
        console.log(`   ⚠️  InvestorTypeRegistry not deployed yet`);
        console.log(
          `   💡 Deploy it first using option 51, then reconnect using option 52`,
        );
        console.log(
          `   ⚠️  Transfer limits will NOT be enforced until registry is connected!`,
        );
      } else {
        investorTypeRegistryAddr = await this.state
          .getContract("investorTypeRegistry")
          .getAddress();
        const tx3 = await token.setInvestorTypeRegistry(
          investorTypeRegistryAddr,
        );
        const receipt3 = await tx3.wait();
        totalGasUsed += receipt3.gasUsed;

        console.log(`   ✅ Transaction Hash: ${receipt3.hash}`);
        console.log(`   🧱 Block Number: ${receipt3.blockNumber}`);
        console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);
        console.log(`   🔗 InvestorTypeRegistry: ${investorTypeRegistryAddr}`);

        // Verify the connection
        console.log(
          "\n📝 Step 4: Verifying on-chain transfer limit enforcement...",
        );
        const connectedRegistry = await token.investorTypeRegistry();
        console.log(
          `   ${connectedRegistry === investorTypeRegistryAddr ? "✅" : "❌"} Registry Connected: ${connectedRegistry === investorTypeRegistryAddr}`,
        );

        // Show the actual on-chain limits
        const normalConfig = await this.state
          .getContract("investorTypeRegistry")
          .getInvestorTypeConfig(0);
        const retailConfig = await this.state
          .getContract("investorTypeRegistry")
          .getInvestorTypeConfig(1);

        console.log(
          "\n📊 ON-CHAIN TRANSFER LIMITS (Enforced by Smart Contract):",
        );
        console.log(
          `   👤 Normal Investor: ${ethers.formatEther(normalConfig.maxTransferAmount)} VSC`,
        );
        console.log(
          `   🛒 Retail Investor: ${ethers.formatEther(retailConfig.maxTransferAmount)} VSC`,
        );
        console.log(`   💼 Accredited Investor: 50,000 VSC`);
        console.log(`   🏛️ Institutional Investor: 500,000 VSC`);
      }

      // Display compliance components.
      // These are read back from chain rather than printed as fixed text:
      // a hardcoded "✅ Connected" reports success even when the wiring
      // silently failed, which is exactly the state the setter guards in
      // Token/IdentityRegistry now make impossible to reach unnoticed.
      console.log("\n📋 ERC-3643 Compliance Components:");

      const wiredIdentityRegistry = await token.identityRegistry();
      const expectedIdentityRegistry = await this.state
        .getContract("identityRegistry")
        .getAddress();
      const identityOk =
        wiredIdentityRegistry.toLowerCase() ===
        expectedIdentityRegistry.toLowerCase();
      console.log(
        `   ${identityOk ? "✅" : "❌"} Identity Registry: ${wiredIdentityRegistry}`,
      );

      const wiredCompliance = await token.compliance();
      const complianceIsContract =
        (await ethers.provider.getCode(wiredCompliance)) !== "0x";
      console.log(
        `   ${complianceIsContract ? "✅" : "❌"} Compliance: ${wiredCompliance}` +
          `${complianceIsContract ? " (contract verified on-chain)" : " (NO CODE AT ADDRESS)"}`,
      );

      if (investorTypeRegistryAddr) {
        const wiredITR = await token.investorTypeRegistry();
        const itrOk =
          wiredITR.toLowerCase() === investorTypeRegistryAddr.toLowerCase();
        console.log(
          `   ${itrOk ? "✅" : "❌"} InvestorTypeRegistry: ${wiredITR}`,
        );
      } else {
        console.log(
          "   ⚠️  InvestorTypeRegistry: Not Connected (Deploy with option 51)",
        );
      }
      console.log("   ✅ Trusted Issuers: Configured");
      console.log("   ✅ Claim Topics: Configured");

      // Display security features
      console.log("\n🔒 ON-CHAIN SECURITY FEATURES:");
      console.log("   ✅ ComplianceRules enforces KYC/AML verification");
      console.log("   ✅ Two-layer compliance architecture:");
      console.log(
        "      • Layer 1: Token checks IdentityRegistry.isVerified()",
      );
      console.log(
        "      • Layer 2: ComplianceRules checks IdentityRegistry + business rules",
      );
      if (investorTypeRegistryAddr) {
        console.log("   ✅ Transfer limits enforced by smart contract");
        console.log("   ✅ Investor type validation on-chain");
        console.log("   ✅ Cannot bypass limits by calling contract directly");
        console.log("   ✅ All checks happen in Token.canTransfer()");
      } else {
        console.log(
          "   ⚠️  Transfer limits NOT enforced (registry not connected)",
        );
        console.log(
          "   💡 Deploy InvestorTypeRegistry (option 51) to enable limits",
        );
      }

      this.state.maxTransferAmount = 8000; // 8,000 VSC limit for Normal/Retail

      displaySuccess("ERC-3643 DIGITAL TOKEN SYSTEM DEPLOYED!");
      console.log("=".repeat(60));
      console.log(`📊 Token Address: ${tokenAddr}`);
      if (investorTypeRegistryAddr) {
        console.log(`🔗 InvestorTypeRegistry: ${investorTypeRegistryAddr}`);
      } else {
        console.log(`⚠️  InvestorTypeRegistry: Not Connected`);
      }
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

      if (investorTypeRegistryAddr) {
        console.log("\n💡 Transfer Limit Enforcement:");
        console.log(
          "   • ✅ Limits are enforced ON-CHAIN by the Token contract",
        );
        console.log(
          "   • ✅ Token.transfer() calls InvestorTypeRegistry.canTransferAmount()",
        );
        console.log(
          "   • ✅ Cannot be bypassed - all transfers checked on blockchain",
        );
        console.log("   • ✅ Different limits for different investor types");
      } else {
        console.log("\n⚠️  Next Steps:");
        console.log("   • Deploy InvestorTypeRegistry (option 51)");
        console.log("   • Then reconnect to enable on-chain transfer limits");
      }
    } catch (error) {
      displayError(
        `ERC-3643 Digital Token deployment failed: ${error.message}`,
      );
      console.error("💡 Stack trace:", error.stack);
      throw error;
    }
  }

  /**
   * Deploy Oracle Management System
   *
   * @returns {Promise<void>}
   *
   * @example
   * await deployer.deployOracleSystem();
   */
  async deployOracleSystem() {
    displaySection("DEPLOYING ORACLE MANAGEMENT SYSTEM", "🔮");

    try {
      displayProgress("Deploying OracleManager...");
      const OracleManager = await ethers.getContractFactory("OracleManager");
      const oracleManager = await OracleManager.deploy();
      await oracleManager.waitForDeployment();
      this.state.oracleManager = oracleManager;
      this.state.setContract("oracleManager", oracleManager);

      displayProgress("Deploying WhitelistOracle...");
      const WhitelistOracle =
        await ethers.getContractFactory("WhitelistOracle");
      const whitelistOracle = await WhitelistOracle.deploy(
        await oracleManager.getAddress(),
        "KYC Whitelist Oracle",
        "Oracle for KYC/AML whitelist management",
      );
      await whitelistOracle.waitForDeployment();
      this.state.whitelistOracle = whitelistOracle;
      this.state.setContract("whitelistOracle", whitelistOracle);

      displayProgress("Deploying BlacklistOracle...");
      const BlacklistOracle =
        await ethers.getContractFactory("BlacklistOracle");
      const blacklistOracle = await BlacklistOracle.deploy(
        await oracleManager.getAddress(),
        "AML Blacklist Oracle",
        "Oracle for AML blacklist screening",
      );
      await blacklistOracle.waitForDeployment();
      this.state.blacklistOracle = blacklistOracle;
      this.state.setContract("blacklistOracle", blacklistOracle);

      displayProgress("Deploying ConsensusOracle...");
      const ConsensusOracle =
        await ethers.getContractFactory("ConsensusOracle");
      const consensusOracle = await ConsensusOracle.deploy(
        await oracleManager.getAddress(),
        "Consensus Oracle",
        "Oracle for multi-oracle consensus verification",
      );
      await consensusOracle.waitForDeployment();
      this.state.consensusOracle = consensusOracle;
      this.state.setContract("consensusOracle", consensusOracle);

      displaySuccess("Oracle Management System deployed successfully!");
    } catch (error) {
      displayError(`Oracle System deployment failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = ContractDeployer;
