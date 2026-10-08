/**
 * @fileoverview Deploy steps: OnchainID layer, registries, privacy pair, ComplianceRules
 * @module DeployCoreFlow
 * @description Deploys the identity layer, the ERC-3643 registries, the privacy pair and ComplianceRules.
 * Moved out of demo/core/ContractDeployer.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers, artifacts } = require("hardhat");
const { KYC_TOPIC, AML_TOPIC } = require("./Kyc");
const {
  setupDemoAttestations,
  wireJurisdictionSource,
} = require("./AttestationFlow");
const {
  displaySection,
  displaySuccess,
  displayError,
  displayProgress,
} = require("./DisplayHelpers");
const {
  DEFAULT_ALLOWED_COUNTRIES,
  DEFAULT_BLOCKED_COUNTRIES,
} = require("./DeployDefaults");

/**
 * Deploy OnchainID contracts (Factory, KYC Issuer, AML Issuer)
 *
 * @returns {Promise<void>}
 * @private
 */
async function deployOnchainIDContracts(mod) {
  // Deploy OnchainID Factory
  displayProgress("Deploying OnchainID Factory...");
  const OnchainIDFactory = await ethers.getContractFactory("OnchainIDFactory");
  // Task 4.11 (R-411-19): only the compiled KeyManager may be pinned.
  const kmHash = ethers.keccak256(
    (await artifacts.readArtifact("KeyManager")).deployedBytecode,
  );
  const factory = await OnchainIDFactory.deploy(
    mod.state.signers[0].address,
    kmHash,
  );
  await factory.waitForDeployment();
  mod.state.setContract("onchainIDFactory", factory);

  await mod.logger.logContractDeployment("OnchainIDFactory", factory, [
    mod.state.signers[0].address,
  ]);

  // Deploy KYC Issuer
  displayProgress("Deploying KYC Issuer...");
  const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
  const kycIssuer = await ClaimIssuer.deploy(
    mod.state.signers[2].address,
    "KYC Service",
    "KYC verification service",
  );
  await kycIssuer.waitForDeployment();
  mod.state.setContract("kycIssuer", kycIssuer);

  await mod.logger.logContractDeployment("KYC_ClaimIssuer", kycIssuer, [
    mod.state.signers[2].address,
    "KYC Service",
    "KYC verification service",
  ]);

  // Deploy AML Issuer
  displayProgress("Deploying AML Issuer...");
  const amlIssuer = await ClaimIssuer.deploy(
    mod.state.signers[3].address,
    "AML Service",
    "AML screening service",
  );
  await amlIssuer.waitForDeployment();
  mod.state.setContract("amlIssuer", amlIssuer);

  await mod.logger.logContractDeployment("AML_ClaimIssuer", amlIssuer, [
    mod.state.signers[3].address,
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
  mod.state.setContract("keyManager", keyManager);
  await mod.logger.logContractDeployment("KeyManager", keyManager, []);
  // Task 4.11 (R-411-14): every identity the factory creates pins this
  // KeyManager as its one recovery manager.
  const kmAddr = await keyManager.getAddress();
  await (await factory.setRecoveryManager(kmAddr)).wait();
  console.log(`   🔗 OnchainIDFactory.recoveryManager = KeyManager ${kmAddr}`);
}

/**
 * Deploy ERC-3643 registries
 *
 * @returns {Promise<void>}
 * @private
 */
async function deployERC3643Registries(mod) {
  displayProgress("Deploying ERC-3643 Registries...");

  const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
  const identityRegistry = await IdentityRegistry.deploy();
  await identityRegistry.waitForDeployment();
  // The handover's log scans start here (fromBlock, 2F.5 review M-3).
  mod.state.identityRegistryDeployBlock = (
    await identityRegistry.deploymentTransaction().wait()
  ).blockNumber;
  mod.state.setContract("identityRegistry", identityRegistry);

  await mod.logger.logContractDeployment(
    "IdentityRegistry",
    identityRegistry,
    [],
  );

  // Require a KYC claim from the trusted KYC issuer before a wallet
  // verifies. Without this, isVerified() would pass on registration alone.
  const kycIssuer = mod.state.getContract("kycIssuer");
  const kycIssuerAddr = await kycIssuer.getAddress();
  // Issuer first: a required topic needs a trusted issuer (2F.5 L-1).
  await identityRegistry.addTrustedIssuer(kycIssuerAddr, [KYC_TOPIC]);
  console.log(`   ✅ Trusted issuer for KYC: ${kycIssuerAddr}`);
  await identityRegistry.addClaimTopic(KYC_TOPIC);
  console.log(`   ✅ Required claim topic: KYC (${KYC_TOPIC})`);

  // Require an AML claim from the trusted AML issuer as well (plan Task
  // 1R.3): both deployed issuers gate transfers, not just KYC.
  const amlIssuer = mod.state.getContract("amlIssuer");
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
async function deployPrivacyPair(mod) {
  let zkVerifier = mod.state.getContract("zkVerifierIntegrated");
  let privacyManager = mod.state.getContract("privacyManager");
  if (zkVerifier && privacyManager) return { zkVerifier, privacyManager };

  displayProgress("Deploying ZKVerifierIntegrated (real verification)...");
  zkVerifier = await (
    await ethers.getContractFactory("ZKVerifierIntegrated")
  ).deploy(false);
  await zkVerifier.waitForDeployment();
  mod.state.setContract("zkVerifierIntegrated", zkVerifier);
  mod.state.setContract("zkVerifier", zkVerifier); // alias, options 42-50
  mod.state.zkVerifier = zkVerifier;
  await mod.logger.logContractDeployment("ZKVerifierIntegrated", zkVerifier, [
    false,
  ]);

  displayProgress("Deploying PrivacyManager (whitelist root + bindings)...");
  const zkAddr = await zkVerifier.getAddress();
  privacyManager = await (
    await ethers.getContractFactory("PrivacyManager")
  ).deploy(zkAddr);
  await privacyManager.waitForDeployment();
  mod.state.setContract("privacyManager", privacyManager);
  await mod.logger.logContractDeployment("PrivacyManager", privacyManager, [
    zkAddr,
  ]);

  console.log(
    `   ✅ ZKVerifierIntegrated: ${zkAddr} (testingMode ${await zkVerifier.testingMode()})`,
  );
  console.log(
    `   ✅ PrivacyManager:       ${await privacyManager.getAddress()} (owner publishes roots until the handover makes ops the listOperator)`,
  );
  // Task 3.7b: the demo issuer key trusted for the three attestation
  // circuits, and the default policies.
  await setupDemoAttestations({ state: mod.state, privacyManager });
  return { zkVerifier, privacyManager };
}

/**
 * Point ComplianceRules at the PrivacyManager for VSC, leaving the
 * whitelist mode as it is (OracleOnly after deploy, so nothing changes for
 * transfers). The handover ceremony derives the PrivacyManager from this
 * wiring (R-3R-15); option 42 -> 1 switches VSC to Either.
 * @returns {Promise<boolean>} true when VSC reads this PrivacyManager
 */
async function wirePrivacyManager(mod) {
  const rules = mod.state.getContract("complianceRules");
  const token = mod.state.getContract("digitalToken");
  const pm = mod.state.getContract("privacyManager");
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
    if (owner.toLowerCase() !== mod.state.signers[0].address.toLowerCase()) {
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
async function deployComplianceRulesWithConfig(
  mod,
  allowedCountries,
  blockedCountries,
) {
  try {
    displayProgress("Deploying ComplianceRules contract...");

    const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
    const complianceRules = await ComplianceRules.deploy(
      mod.state.signers[0].address, // owner
      allowedCountries,
      blockedCountries,
    );
    await complianceRules.waitForDeployment();
    // The handover's trusted-contract scan starts here (83e, review M4).
    mod.state.complianceRulesDeployBlock = (
      await complianceRules.deploymentTransaction().wait()
    ).blockNumber;

    mod.state.complianceRules = complianceRules;
    mod.state.setContract("complianceRules", complianceRules);

    await mod.logger.logContractDeployment("ComplianceRules", complianceRules, [
      mod.state.signers[0].address,
      allowedCountries,
      blockedCountries,
    ]);

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
async function deployComplianceRules(mod) {
  displaySection("DEPLOYING COMPLIANCE RULES", "⚖️");

  try {
    await mod.deployComplianceRulesWithConfig(
      DEFAULT_ALLOWED_COUNTRIES,
      DEFAULT_BLOCKED_COUNTRIES,
    );
  } catch (error) {
    displayError(`ComplianceRules deployment failed: ${error.message}`);
    throw error;
  }
}

module.exports = {
  deployOnchainIDContracts,
  deployERC3643Registries,
  deployPrivacyPair,
  wirePrivacyManager,
  deployComplianceRulesWithConfig,
  deployComplianceRules,
};
