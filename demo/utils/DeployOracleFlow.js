/**
 * @fileoverview Deploy step: the oracle system
 * @module DeployOracleFlow
 * @description Deploys the oracle manager and the whitelist and blacklist oracles.
 * Moved out of demo/core/ContractDeployer.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
  displayProgress,
} = require("./DisplayHelpers");

/**
 * Deploy Oracle Management System
 *
 * @returns {Promise<void>}
 *
 * @example
 * await deployer.deployOracleSystem();
 */
async function deployOracleSystem(mod) {
  displaySection("DEPLOYING ORACLE MANAGEMENT SYSTEM", "🔮");

  try {
    displayProgress("Deploying OracleManager...");
    const OracleManager = await ethers.getContractFactory("OracleManager");
    const oracleManager = await OracleManager.deploy();
    await oracleManager.waitForDeployment();
    mod.state.oracleManager = oracleManager;
    mod.state.setContract("oracleManager", oracleManager);

    displayProgress("Deploying WhitelistOracle...");
    const WhitelistOracle = await ethers.getContractFactory("WhitelistOracle");
    const whitelistOracle = await WhitelistOracle.deploy(
      await oracleManager.getAddress(),
      "KYC Whitelist Oracle",
      "Oracle for KYC/AML whitelist management",
    );
    await whitelistOracle.waitForDeployment();
    mod.state.whitelistOracle = whitelistOracle;
    mod.state.setContract("whitelistOracle", whitelistOracle);

    displayProgress("Deploying BlacklistOracle...");
    const BlacklistOracle = await ethers.getContractFactory("BlacklistOracle");
    const blacklistOracle = await BlacklistOracle.deploy(
      await oracleManager.getAddress(),
      "AML Blacklist Oracle",
      "Oracle for AML blacklist screening",
    );
    await blacklistOracle.waitForDeployment();
    mod.state.blacklistOracle = blacklistOracle;
    mod.state.setContract("blacklistOracle", blacklistOracle);

    // Task 4.4 (D11 = a): ConsensusOracle is the manager's weighted
    // engine, bound to it at construction; the manager binds it back.
    displayProgress("Deploying ConsensusOracle (the manager's engine)...");
    const ConsensusOracle = await ethers.getContractFactory("ConsensusOracle");
    const consensusOracle = await ConsensusOracle.deploy(
      await oracleManager.getAddress(),
    );
    await consensusOracle.waitForDeployment();
    await (
      await oracleManager.setConsensusEngine(await consensusOracle.getAddress())
    ).wait();
    mod.state.consensusOracle = consensusOracle;
    mod.state.setContract("consensusOracle", consensusOracle);

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
      const address = mod.state.signers[i].address;
      await (
        await oracleManager.registerOracle(address, role, about, 500)
      ).wait();
      mod.state.oracleConfig.set(key, { address, role, reputation: 500 });
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
    const rules = mod.state.getContract("complianceRules");
    const digitalToken = mod.state.getContract("digitalToken");
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

module.exports = {
  deployOracleSystem,
};
