/**
 * @fileoverview Escrow options 61-62: deploy the factory, register an investor
 * @module EscrowSetupFlow
 * @description Deploys EscrowWalletFactory and registers investors for escrow, with
 * the verification and fee-exemption helpers the other escrow flows use.
 * Moved out of demo/modules/EscrowModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
  displayWarning,
} = require("./DisplayHelpers");
const { registerRegistrar } = require("./GovernedCalls");
const { retirePlaceholder } = require("./CustodyFlow");
const { attestAll } = require("./Kyc");
const { ethers } = require("hardhat");

/** Option 61: Deploy Enhanced Escrow System */
async function deployEscrowSystem(mod) {
  displaySection("DEPLOYING ENHANCED ESCROW SYSTEM", "🏗️");
  console.log("One-time-use multi-signature escrow wallets");
  console.log("");

  try {
    const digitalToken = mod.state.getContract("digitalToken");
    if (!digitalToken) {
      displayError(
        "VSC Token not deployed. Please deploy ERC-3643 system first (option 21)",
      );
      return;
    }

    const identityRegistry = mod.state.getContract("identityRegistry");
    if (!identityRegistry) {
      displayError(
        "IdentityRegistry not deployed. Please deploy ERC-3643 system first (option 21)",
      );
      return;
    }

    const signers = mod.state.signers;
    const ownerWallet = signers[1]; // Owner's wallet for receiving fees

    // The owner fee wallet is a human party: escrow wallets pay it fees,
    // so it must be a verified identity (only contracts are trusted).
    // Done first, so a refusal (e.g. after the handover the deployer is no
    // longer a registry agent) leaves nothing half-deployed.
    await mod._ensureVerified(ownerWallet.address, "owner fee wallet");
    await mod._ensureFeeExempt(ownerWallet.address, "owner fee wallet");
    console.log("");

    console.log("📋 Deploying EscrowWalletFactory...");
    console.log(`   VSC Token: ${await digitalToken.getAddress()}`);
    console.log(`   Identity Registry: ${await identityRegistry.getAddress()}`);
    console.log(
      `   Compliance Rules: ${await mod.state.getContract("complianceRules").getAddress()}`,
    );
    console.log(`   Owner Wallet: ${ownerWallet.address}`);
    console.log("");

    const EscrowWalletFactory = await ethers.getContractFactory(
      "EscrowWalletFactory",
    );
    const escrowFactory = await EscrowWalletFactory.deploy(
      await digitalToken.getAddress(),
      ownerWallet.address,
      await identityRegistry.getAddress(),
      await mod.state.getContract("complianceRules").getAddress(),
    );
    await escrowFactory.waitForDeployment();

    mod.state.setContract("escrowFactory", escrowFactory);
    mod.state.escrowFactory = escrowFactory; // Alias
    console.log(`✅ EscrowWalletFactory: ${await escrowFactory.getAddress()}`);

    // Task 4.3: the factory is a ComplianceRules registrar on VSC for the
    // MultiSigEscrowWallet code hash, so createEscrowWallet trusts each
    // escrow it deploys. Naming a registrar is the ComplianceRules
    // owner's: the deployer until the handover, a vote after it.
    console.log("");
    const reg = await registerRegistrar(
      mod.state,
      await escrowFactory.getAddress(),
      "MultiSigEscrowWallet",
    );
    if (reg.direct) {
      console.log(
        "   ✅ Factory is a ComplianceRules registrar on VSC: it trusts only the escrows it deploys (MultiSigEscrowWallet code hash)",
      );
    } else if (reg.proposalId) {
      console.log(
        `   ⏳ Escrows cannot be created until proposal #${reg.proposalId} names the factory a registrar: vote with option 77, execute with option 78`,
      );
    } else {
      displayWarning(`Factory is not a registrar: ${reg.refused}`);
    }

    console.log("");
    displaySuccess("ENHANCED ESCROW SYSTEM DEPLOYED SUCCESSFULLY!");
    console.log("");
    console.log("📊 SYSTEM OVERVIEW:");
    console.log(`   Factory: ${await escrowFactory.getAddress()}`);
    console.log(`   VSC Token: ${await digitalToken.getAddress()}`);
    console.log(`   Identity Registry: ${await identityRegistry.getAddress()}`);
    console.log(
      `   Compliance Rules: ${await mod.state.getContract("complianceRules").getAddress()}`,
    );
    console.log(`   Owner Wallet: ${ownerWallet.address}`);
    console.log("");
    console.log("🔐 SECURITY MODEL:");
    console.log("   ✅ Payer must have valid OnchainID + KYC/AML");
    console.log("   ✅ Payee must have valid OnchainID + KYC/AML");
    console.log(
      "   ✅ Escrow wallets trusted at creation by the factory (registrar, code-hash bound)",
    );
    console.log(
      "   ✅ Owner and investor fee wallets are verified investors, not trusted",
    );
    console.log("   ✅ Jurisdiction rules enforced for all parties");
    console.log("   ✅ No KYC/AML bypass - secure compliance!");
    console.log("");
    console.log("💡 NEXT STEPS:");
    console.log("   1. Register investors (Option 62)");
    console.log("   2. Create escrow wallets (Option 63)");
    console.log("   3. Fund and use the system");
  } catch (error) {
    displayError(`Deployment failed: ${error.message}`);
  }
}

/**
 * Helper: Get signer for a specific address
 */
async function getSignerForAddress(mod, address) {
  const signer = mod.state.signers.find(
    (s) => s.address.toLowerCase() === address.toLowerCase(),
  );
  if (!signer) {
    throw new Error(`No signer found for address ${address}`);
  }
  return signer;
}

/**
 * Helper: make a human party a verified identity (OnchainID, KYC + AML
 * claims, registry entry). Only contracts may be trusted, so every wallet
 * that sends or receives VSC around an escrow wallet goes through the
 * identity gate as an investor.
 */
async function _ensureVerified(mod, address, label) {
  const identityRegistry = mod.state.getContract("identityRegistry");
  if (await identityRegistry.isVerified(address)) {
    console.log(`   ✅ ${label} ${address} is a verified investor`);
    return;
  }
  console.log(`   📝 Onboarding ${label} ${address} as a verified investor...`);
  // The registry's identity is the one isVerified() reads, so attest that
  // one when the wallet is already registered (e.g. claims expired). The
  // factory record is only a fallback: it is overwritten on every deploy.
  let identityAddress = await identityRegistry.identity(address);
  if (identityAddress === ethers.ZeroAddress) {
    const factory = mod.state.getContract("onchainIDFactory");
    identityAddress = await factory.getIdentityByOwner(address);
    if (identityAddress === ethers.ZeroAddress) {
      await (
        await factory.deployOnchainID(address, ethers.randomBytes(32))
      ).wait();
      identityAddress = await factory.getIdentityByOwner(address);
    }
  }
  await attestAll(mod.state, identityAddress, `escrow:${label}`);
  if ((await identityRegistry.identity(address)) === ethers.ZeroAddress) {
    const rules = mod.state.getContract("complianceRules");
    const tokenAddr = await mod.state.getContract("digitalToken").getAddress();
    const rule = await rules.getJurisdictionRule(tokenAddr);
    const country =
      rule.allowedCountries.length > 0 ? Number(rule.allowedCountries[0]) : 840;
    const [countryOk, why] = await rules.validateJurisdiction(
      tokenAddr,
      country,
    );
    if (!countryOk) {
      throw new Error(
        `${label} ${address}: country ${country} refused by the jurisdiction rule (${why})`,
      );
    }
    await (
      await identityRegistry.registerIdentity(address, identityAddress, country)
    ).wait();
  }
  if (!(await identityRegistry.isVerified(address))) {
    throw new Error(`${label} ${address} could not be verified`);
  }
  console.log(`   ✅ ${label} is a verified investor (not a trusted contract)`);
}

/**
 * Helper: D26 caps the human side of every escrow leg, and each release
 * pays the fee wallets, so on a registry-bound VSC their holding cap would
 * eventually refuse every release. Mark them exempt (D22, logged
 * on-chain). No-op without a registry or when already exempt. Owner only:
 * the deployer before the handover, after it an InvestorTypeConfig vote
 * (option 76, type 0, choice 2).
 */
async function _ensureFeeExempt(mod, address, label) {
  const registry = mod.state.getContract("investorTypeRegistry");
  if (!registry || (await registry.investorLimitExempt(address))) return;
  // A contract fee wallet (the MultiSigWallet, Task 4.3) is trusted on
  // VSC: no investor cap applies to it, so there is nothing to exempt.
  if ((await ethers.provider.getCode(address)) !== "0x") return;
  if ((await registry.owner()) !== (await registry.runner.getAddress())) {
    displayWarning(
      `${label} ${address} is not exempt from investor limits: after the handover only an InvestorTypeConfig vote can exempt it (option 76, type 0, choice 2)`,
    );
    return;
  }
  await (await registry.setInvestorLimitExempt(address, true)).wait();
  console.log(`   ✅ ${label} exempt from investor limits (D22)`);
}

/**
 * Helper: who signs registerInvestor (ADMIN_ROLE). The deployer before the
 * handover; step 5 renounces it and ops (wallet 10) holds it after (2F.5
 * review L-4). Null, with the remedy printed, when neither does.
 */
async function _investorAdmin(mod, escrowFactory) {
  const ADMIN = await escrowFactory.ADMIN_ROLE();
  const [deployer, ops] = [mod.state.signers[0], mod.state.signers[10]];
  if (await escrowFactory.hasRole(ADMIN, deployer.address)) return deployer;
  if (ops && (await escrowFactory.hasRole(ADMIN, ops.address))) {
    console.log("   ℹ️  Signing as ops (wallet 10): it holds ADMIN_ROLE");
    return ops;
  }
  displayError(
    "Investor registration is ops' (wallet 10) after the handover, and neither the deployer nor ops holds the factory's ADMIN_ROLE: governance grants it to ops by an EscrowFactoryParameters vote",
  );
  return null;
}

/** Option 62: Register Investor (from Option 23) */
async function registerInvestor(mod) {
  displaySection("REGISTER INVESTOR FOR ENHANCED ESCROW", "👤");

  const escrowFactory = mod.state.getContract("escrowFactory");
  if (!escrowFactory) {
    displayError(
      "Enhanced Escrow not deployed. Please deploy first (option 61)",
    );
    return;
  }

  if (!mod.state.investors || mod.state.investors.size === 0) {
    displayError(
      "No investors found. Please create investors first (Option 23)",
    );
    return;
  }

  // Initialize registeredInvestors if not exists
  if (!mod.state.registeredInvestors) {
    mod.state.registeredInvestors = new Map();
  }

  try {
    const investorArray = Array.from(mod.state.investors.values());
    console.log("\n📋 AVAILABLE INVESTORS:");
    investorArray.forEach((inv, index) => {
      const displayName = inv.name || "Unknown";
      const displayAddress = inv.user || inv.address || "Unknown";
      console.log(`${index}. ${displayName} (${displayAddress})`);
    });

    const choice = await mod.promptUser(
      "\nSelect investor to register (number): ",
    );
    const selectedInvestor = investorArray[parseInt(choice)];

    if (!selectedInvestor) {
      displayError("Invalid selection");
      return;
    }

    // Get the actual investor address (handle different structures)
    const investorAddress = selectedInvestor.user || selectedInvestor.address;

    // ✅ FIX: Use investor's multi-sig wallet as fee wallet if available
    // Otherwise, use the investor's bank address (separate from investor address)
    // This ensures fee wallet is DIFFERENT from investor address
    let investorWallet;

    if (
      selectedInvestor.multiSigWallet &&
      selectedInvestor.multiSigWallet.address
    ) {
      // Use multi-sig wallet if available
      investorWallet = selectedInvestor.multiSigWallet.address;
      console.log(`\n💡 Using investor's multi-sig wallet as fee wallet`);
    } else if (
      selectedInvestor.bank &&
      selectedInvestor.bank !== investorAddress
    ) {
      // Use bank address if available and different from investor
      investorWallet = selectedInvestor.bank;
      console.log(`\n💡 Using investor's bank address as fee wallet`);
    } else {
      // Create a new wallet for fees (use next available signer)
      // Use signer[3] as default fee wallet (different from investor)
      investorWallet = mod.state.signers[3].address;
      console.log(`\n💡 Creating new fee wallet for investor`);
    }

    const admin = await mod._investorAdmin(escrowFactory);
    if (!admin) return;

    // A MultiSigWallet fee wallet (Task 4.3) is a contract trusted on VSC
    // by InvestorRequestManager: no identity, fees released 2-of-2. Any
    // other fee wallet is a human party and must be a verified investor.
    if ((await ethers.provider.getCode(investorWallet)) !== "0x") {
      const rules = mod.state.getContract("complianceRules");
      const vsc = await mod.state.getContract("digitalToken").getAddress();
      if (
        !(await rules["isTrustedContract(address,address)"](
          vsc,
          investorWallet,
        ))
      ) {
        displayError(
          `Fee wallet ${investorWallet} is a contract not trusted on VSC: escrow releases to it would revert`,
        );
        return;
      }
      console.log(
        "   ✅ Fee wallet is the investor's MultiSigWallet: trusted on VSC, fees released by bank + user",
      );
      // 2E.1 interim undone: replace a keyless placeholder fee wallet.
      await retirePlaceholder(
        mod.state,
        escrowFactory,
        admin,
        investorAddress,
        investorWallet,
      );
    } else {
      await mod._ensureVerified(investorWallet, "investor fee wallet");
      await mod._ensureFeeExempt(investorWallet, "investor fee wallet");
    }

    console.log(`\n📝 Registering investor...`);
    console.log(`   Investor Address: ${investorAddress}`);
    console.log(`   Fee Wallet: ${investorWallet}`);

    const tx = await escrowFactory
      .connect(admin)
      .registerInvestor(investorAddress, investorWallet);
    await tx.wait();

    mod.state.registeredInvestors.set(investorAddress, {
      ...selectedInvestor,
      investorAddress: investorAddress,
      walletAddress: investorWallet,
      registeredAt: new Date().toISOString(),
    });

    displaySuccess("Investor registered successfully!");
    console.log(`   Investor Address: ${investorAddress}`);
    console.log(`   Fee Wallet: ${investorWallet}`);
  } catch (error) {
    displayError(`Registration failed: ${error.message}`);
  }
}

module.exports = {
  deployEscrowSystem,
  getSignerForAddress,
  _ensureVerified,
  _ensureFeeExempt,
  _investorAdmin,
  registerInvestor,
};
