/**
 * @fileoverview Deploy steps: the digital token system and investor custody
 * @module DeployTokenFlow
 * @description Deploys the token, binds its registries and rules, and deploys investor custody.
 * Moved out of demo/core/ContractDeployer.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const { DeploymentHelper } = require("../../scripts/deploy-helpers");
const { deployCustody } = require("./CustodyFlow");
const { wireInvestorRegistry } = require("./InvestorTypeRules");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const {
  DEFAULT_ALLOWED_COUNTRIES,
  DEFAULT_BLOCKED_COUNTRIES,
} = require("./DeployDefaults");

/**
 * Deploy ERC-3643 Digital Token System with full configuration
 *
 * @returns {Promise<void>}
 *
 * @example
 * await deployer.deployDigitalTokenSystem();
 */
async function deployDigitalTokenSystem(mod) {
  displaySection(
    "DEPLOY ERC-3643 DIGITAL TOKEN SYSTEM - WITH ON-CHAIN LIMITS",
    "🏭",
  );

  try {
    if (!mod.state.getContract("onchainIDFactory")) {
      displayError("Please deploy contracts first (option 1)");
      return;
    }

    let totalGasUsed = 0n;

    // Deploy ComplianceRules first if not exists
    if (!mod.state.getContract("complianceRules")) {
      console.log("\n📝 Step 1: Deploying ComplianceRules...");

      // Shared defaults: DEFAULT_ALLOWED_COUNTRIES in DeployDefaults.js.
      await mod.deployComplianceRulesWithConfig(
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
    const complianceAddr = await mod.state
      .getContract("complianceRules")
      .getAddress();
    const identityRegistryAddr = await mod.state
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
      await mod.state.getContract("identityRegistry").getAddress(),
      await mod.state.getContract("complianceRules").getAddress(),
    );
    await token.waitForDeployment();
    mod.state.digitalToken = token;
    mod.state.setContract("digitalToken", token);

    const tokenAddr = await token.getAddress();
    console.log(`   ✅ ERC-3643 Digital Token: ${tokenAddr}`);
    console.log(`   🏛️ Token Name: Vanguard StableCoin`);
    console.log(`   💰 Symbol: VSC`);

    // Configure ComplianceRules with IdentityRegistry for VSC
    console.log("\n📝 Step 2.5: Configuring ComplianceRules for VSC...");
    const tx1 = await mod.state
      .getContract("complianceRules")
      .setTokenIdentityRegistry(
        tokenAddr,
        await mod.state.getContract("identityRegistry").getAddress(),
      );
    const receipt1 = await tx1.wait();
    totalGasUsed += receipt1.gasUsed;
    console.log("   ✅ ComplianceRules linked to IdentityRegistry for VSC");
    // Per-token rule administrator (Task 4.1, G5) until the handover.
    const cr = mod.state.getContract("complianceRules");
    const me = mod.state.signers[0].address;
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
    const txAgent = await mod.state
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
    const tx2 = await mod.state
      .getContract("identityRegistry")
      .setComplianceRules(
        await mod.state.getContract("complianceRules").getAddress(),
        tokenAddr,
      );
    const receipt2 = await tx2.wait();
    totalGasUsed += receipt2.gasUsed;
    console.log(
      "   ✅ IdentityRegistry linked: blocked countries refused at registration",
    );

    // Task 3.6: the privacy pair option 1 deployed becomes VSC's ZK
    // whitelist source, with the mode left OracleOnly (no change yet).
    console.log("\n📝 Step 2.7: Wiring the ZK allow list (PrivacyManager)...");
    await mod.wirePrivacyManager();

    // Check if InvestorTypeRegistry is deployed
    console.log(
      "\n📝 Step 3: Connecting InvestorTypeRegistry for on-chain transfer limits...",
    );

    let investorTypeRegistryAddr = null;
    if (!mod.state.getContract("investorTypeRegistry")) {
      console.log(`   ⚠️  InvestorTypeRegistry not deployed yet`);
      console.log(
        `   💡 Deploy it now using option 51 — it wires itself to this token automatically`,
      );
      console.log(
        `   ⚠️  Transfer limits will NOT be enforced until registry is connected!`,
      );
    } else {
      investorTypeRegistryAddr = await mod.state
        .getContract("investorTypeRegistry")
        .getAddress();
      // Task 4.10: set the registry and have it authorize VSC.
      await wireInvestorRegistry(
        token,
        mod.state.getContract("investorTypeRegistry"),
      );
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
      const normalConfig = await mod.state
        .getContract("investorTypeRegistry")
        .getInvestorTypeConfig(0);
      const retailConfig = await mod.state
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
      console.log("\n📝 Step 5: Investor custody (InvestorRequestManager)...");
      await mod.deployInvestorCustody();
    }

    // Display compliance components.
    // These are read back from chain rather than printed as fixed text:
    // a hardcoded "✅ Connected" reports success even when the wiring
    // silently failed, which is exactly the state the setter guards in
    // Token/IdentityRegistry now make impossible to reach unnoticed.
    console.log("\n📋 ERC-3643 Compliance Components:");

    const wiredIdentityRegistry = await token.identityRegistry();
    const expectedIdentityRegistry = await mod.state
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

    let itrOk = false; // the chain read below gates the limits lines
    if (investorTypeRegistryAddr) {
      const wiredITR = await token.investorTypeRegistry();
      itrOk = wiredITR.toLowerCase() === investorTypeRegistryAddr.toLowerCase();
      console.log(
        `   ${itrOk ? "✅" : "❌"} InvestorTypeRegistry: ${wiredITR}`,
      );
    } else {
      console.log(
        "   ⚠️  InvestorTypeRegistry: Not Connected (Deploy with option 51)",
      );
    }
    // Topics and issuers as IdentityRegistry reports them (R-47-2).
    const topicRegistry = mod.state.getContract("identityRegistry");
    const topics = await topicRegistry.getClaimTopics();
    const issuers = new Set(); // distinct issuers, not issuer-topic pairs
    for (const topic of topics)
      for (const issuer of await topicRegistry.getTrustedIssuersForClaimTopic(
        topic,
      ))
        issuers.add(issuer);
    console.log(
      `   ${issuers.size ? "✅" : "⚠️ "} Trusted Issuers: ${issuers.size} across the claim topics`,
    );
    console.log(
      `   ${topics.length ? "✅" : "⚠️ "} Claim Topics: ${topics.join(", ") || "none"}`,
    );

    // Display security features
    console.log("\n🔒 ON-CHAIN SECURITY FEATURES:");
    console.log("   ✅ ComplianceRules enforces KYC/AML verification");
    console.log("   ✅ Two-layer compliance architecture:");
    console.log("      • Layer 1: Token checks IdentityRegistry.isVerified()");
    console.log(
      "      • Layer 2: ComplianceRules checks IdentityRegistry + business rules",
    );
    if (itrOk) {
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

    mod.state.maxTransferAmount = 8000; // 8,000 VSC limit for Normal/Retail

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
      console.log("   • ✅ Limits are enforced ON-CHAIN by the Token contract");
      console.log(
        "   • ✅ Token.transfer() calls canTransferAmount() and canTransferNow() (cooldown, Task 4.10)",
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
    displayError(`ERC-3643 Digital Token deployment failed: ${error.message}`);
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
async function deployInvestorCustody(mod) {
  return deployCustody(mod.state);
}

module.exports = {
  deployDigitalTokenSystem,
  deployInvestorCustody,
};
