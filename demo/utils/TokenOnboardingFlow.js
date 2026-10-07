/**
 * @fileoverview Token option 23 -> 1, 2: onboarding menu, normal user, investor request
 * @module TokenOnboardingFlow
 * @description The investor onboarding menu, the KYC/AML-verified normal user it
 * creates, and the on-chain investor-status request.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { displaySection, displayError } = require("./DisplayHelpers");
const { attestAll, cacheVerification } = require("./Kyc");
const Custody = require("./CustodyFlow");
const { ethers } = require("hardhat");

/** Option 23: Investor Onboarding System */
async function investorOnboarding(mod) {
  displaySection("INVESTOR ONBOARDING SYSTEM", "🏦");
  console.log(
    "Complete workflow: Request → Multi-Sig Wallet → Lock Tokens → Approval",
  );
  console.log("");

  console.log("\n🎯 INVESTOR ONBOARDING OPTIONS:");
  console.log("1. 🆕 Create Normal User (KYC/AML Verified)");
  console.log(
    "2. 🏦 Request Investor Status (Retail/Accredited/Institutional)",
  );
  console.log("3. 💸 Bank Transfers Tokens to User");
  console.log("4. 🔐 Create Multi-Sig Wallet (Bank)");
  console.log("5. 💰 Lock Tokens in Multi-Sig Wallet");
  console.log("6. ✅ Approve Investor Request (Bank)");
  console.log("7. 📊 View All Investor Requests");
  console.log("8. 🔓 Downgrade to Normal User");
  console.log("9. 👥 View All Users & Investors");
  console.log("9a. 📊 View Signer Allocation Status");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select option (0-9a): ");

  try {
    switch (choice) {
      case "1":
        await mod.createNormalUserForOnboarding();
        break;
      case "2":
        await mod.requestInvestorStatus();
        break;
      case "3":
        await mod.bankTransfersTokensToUser();
        break;
      case "4":
        await mod.createMultiSigWalletForInvestor();
        break;
      case "5":
        await mod.lockTokensInMultiSig();
        break;
      case "6":
        await mod.approveInvestorRequest();
        break;
      case "7":
        await mod.viewInvestorRequests();
        break;
      case "8":
        await mod.downgradeToNormalUser();
        break;
      case "9":
        await mod.viewAllInvestors();
        break;
      case "9a":
        mod.displaySignerAllocation();
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`Investor onboarding failed: ${error.message}`);
  }
}

/**
 * Create normal user for investor onboarding system
 * @private
 */
async function createNormalUserForOnboarding(mod) {
  console.log("\n🆕 CREATE NORMAL USER (KYC/AML VERIFIED)");
  console.log("=".repeat(60));
  console.log("Phase 1: User Registration & Compliance");
  console.log("");

  const onchainIDFactory = mod.state.getContract("onchainIDFactory");
  if (!onchainIDFactory) {
    console.log("❌ Please deploy contracts first (option 1)");
    return;
  }

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Please deploy Digital Token system first (option 21)");
    return;
  }

  const userName = await mod.promptUser("Enter user name: ");

  // Get next available signer (skips reserved signers[0-3])
  const signerAllocation = mod.signerManager.getNextAvailableSigner(
    "user",
    userName,
  );
  if (!signerAllocation) {
    console.log("❌ No more available signers. Maximum users reached.");
    console.log("💡 Reserved signers[0-3] for system roles");
    return;
  }

  const signer = signerAllocation.signer;
  const signerIndex = signerAllocation.index;

  try {
    let totalGasUsed = 0n;

    console.log("\n🔗 CREATING NORMAL USER ON-CHAIN...");
    console.log(`👤 User Name: ${userName}`);
    console.log(`🆔 Address: ${signer.address}`);
    console.log(`📋 Initial Type: NORMAL (can upgrade to investor)`);

    // Get dynamic country from jurisdiction rules
    let userCountry = 840; // Default: United States
    let countryName = "United States";

    const complianceRules = mod.state.getContract("complianceRules");
    if (complianceRules) {
      try {
        const tokenAddress = await digitalToken.getAddress();
        const jurisdictionRule =
          await complianceRules.getJurisdictionRule(tokenAddress);

        if (jurisdictionRule.allowedCountries.length > 0) {
          userCountry = Number(jurisdictionRule.allowedCountries[0]);
          const countryMap = {
            840: "United States",
            826: "United Kingdom",
            124: "Canada",
            276: "Germany",
            250: "France",
            392: "Japan",
            702: "Singapore",
            36: "Australia",
          };
          countryName = countryMap[userCountry] || `Country ${userCountry}`;
        }
      } catch (error) {
        console.log("ℹ️  Using default country");
      }
    }

    // Step 1: Create OnchainID
    console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
    const salt = ethers.randomBytes(32);
    const tx1 = await onchainIDFactory.deployOnchainID(signer.address, salt);
    const receipt1 = await tx1.wait();
    totalGasUsed += receipt1.gasUsed;

    const identityAddress = await onchainIDFactory.getIdentityByOwner(
      signer.address,
    );
    console.log(`   ✅ OnchainID Created: ${identityAddress}`);
    console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

    // Step 2 & 3: Issue KYC and AML claims through the trusted
    // ClaimIssuers (KYC issuer owner: signers[2], AML issuer owner:
    // signers[3] — see ContractDeployer.js).
    console.log("\n📝 Step 2: Issuing KYC claim on blockchain...");
    console.log("\n📝 Step 3: Issuing AML claim on blockchain...");
    const { kyc: receipt2, aml: receipt3 } = await attestAll(
      mod.state,
      identityAddress,
      `normal:${userName}`,
    );
    totalGasUsed += receipt2.gasUsed + receipt3.gasUsed;
    console.log(`   ✅ KYC Claim Issued`);
    console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
    console.log(`   ✅ AML Claim Issued`);
    console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);

    // Step 4: Register in IdentityRegistry
    console.log(
      "\n📝 Step 4: Registering in IdentityRegistry on blockchain...",
    );
    const identityRegistry = mod.state.getContract("identityRegistry");
    const tx4 = await identityRegistry.registerIdentity(
      signer.address,
      identityAddress,
      userCountry,
    );
    const receipt4 = await tx4.wait();
    totalGasUsed += receipt4.gasUsed;
    console.log(
      `   ✅ Registered with country: ${userCountry} (${countryName})`,
    );
    console.log(`   ⛽ Gas Used: ${receipt4.gasUsed.toLocaleString()}`);
    console.log("\n📝 Step 4b: Caching verification (refreshVerified)...");
    const { receipt: receipt4b } = await cacheVerification(
      mod.state,
      signer.address,
    );
    totalGasUsed += receipt4b.gasUsed;

    // Step 5: Assign NORMAL investor type
    console.log("\n📝 Step 5: Assigning NORMAL investor type on blockchain...");
    const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
    const tx5 = await investorTypeRegistry.assignInvestorType(
      signer.address,
      0,
    ); // 0 = NORMAL
    const receipt5 = await tx5.wait();
    totalGasUsed += receipt5.gasUsed;
    console.log(`   ✅ Investor Type: NORMAL (can upgrade later)`);
    console.log(`   ⛽ Gas Used: ${receipt5.gasUsed.toLocaleString()}`);

    // Store user record
    const user = {
      name: userName,
      type: "NORMAL",
      address: signer.address,
      onchainId: identityAddress,
      signer: signer,
      signerIndex: signerIndex,
      complianceStatus: "COMPLIANT",
      kycStatus: "ISSUED",
      amlStatus: "ISSUED",
      tokenBalance: 0,
      tokenEligible: true,
      countryCode: userCountry,
      countryName: countryName,
      createdAt: new Date().toISOString(),
      canUpgradeToInvestor: true,
    };

    mod.state.investors.set(signer.address, user);

    console.log("\n✅ NORMAL USER CREATED SUCCESSFULLY!");
    console.log("=".repeat(60));
    console.log(`👤 Name: ${userName}`);
    console.log(`🆔 Address: ${signer.address}`);
    console.log(`🔗 OnchainID: ${identityAddress}`);
    console.log(`📋 Type: NORMAL`);
    console.log(`🌍 Country: ${countryName} (${userCountry})`);
    console.log(`✅ KYC: ISSUED`);
    console.log(`✅ AML: ISSUED`);
    console.log(`📊 Status: COMPLIANT`);
    console.log(
      `⬆️  Can Upgrade: YES (use option 23 -> 2 to request investor status)`,
    );
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
  } catch (error) {
    console.error("❌ User creation failed:", error.message);
    if (error.message.includes("Country not allowed")) {
      console.log("💡 Configure jurisdiction rules first (Option 14)");
    }
  }
}

/**
 * Request investor status upgrade
 * @private
 */
async function requestInvestorStatus(mod) {
  console.log("\n🏦 REQUEST INVESTOR STATUS");
  console.log("=".repeat(60));
  console.log("Phase 2: Investor Request & Approval");
  console.log("");

  // Merge users from both Option 23 (this.state.investors) and Option 24 (this.state.normalUsers)
  const normalUsersFromInvestors = mod.state.investors
    ? Array.from(mod.state.investors.values()).filter(
        (u) => u.type === "NORMAL" || u.type === "NORMAL_USER",
      )
    : [];
  const normalUsersFromOption24 = mod.state.normalUsers
    ? Array.from(mod.state.normalUsers.values())
    : [];

  // Combine both sources
  const normalUsers = [...normalUsersFromInvestors, ...normalUsersFromOption24];

  if (normalUsers.length === 0) {
    console.log("❌ No normal users found!");
    console.log("💡 Create a normal user first (Option 1 or Option 24)");
    return;
  }

  console.log("\n👥 AVAILABLE NORMAL USERS:");
  console.log(
    `   (${normalUsersFromInvestors.length} from Option 23, ${normalUsersFromOption24.length} from Option 24)`,
  );
  normalUsers.forEach((user, index) => {
    const source = normalUsersFromInvestors.includes(user)
      ? "[Option 23]"
      : "[Option 24]";
    console.log(
      `${index + 1}. ${user.name} (${user.address.substring(0, 10)}...) ${source}`,
    );
  });

  const userChoice = await mod.promptUser(
    `\nSelect user (1-${normalUsers.length}): `,
  );
  const selectedUser = normalUsers[parseInt(userChoice) - 1];

  if (!selectedUser) {
    console.log("❌ Invalid selection");
    return;
  }

  // Lock requirements are read from InvestorRequestManager (Task 4.3).
  let manager;
  try {
    manager = await Custody.deployCustody(mod.state);
  } catch (error) {
    displayError(`Custody not available: ${error.message}`);
    return;
  }
  if (!manager) return;
  const typeMap = { 1: "RETAIL", 2: "ACCREDITED", 3: "INSTITUTIONAL" };
  console.log(
    "\n📋 SELECT INVESTOR TYPE (lock held 2-of-2 in a MultiSigWallet):",
  );
  for (const [k, name] of Object.entries(typeMap)) {
    const lock = await manager.lockRequirements(Custody.TYPES[name]);
    console.log(`${k}. ${name} (Lock: ${ethers.formatEther(lock)} VSC)`);
  }

  const typeChoice = await mod.promptUser("Select type (1-3): ");
  const investorType = typeMap[typeChoice];

  if (!investorType) {
    console.log("❌ Invalid type");
    return;
  }

  let request;
  try {
    request = await Custody.requestStatus(
      mod.state,
      selectedUser,
      investorType,
    );
  } catch (error) {
    displayError(`Request refused on chain: ${error.message}`);
    return;
  }
  const lockRequired = ethers.formatEther(request.lock);

  console.log(`\n✅ REQUEST CREATED!`);
  console.log("=".repeat(60));
  console.log(`👤 User: ${selectedUser.name}`);
  console.log(`📋 Requested Type: ${investorType}`);
  console.log(`💰 Required Lock: ${lockRequired} VSC`);
  console.log(`📊 Status: ${request.status.toUpperCase()}`);
  console.log("");
  console.log("🎯 NEXT STEPS:");
  console.log("   1. Bank transfers tokens to user (23 -> 3)");
  console.log("   2. Bank creates multi-sig wallet (23 -> 4)");
  console.log("   3. User locks tokens (23 -> 5)");
  console.log("   4. Bank approves request (23 -> 6)");

  // Store request
  selectedUser.investorRequest = {
    requestedType: investorType,
    status: "PENDING",
    lockRequired,
    createdAt: new Date().toISOString(),
  };

  // If user is from Option 24 (normalUsers), also add to investors Map
  // This ensures they can be tracked through the investor workflow
  if (normalUsersFromOption24.includes(selectedUser)) {
    const userId = selectedUser.id || `user_${Date.now()}`;

    // Convert Option 24 user format to Option 23 format
    const investorUser = {
      ...selectedUser,
      id: userId,
      type: "NORMAL", // Still normal until approved
      investorRequest: selectedUser.investorRequest,
    };

    mod.state.investors.set(userId, investorUser);
    console.log(
      "\n💡 User migrated from Option 24 to investor tracking system",
    );
  }
}

module.exports = {
  investorOnboarding,
  createNormalUserForOnboarding,
  requestInvestorStatus,
};
