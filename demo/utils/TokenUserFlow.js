/**
 * @fileoverview Token option 24: normal users
 * @module TokenUserFlow
 * @description Creates compliant and non-compliant normal users on chain and lists
 * them.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { displaySection, displayError } = require("./DisplayHelpers");
const { attestAll, cacheVerification, signClaim } = require("./Kyc");
const { ethers } = require("hardhat");

/** Option 24: Create Normal Users */
async function createNormalUsers(mod) {
  displaySection("CREATE NORMAL USERS (OnchainID)", "👤");

  if (!mod.state.digitalToken) {
    displayError(
      "Please deploy ERC-3643 Vanguard StableCoin system first (option 21)",
    );
    return;
  }

  console.log("\n🎯 NORMAL USER CREATION OPTIONS:");
  console.log("1. Create Compliant User (KYC: ISSUED, AML: ISSUED)");
  console.log("2. Create Non-Compliant User (KYC: REJECTED)");
  console.log("3. View All Normal Users");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select user creation option (0-3): ");

  try {
    switch (choice) {
      case "1":
        await mod.createCompliantNormalUser();
        break;
      case "2":
        await mod.createNonCompliantNormalUser();
        break;
      case "3":
        await mod.viewAllNormalUsers();
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Normal user creation failed:", error.message);
  }
}

/**
 * Create a compliant normal user with KYC/AML claims
 * @private
 */
async function createCompliantNormalUser(mod) {
  console.log("\n✅ CREATING COMPLIANT NORMAL USER - ON-CHAIN");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  const userName = await mod.promptUser("Enter user name: ");

  try {
    let totalGasUsed = 0n;

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

    console.log("\n🔗 CREATING NORMAL USER ON-CHAIN...");
    console.log(`👤 User Name: ${userName}`);
    console.log(`🆔 Address: ${signer.address}`);
    console.log(`📍 Signer Index: [${signerIndex}]`);

    // Step 1: Create OnchainID on blockchain
    console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
    const salt = ethers.randomBytes(32);
    const onchainIDFactory = mod.state.getContract("onchainIDFactory");
    const tx1 = await onchainIDFactory.deployOnchainID(signer.address, salt);
    const receipt1 = await tx1.wait();
    totalGasUsed += receipt1.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt1.hash}`);
    console.log(`   🧱 Block Number: ${receipt1.blockNumber}`);
    console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

    // Get the created identity address
    const identityAddress = await onchainIDFactory.getIdentityByOwner(
      signer.address,
    );
    console.log(`   🆔 OnchainID Created: ${identityAddress}`);

    // Step 2 & 3: Issue KYC and AML claims on blockchain through the
    // trusted ClaimIssuers (KYC issuer owner: signers[2], AML issuer
    // owner: signers[3] — see ContractDeployer.js).
    console.log("\n📝 Step 2: Issuing KYC claim on blockchain...");
    console.log("\n📝 Step 3: Issuing AML claim on blockchain...");
    const { kyc: receipt2, aml: receipt3 } = await attestAll(
      mod.state,
      identityAddress,
      `retail:${userName}`,
    );
    totalGasUsed += receipt2.gasUsed + receipt3.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt2.hash}`);
    console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
    console.log(`   ✅ Transaction Hash: ${receipt3.hash}`);
    console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);

    // Step 4: Register in IdentityRegistry on blockchain
    console.log(
      "\n📝 Step 4: Registering in IdentityRegistry on blockchain...",
    );

    // Get allowed country from ComplianceRules configuration
    let userCountry = 840; // Default: USA
    try {
      const complianceRules = mod.state.getContract("complianceRules");
      if (complianceRules) {
        const tokenAddress = await digitalToken.getAddress();
        const jurisdictionRule =
          await complianceRules.getJurisdictionRule(tokenAddress);

        if (jurisdictionRule.allowedCountries.length > 0) {
          userCountry = Number(jurisdictionRule.allowedCountries[0]);
          console.log(`   🌍 Using whitelisted country: ${userCountry}`);
        } else {
          console.log(`   🌍 Using default country: ${userCountry} (USA)`);
        }
      }
    } catch (error) {
      console.log(`   🌍 Using default country: ${userCountry} (USA)`);
    }

    const identityRegistry = mod.state.getContract("identityRegistry");
    const tx4 = await identityRegistry.registerIdentity(
      signer.address,
      identityAddress,
      userCountry,
    );
    const receipt4 = await tx4.wait();
    totalGasUsed += receipt4.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt4.hash}`);
    console.log(`   ⛽ Gas Used: ${receipt4.gasUsed.toLocaleString()}`);
    console.log(`   🌍 Country Code: ${userCountry}`);

    console.log("\n📝 Step 4b: Caching verification (refreshVerified)...");
    const { receipt: receipt4b } = await cacheVerification(
      mod.state,
      signer.address,
    );
    totalGasUsed += receipt4b.gasUsed;

    // Verify registration on-chain
    const isVerified = await identityRegistry.isVerified(signer.address);
    console.log(
      `   ${isVerified ? "✅" : "❌"} Verified on-chain: ${isVerified}`,
    );

    // Create user record
    const userId = `user_${Date.now()}`;
    const user = {
      id: userId,
      name: userName,
      address: signer.address,
      onchainId: identityAddress,
      signer: signer,
      signerIndex: signerIndex,
      type: "NORMAL_USER",
      kycStatus: "ISSUED",
      amlStatus: "ISSUED",
      complianceStatus: "COMPLIANT",
      tokenEligible: true,
      createdAt: new Date().toISOString(),
      tokenBalance: 0,
      maxReceiveAmount: 8000,
    };

    // Store in normal users map
    mod.state.normalUsers.set(userId, user);

    console.log("\n🎉 COMPLIANT NORMAL USER CREATED ON-CHAIN!");
    console.log("=".repeat(60));
    console.log(`👤 Name: ${userName}`);
    console.log(`🆔 Address: ${signer.address}`);
    console.log(`🔗 OnchainID: ${identityAddress}`);
    console.log(`✅ KYC Status: ISSUED (on-chain)`);
    console.log(`✅ AML Status: ISSUED (on-chain)`);
    console.log(`💰 Token Eligible: YES`);
    console.log(`📏 Max Receive: 8,000 VSC per transaction`);
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    console.log("\n💡 This user can receive tokens from investors");
  } catch (error) {
    console.error("❌ User creation failed:", error.message);
    console.log("💡 Make sure you deployed contracts first (option 1)");
  }
}

/**
 * Create a non-compliant normal user with rejected KYC
 * @private
 */
async function createNonCompliantNormalUser(mod) {
  console.log("\n❌ CREATING NON-COMPLIANT NORMAL USER - ON-CHAIN");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
    return;
  }

  const userName = await mod.promptUser("Enter user name: ");
  const reason = await mod.promptUser("Rejection reason: ");

  try {
    let totalGasUsed = 0n;

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

    console.log("\n🔗 CREATING NON-COMPLIANT USER ON-CHAIN...");
    console.log(`👤 User Name: ${userName}`);
    console.log(`🆔 Address: ${signer.address}`);
    console.log(`📍 Signer Index: [${signerIndex}]`);

    // Step 1: Create OnchainID on blockchain
    console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
    const salt = ethers.randomBytes(32);
    const onchainIDFactory = mod.state.getContract("onchainIDFactory");
    const tx1 = await onchainIDFactory.deployOnchainID(signer.address, salt);
    const receipt1 = await tx1.wait();
    totalGasUsed += receipt1.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt1.hash}`);
    console.log(`   🧱 Block Number: ${receipt1.blockNumber}`);
    console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

    // Get the created identity address
    const identityAddress = await onchainIDFactory.getIdentityByOwner(
      signer.address,
    );
    console.log(`   🆔 OnchainID Created: ${identityAddress}`);

    // Step 2: Issue REJECTED KYC claim on blockchain
    // NOTE: KYC issuer uses signers[2] (from ContractDeployer.js)
    console.log("\n📝 Step 2: Issuing REJECTED KYC claim on blockchain...");
    const kycTopic = 1;
    const kycData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string"],
      ["REJECTED", userName, reason],
    );

    const kycIssuer = mod.state.getContract("kycIssuer");
    const kycSigner = mod.state.signers[2];
    const kycSig = await signClaim(
      kycSigner,
      identityAddress,
      kycTopic,
      kycData,
    );
    const tx2 = await kycIssuer.connect(kycSigner).issueClaim(
      identityAddress,
      kycTopic,
      1, // scheme: ECDSA signature
      kycData,
      "", // uri: empty for now
      0, // validTo: 0 = no expiry
      kycSig,
    );
    const receipt2 = await tx2.wait();
    totalGasUsed += receipt2.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt2.hash}`);
    console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
    console.log(`   ❌ KYC Status: REJECTED`);

    // Note: Do NOT register in IdentityRegistry - non-compliant users are not verified

    // Create user record
    const userId = `user_${Date.now()}`;
    const user = {
      id: userId,
      name: userName,
      address: signer.address,
      onchainId: identityAddress,
      signer: signer,
      signerIndex: signerIndex,
      type: "NORMAL_USER",
      kycStatus: "REJECTED",
      amlStatus: "NOT_ISSUED",
      complianceStatus: "NON_COMPLIANT",
      tokenEligible: false,
      rejectionReason: reason,
      createdAt: new Date().toISOString(),
      tokenBalance: 0,
    };

    // Store in normal users map
    mod.state.normalUsers.set(userId, user);

    console.log("\n❌ NON-COMPLIANT NORMAL USER CREATED ON-CHAIN!");
    console.log("=".repeat(60));
    console.log(`👤 Name: ${userName}`);
    console.log(`🆔 Address: ${signer.address}`);
    console.log(`🔗 OnchainID: ${identityAddress}`);
    console.log(`❌ KYC Status: REJECTED (on-chain)`);
    console.log(`❌ AML Status: NOT_ISSUED`);
    console.log(`💰 Token Eligible: NO`);
    console.log(`📝 Reason: ${reason}`);
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    console.log("\n💡 This user CANNOT receive tokens (not verified on-chain)");
  } catch (error) {
    console.error("❌ User creation failed:", error.message);
    console.log("💡 Make sure you deployed contracts first (option 1)");
  }
}

/**
 * View all normal users
 * @private
 */
async function viewAllNormalUsers(mod) {
  console.log("\n👤 ALL NORMAL USERS OVERVIEW");
  console.log("-".repeat(40));

  if (mod.state.normalUsers.size === 0) {
    console.log("\n📊 NO NORMAL USERS CREATED YET");
    console.log("💡 Create normal users using options 1-2 above");
    return;
  }

  // Count users by compliance status
  let compliantCount = 0;
  let nonCompliantCount = 0;

  console.log("\n📋 DETAILED NORMAL USER LIST:");
  let index = 1;
  for (const [id, user] of mod.state.normalUsers) {
    console.log(`\n${index}. ${user.name}`);
    console.log(`   🆔 ID: ${id}`);
    console.log(`   📋 Type: ${user.type}`);
    console.log(
      `   🎯 KYC: ${user.kycStatus} ${user.kycStatus === "ISSUED" ? "✅" : "❌"}`,
    );
    console.log(
      `   🔍 AML: ${user.amlStatus} ${user.amlStatus === "ISSUED" ? "✅" : "❌"}`,
    );
    console.log(
      `   💰 Token Eligible: ${user.tokenEligible ? "YES ✅" : "NO ❌"}`,
    );
    console.log(`   💳 Balance: ${user.tokenBalance} VSC`);
    console.log(`   📅 Created: ${new Date(user.createdAt).toLocaleString()}`);

    if (user.rejectionReason) {
      console.log(`   📝 Rejection: ${user.rejectionReason}`);
    }

    if (user.tokenEligible) {
      compliantCount++;
    } else {
      nonCompliantCount++;
    }

    index++;
  }

  console.log("\n📊 NORMAL USER SUMMARY:");
  console.log(`   Total Users: ${mod.state.normalUsers.size}`);
  console.log(`   ✅ Compliant: ${compliantCount}`);
  console.log(`   ❌ Non-Compliant: ${nonCompliantCount}`);
  console.log(
    "\n💡 Only compliant users can receive Vanguard StableCoin from investors",
  );
}

module.exports = {
  createNormalUsers,
  createCompliantNormalUser,
  createNonCompliantNormalUser,
  viewAllNormalUsers,
};
