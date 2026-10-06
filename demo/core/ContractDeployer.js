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
const { DeploymentHelper } = require("../../scripts/deploy-helpers");
const { KYC_TOPIC, AML_TOPIC } = require("../utils/Kyc");
const {
  setupDemoAttestations,
  wireJurisdictionSource,
} = require("../utils/AttestationFlow");
const { deployCustody } = require("../utils/CustodyFlow");
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
   *                                         registries -> `identityRegistry`,
   *                                         privacy pair -> `privacyManager`
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
      "   1. Core contracts (OnchainID, issuers, ERC-3643 registries,",
    );
    console.log("      ZKVerifierIntegrated + PrivacyManager)");
    console.log(
      "   2. ERC-3643 digital token — also deploys ComplianceRules and",
    );
    console.log("      wires the ZK allow list (mode OracleOnly: OFF)");
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
      if (d.name === "Core contracts") {
        // The privacy pair deploys with the core layer (Task 3.6).
        for (const [label, key] of [
          ["KeyManager", "keyManager"],
          ["ZKVerifierIntegrated", "zkVerifierIntegrated"],
          ["PrivacyManager", "privacyManager"],
        ]) {
          const c = this.state.getContract(key);
          if (c) console.log(`   ✅ ${label.padEnd(26)} ${c.target}`);
        }
      }
    }
    for (let i = done.length; i < steps.length; i++) {
      console.log(`   ⏭️  ${steps[i].name.padEnd(26)} not deployed`);
    }

    if (reached === steps.length) {
      console.log("\n💡 Next steps:");
      console.log("   • Option 23 or 24 — onboard users (creates OnchainIDs)");
      console.log(
        "   • Options 6 and 7 — KYC/AML claims for any still unverified",
      );
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

      // The privacy pair (plan v2 Task 3.6): option 21 wires it into
      // ComplianceRules for VSC, option 42 -> 1 uses it on the live token.
      await this.deployPrivacyPair();

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

    // KeyManager (plan v2 Task 4.2): no owner, no constructor argument.
    // Identities opt in with authorizeManager; options 12/12a/5 use it.
    displayProgress("Deploying KeyManager...");
    const keyManager = await (
      await ethers.getContractFactory("KeyManager")
    ).deploy();
    await keyManager.waitForDeployment();
    this.state.setContract("keyManager", keyManager);
    await this.logger.logContractDeployment("KeyManager", keyManager, []);
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
    // The handover's log scans start here (fromBlock, 2F.5 review M-3).
    this.state.identityRegistryDeployBlock = (
      await identityRegistry.deploymentTransaction().wait()
    ).blockNumber;
    this.state.setContract("identityRegistry", identityRegistry);

    await this.logger.logContractDeployment(
      "IdentityRegistry",
      identityRegistry,
      [],
    );

    // Require a KYC claim from the trusted KYC issuer before a wallet
    // verifies. Without this, isVerified() would pass on registration alone.
    const kycIssuer = this.state.getContract("kycIssuer");
    const kycIssuerAddr = await kycIssuer.getAddress();
    // Issuer first: a required topic needs a trusted issuer (2F.5 L-1).
    await identityRegistry.addTrustedIssuer(kycIssuerAddr, [KYC_TOPIC]);
    console.log(`   ✅ Trusted issuer for KYC: ${kycIssuerAddr}`);
    await identityRegistry.addClaimTopic(KYC_TOPIC);
    console.log(`   ✅ Required claim topic: KYC (${KYC_TOPIC})`);

    // Require an AML claim from the trusted AML issuer as well (plan Task
    // 1R.3): both deployed issuers gate transfers, not just KYC.
    const amlIssuer = this.state.getContract("amlIssuer");
    const amlIssuerAddr = await amlIssuer.getAddress();
    await identityRegistry.addTrustedIssuer(amlIssuerAddr, [AML_TOPIC]);
    console.log(`   ✅ Trusted issuer for AML: ${amlIssuerAddr}`);
    await identityRegistry.addClaimTopic(AML_TOPIC);
    console.log(`   ✅ Required claim topic: AML (${AML_TOPIC})`);
  }

  /**
   * Deploy ZKVerifierIntegrated(testingMode = false) and PrivacyManager on
   * it, unless demo state already holds both. testingMode is immutable and
   * PrivacyManager refuses a testingMode verifier, so the demo has no mock
   * mode; mocks live in test/ only. Option 41 calls this too, so the
   * privacy menu works when option 1 has not run.
   * @returns {Promise<{zkVerifier: Object, privacyManager: Object}>}
   */
  async deployPrivacyPair() {
    let zkVerifier = this.state.getContract("zkVerifierIntegrated");
    let privacyManager = this.state.getContract("privacyManager");
    if (zkVerifier && privacyManager) return { zkVerifier, privacyManager };

    displayProgress("Deploying ZKVerifierIntegrated (real verification)...");
    zkVerifier = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    await zkVerifier.waitForDeployment();
    this.state.setContract("zkVerifierIntegrated", zkVerifier);
    this.state.setContract("zkVerifier", zkVerifier); // alias, options 42-50
    this.state.zkVerifier = zkVerifier;
    await this.logger.logContractDeployment(
      "ZKVerifierIntegrated",
      zkVerifier,
      [false],
    );

    displayProgress("Deploying PrivacyManager (whitelist root + bindings)...");
    const zkAddr = await zkVerifier.getAddress();
    privacyManager = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(zkAddr);
    await privacyManager.waitForDeployment();
    this.state.setContract("privacyManager", privacyManager);
    await this.logger.logContractDeployment("PrivacyManager", privacyManager, [
      zkAddr,
    ]);

    console.log(`   ✅ ZKVerifierIntegrated: ${zkAddr} (testingMode false)`);
    console.log(
      `   ✅ PrivacyManager:       ${await privacyManager.getAddress()} (owner publishes roots until the handover makes ops the listOperator)`,
    );
    // Task 3.7b: the demo issuer key trusted for the three attestation
    // circuits, and the default policies.
    await setupDemoAttestations({ state: this.state, privacyManager });
    return { zkVerifier, privacyManager };
  }

  /**
   * Point ComplianceRules at the PrivacyManager for VSC, leaving the
   * whitelist mode as it is (OracleOnly after deploy, so nothing changes for
   * transfers). The handover ceremony derives the PrivacyManager from this
   * wiring (R-3R-15); option 42 -> 1 switches VSC to Either.
   * @returns {Promise<boolean>} true when VSC reads this PrivacyManager
   */
  async wirePrivacyManager() {
    const rules = this.state.getContract("complianceRules");
    const token = this.state.getContract("digitalToken");
    const pm = this.state.getContract("privacyManager");
    if (!rules || !token || !pm) {
      console.log(
        "   ℹ️  ZK allow list not wired: needs ComplianceRules, VSC and the privacy pair (options 1 and 21)",
      );
      return false;
    }
    const vsc = await token.getAddress();
    const pmAddr = await pm.getAddress();
    // Task 3.8: private jurisdiction proofs use VSC's ComplianceRules rule.
    await wireJurisdictionSource({
      privacyManager: pm,
      complianceRules: rules,
      token,
    });
    const wired = await rules.privacyManager(vsc);
    if (wired.toLowerCase() !== pmAddr.toLowerCase()) {
      const owner = await rules.owner();
      if (owner.toLowerCase() !== this.state.signers[0].address.toLowerCase()) {
        console.log(
          `   ⚠️  ComplianceRules.privacyManager(VSC) = ${wired}; the owner (${owner}) wires ${pmAddr} by a ComplianceRules vote`,
        );
        return false;
      }
      await (await rules.setPrivacyManager(vsc, pmAddr)).wait();
    }
    const mode = Number(await rules.whitelistMode(vsc));
    console.log(`   ✅ ComplianceRules.privacyManager(VSC) = ${pmAddr}`);
    console.log(
      `   ℹ️  Whitelist mode ${["OracleOnly", "ZkOnly", "Either"][mode]}: the ZK allow list is wired but ${mode === 0 ? "OFF until option 42 -> 1 switches VSC to Either" : "ON"}`,
    );
    return true;
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
      // The handover's trusted-contract scan starts here (83e, review M4).
      this.state.complianceRulesDeployBlock = (
        await complianceRules.deploymentTransaction().wait()
      ).blockNumber;

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

        // Shared defaults: DEFAULT_ALLOWED_COUNTRIES at the top of this file.
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

      // Refuse to bind a compliance contract that does not enforce. The
      // helper reads isProductionCompliance() and throws on false or absent.
      // This is the only place in the repo a Token receives its compliance
      // address, so this is where the check has to live.
      const complianceAddr = await this.state
        .getContract("complianceRules")
        .getAddress();
      const identityRegistryAddr = await this.state
        .getContract("identityRegistry")
        .getAddress();
      await DeploymentHelper.assertProductionCompliance(
        complianceAddr,
        identityRegistryAddr,
      );

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
      // Per-token rule administrator (Task 4.1, G5) until the handover.
      const cr = this.state.getContract("complianceRules");
      const me = this.state.signers[0].address;
      await (await cr.setRuleAdministrator(tokenAddr, me, true)).wait();
      console.log("   ✅ Deployer is VSC's rule administrator (to handover)");

      // Task 2A.4b: the binding above is the only thing that flips
      // ComplianceRules.isProductionCompliance(tokenAddr) to true (fail
      // closed otherwise per Task 2A.4). Assert it right here so a silently
      // skipped or reordered bind is caught at deploy time.
      await DeploymentHelper.assertTokenCompliant(complianceAddr, tokenAddr);

      // The token must be an agent of the registry for wallet recovery:
      // Token.recoveryAddress calls IdentityRegistry.moveIdentity, which is
      // onlyAgent. Without this grant, every recovery reverts.
      const txAgent = await this.state
        .getContract("identityRegistry")
        .addAgent(tokenAddr);
      const receiptAgent = await txAgent.wait();
      totalGasUsed += receiptAgent.gasUsed;
      console.log(
        "   ✅ Token granted agent role on IdentityRegistry (wallet recovery)",
      );

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
      console.log(
        "   ✅ IdentityRegistry linked: blocked countries refused at registration",
      );

      // Task 3.6: the privacy pair option 1 deployed becomes VSC's ZK
      // whitelist source, with the mode left OracleOnly (no change yet).
      console.log(
        "\n📝 Step 2.7: Wiring the ZK allow list (PrivacyManager)...",
      );
      await this.wirePrivacyManager();

      // Check if InvestorTypeRegistry is deployed
      console.log(
        "\n📝 Step 3: Connecting InvestorTypeRegistry for on-chain transfer limits...",
      );

      let investorTypeRegistryAddr = null;
      if (!this.state.getContract("investorTypeRegistry")) {
        console.log(`   ⚠️  InvestorTypeRegistry not deployed yet`);
        console.log(
          `   💡 Deploy it now using option 51 — it wires itself to this token automatically`,
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

        // Task 4.3: investor custody (option 23) on this token + registry.
        console.log(
          "\n📝 Step 5: Investor custody (InvestorRequestManager)...",
        );
        await this.deployInvestorCustody();
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
   * Plan v2 Task 4.3: deploy InvestorRequestManager for VSC (bank = ops,
   * wallet 10) and record it as `investorRequestManager`; it is named a
   * ComplianceRules registrar for the MultiSigWallet code hash. Options 21
   * and 51 call this once both VSC and the investor type registry exist.
   * @returns {Promise<Object|null>} the manager, or null when not deployable
   */
  async deployInvestorCustody() {
    return deployCustody(this.state);
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

      // Task 4.4 (D11 = a): ConsensusOracle is the manager's weighted
      // engine, bound to it at construction; the manager binds it back.
      displayProgress("Deploying ConsensusOracle (the manager's engine)...");
      const ConsensusOracle =
        await ethers.getContractFactory("ConsensusOracle");
      const consensusOracle = await ConsensusOracle.deploy(
        await oracleManager.getAddress(),
      );
      await consensusOracle.waitForDeployment();
      await (
        await oracleManager.setConsensusEngine(
          await consensusOracle.getAddress(),
        )
      ).wait();
      this.state.consensusOracle = consensusOracle;
      this.state.setContract("consensusOracle", consensusOracle);

      // Register oracles in the manager. Menu options 32+ (registration,
      // whitelist/blacklist, consensus voting) read these signer roles and
      // this.state.oracleConfig; both used to exist only in the menu-only
      // OracleModule.deployOracleSystem, which never bound the blacklist
      // oracle into ComplianceRules. Folded here so there is one deploy path.
      // Reputation 500: above MIN_REPUTATION, so ops may unpause (4.4).
      displayProgress("Registering oracles in manager...");
      for (const [key, i, role, about] of [
        [
          "kyc",
          1,
          "KYC_ORACLE",
          "KYC verification oracle for identity validation",
        ],
        [
          "aml",
          2,
          "AML_ORACLE",
          "AML screening oracle for anti-money laundering checks",
        ],
        [
          "compliance",
          3,
          "COMPLIANCE_ORACLE",
          "Compliance validation oracle for regulatory checks",
        ],
      ]) {
        const address = this.state.signers[i].address;
        await (
          await oracleManager.registerOracle(address, role, about, 500)
        ).wait();
        this.state.oracleConfig.set(key, { address, role, reputation: 500 });
      }
      console.log("   ✅ KYC/AML/Compliance oracles registered (3)");

      const pct = await oracleManager.getConsensusThreshold();
      console.log(
        `   ✅ Consensus threshold: ${pct}% of the registered weight (two of three equal nodes)`,
      );

      // Wire the BLACKLIST gate into the token's compliance, when both exist.
      //
      // Only the blacklist. The whitelist gate is default-deny: switching it on
      // blocks every holder until each one is added to the oracle, which would
      // silently break a running demo. Turn that on deliberately via the Oracle
      // menu once the oracle is populated.
      const rules = this.state.getContract("complianceRules");
      const digitalToken = this.state.getContract("digitalToken");
      if (
        rules &&
        digitalToken &&
        typeof rules.setBlacklistOracle === "function"
      ) {
        const tokenAddr = await digitalToken.getAddress();
        await (
          await rules.setBlacklistOracle(
            tokenAddr,
            await blacklistOracle.getAddress(),
          )
        ).wait();
        console.log("   ✅ Blacklist oracle now gates VSC transfers");
        console.log(
          "   ℹ️  Whitelist oracle not bound (default-deny would block all holders)",
        );
        const zkWired =
          (await rules.privacyManager(tokenAddr)) !== ethers.ZeroAddress;
        const wlMode = Number(await rules.whitelistMode(tokenAddr));
        console.log(
          !zkWired
            ? "   ℹ️  ZK allow list not wired (options 1 and 21 wire it)"
            : wlMode === 0
              ? "   ℹ️  ZK allow list wired but OFF (OracleOnly) until option 42 -> 1 switches VSC to Either"
              : "   ℹ️  ZK allow list ON: VSC holders need a live PrivacyManager binding",
        );
      } else {
        console.log(
          "   ℹ️  Token or ComplianceRules not deployed yet — oracle gate not wired.",
        );
        console.log(
          "      Deploy the token first, then re-run this step to enable blacklist gating.",
        );
      }

      displaySuccess("Oracle Management System deployed successfully!");
    } catch (error) {
      displayError(`Oracle System deployment failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = ContractDeployer;
