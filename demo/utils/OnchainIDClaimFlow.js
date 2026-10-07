/**
 * @fileoverview OnchainID options 6 and 7 sub-actions: issue, reject, update, view, revoke
 * @module OnchainIDClaimFlow
 * @description The per-identity KYC and AML claim actions behind options 6 and 7.
 * Moved out of demo/modules/OnchainIDModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");
const { displaySuccess, displayError } = require("./DisplayHelpers");
const { attestAll, cacheVerification } = require("./Kyc");

// ========== KYC CLAIM HELPER METHODS ==========

/**
 * Issue KYC claim for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function issueKYCClaimForIdentity(mod, identity) {
  console.log(`\n📋 ISSUING KYC CLAIM FOR: ${identity.address}`);

  try {
    // Step 1: Ask for country code (from KYC proof submission)
    console.log("\n🌍 KYC PROOF SUBMISSION - COUNTRY VERIFICATION");
    console.log("=".repeat(70));
    console.log("📋 User submits KYC proof with their country of residence");
    console.log("🔍 ComplianceRules engine will verify if country is allowed");
    console.log("");
    console.log("💡 How it works:");
    console.log("   1. User submits country code with KYC proof");
    console.log("   2. System checks ComplianceRules (whitelist/blacklist)");
    console.log("   3. If country is allowed → KYC claim issued ✅");
    console.log("   4. If country is blocked → KYC claim rejected ❌");
    console.log("");
    console.log("📋 Common Country Codes (ISO 3166-1 numeric):");
    console.log("   840 - United States");
    console.log("   826 - United Kingdom");
    console.log("   124 - Canada");
    console.log("   276 - Germany");
    console.log("   250 - France");
    console.log("   156 - China (may be blocked)");
    console.log("   643 - Russia (may be blocked)");
    console.log("   850 - North Korea (may be blocked)");
    console.log("   364 - Iran (may be blocked)");
    console.log("");

    const countryInput = await mod.promptUser(
      "Enter country code from KYC proof (e.g., 840 for US): ",
    );
    const countryCode = parseInt(countryInput) || 0;

    console.log(`\n🔍 COMPLIANCE CHECK: Verifying country ${countryCode}...`);

    // Step 2: Register identity with jurisdiction validation
    const identityRegistry = mod.state.getContract("identityRegistry");
    if (identityRegistry) {
      try {
        const existingIdentity = await identityRegistry.identity(
          identity.owner,
        );

        if (existingIdentity === identity.address) {
          console.log("\n⚠️  IDENTITY ALREADY REGISTERED");
          console.log(`   Country Code: ${countryCode}`);
          console.log(
            `   ℹ️  Skipping registration, proceeding with KYC claim`,
          );
          identity.countryCode = countryCode;
        } else {
          console.log(
            `\n📝 Registering identity with country code ${countryCode}...`,
          );
          await identityRegistry.registerIdentity(
            identity.owner,
            identity.address,
            countryCode,
          );

          console.log("\n✅ IDENTITY REGISTERED SUCCESSFULLY!");
          console.log(`   Country Code: ${countryCode}`);
          console.log(`   ✅ Jurisdiction rules enforced`);
          identity.countryCode = countryCode;
        }
      } catch (error) {
        if (error.message.includes("already registered")) {
          console.log("\n⚠️  IDENTITY ALREADY REGISTERED");
          console.log(`   Country Code: ${countryCode}`);
          console.log(`   ℹ️  Proceeding with KYC claim`);
          identity.countryCode = countryCode;
        } else if (
          error.message.includes("Country not allowed") ||
          error.message.includes("Country is blocked")
        ) {
          console.log("\n❌ IDENTITY REGISTRATION FAILED!");
          console.log(`   Error: ${error.message}`);
          console.log("\n💡 This means:");
          console.log("   • User's country is BLOCKED by jurisdiction rules");
          console.log("   • User's country is NOT in the allowed list");
          console.log("   • User CANNOT participate in the system");
          console.log("\n❌ KYC CLAIM NOT ISSUED - Country blocked");
          return;
        } else {
          console.log("\n❌ IDENTITY REGISTRATION FAILED!");
          console.log(`   Error: ${error.message}`);
          console.log("\n❌ KYC CLAIM NOT ISSUED");
          return;
        }
      }
    }

    // Step 3: Issue KYC and AML claims through the trusted ClaimIssuers.
    // A claim added directly on the OnchainID with addClaim(...) does NOT
    // verify — IdentityRegistry.isVerified() only accepts claims signed
    // by a trusted issuer via ClaimIssuer.issueClaim, and it now requires
    // both topics (plan Task 1R.3), so a KYC-only attestation here would
    // leave the identity unverified.
    console.log("\n📝 Issuing KYC and AML claims on-chain...");
    await attestAll(mod.state, identity.address, `country:${countryCode}`);
    if (
      identityRegistry &&
      (await identityRegistry.identity(identity.owner)) === identity.address
    )
      await cacheVerification(mod.state, identity.owner);
    const kycIssuerAddr = await mod.state.getContract("kycIssuer").getAddress();

    // Store claim in state
    mod.state.claims.set(`${identity.address}_KYC`, {
      type: "KYC",
      identity: identity.address,
      issuer: kycIssuerAddr,
      countryCode: countryCode,
      status: "ISSUED",
      issuedAt: new Date().toISOString(),
    });

    displaySuccess("KYC CLAIM ISSUED SUCCESSFULLY!");
    console.log(`   Identity: ${identity.address}`);
    console.log(`   Country Code: ${countryCode}`);
    console.log(`   Issuer: ${kycIssuerAddr}`);
  } catch (error) {
    displayError(`KYC claim issuance failed: ${error.message}`);
  }
}

/**
 * Reject KYC claim for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function rejectKYCClaimForIdentity(mod, identity) {
  console.log(`\n❌ REJECTING KYC CLAIM FOR: ${identity.address}`);

  const claim = mod.state.claims.get(`${identity.address}_KYC`);
  if (claim) {
    claim.status = "REJECTED";
    claim.rejectedAt = new Date().toISOString();
    displaySuccess("KYC claim rejected");
  } else {
    displayError("No KYC claim found to reject");
  }
}

/**
 * Update KYC status for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function updateKYCStatusForIdentity(mod, identity) {
  console.log(`\n🔄 UPDATING KYC STATUS FOR: ${identity.address}`);

  const claim = mod.state.claims.get(`${identity.address}_KYC`);
  if (!claim) {
    displayError("No KYC claim found to update");
    return;
  }

  console.log("\n📋 Select new status:");
  console.log("1. ISSUED");
  console.log("2. REJECTED");
  console.log("3. REVOKED");
  console.log("4. EXPIRED");

  const choice = await mod.promptUser("Select status (1-4): ");
  const statusMap = {
    1: "ISSUED",
    2: "REJECTED",
    3: "REVOKED",
    4: "EXPIRED",
  };

  if (statusMap[choice]) {
    claim.status = statusMap[choice];
    claim.updatedAt = new Date().toISOString();
    displaySuccess(`KYC status updated to: ${statusMap[choice]}`);
  } else {
    displayError("Invalid choice");
  }
}

/**
 * View KYC history for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function viewKYCHistoryForIdentity(mod, identity) {
  console.log(`\n📜 KYC HISTORY FOR: ${identity.address}`);
  console.log("=".repeat(50));

  const claim = mod.state.claims.get(`${identity.address}_KYC`);
  if (!claim) {
    console.log("❌ No KYC claim found");
    return;
  }

  console.log(`\n📋 KYC Claim Details:`);
  console.log(`   Status: ${claim.status}`);
  console.log(`   Issuer: ${claim.issuer}`);
  console.log(`   Country Code: ${claim.countryCode}`);
  console.log(`   Issued At: ${claim.issuedAt}`);
  if (claim.updatedAt) console.log(`   Updated At: ${claim.updatedAt}`);
  if (claim.rejectedAt) console.log(`   Rejected At: ${claim.rejectedAt}`);
  if (claim.revokedAt) console.log(`   Revoked At: ${claim.revokedAt}`);
}

/**
 * Revoke KYC claim for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function revokeKYCClaimForIdentity(mod, identity) {
  console.log(`\n🚫 REVOKING KYC CLAIM FOR: ${identity.address}`);

  const claim = mod.state.claims.get(`${identity.address}_KYC`);
  if (claim) {
    claim.status = "REVOKED";
    claim.revokedAt = new Date().toISOString();
    displaySuccess("KYC claim revoked");
  } else {
    displayError("No KYC claim found to revoke");
  }
}

// ========== AML CLAIM HELPER METHODS ==========

/**
 * Issue AML claim for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function issueAMLClaimForIdentity(mod, identity) {
  console.log(`\n🔍 ISSUING AML CLAIM FOR: ${identity.address}`);

  try {
    const amlIssuer = mod.state.signers[2]; // AML issuer
    const claimTopics = [2]; // AML topic
    const claimData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bool"],
      [true],
    );

    console.log("\n📝 Issuing AML claim on-chain...");
    const OnchainID = await ethers.getContractFactory("OnchainID");
    const identityContract = OnchainID.attach(identity.address);

    await mod.logger.logTransaction(
      "AML Claim Issuance",
      identityContract.connect(amlIssuer).addClaim(
        claimTopics[0],
        1, // scheme
        amlIssuer.address,
        "0x", // signature
        claimData,
        "",
      ),
      {
        identity: identity.address,
        topic: claimTopics[0],
        issuer: amlIssuer.address,
      },
    );

    // Store claim in state
    mod.state.claims.set(`${identity.address}_AML`, {
      type: "AML",
      identity: identity.address,
      issuer: amlIssuer.address,
      status: "ISSUED",
      issuedAt: new Date().toISOString(),
    });

    displaySuccess("AML CLAIM ISSUED SUCCESSFULLY!");
    console.log(`   Identity: ${identity.address}`);
    console.log(`   Issuer: ${amlIssuer.address}`);
  } catch (error) {
    displayError(`AML claim issuance failed: ${error.message}`);
  }
}

/**
 * Reject AML claim for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function rejectAMLClaimForIdentity(mod, identity) {
  console.log(`\n❌ REJECTING AML CLAIM FOR: ${identity.address}`);

  const claim = mod.state.claims.get(`${identity.address}_AML`);
  if (claim) {
    claim.status = "REJECTED";
    claim.rejectedAt = new Date().toISOString();
    displaySuccess("AML claim rejected");
  } else {
    displayError("No AML claim found to reject");
  }
}

/**
 * Update AML status for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function updateAMLStatusForIdentity(mod, identity) {
  console.log(`\n🔄 UPDATING AML STATUS FOR: ${identity.address}`);

  const claim = mod.state.claims.get(`${identity.address}_AML`);
  if (!claim) {
    displayError("No AML claim found to update");
    return;
  }

  console.log("\n📋 Select new status:");
  console.log("1. ISSUED");
  console.log("2. REJECTED");
  console.log("3. REVOKED");
  console.log("4. EXPIRED");

  const choice = await mod.promptUser("Select status (1-4): ");
  const statusMap = {
    1: "ISSUED",
    2: "REJECTED",
    3: "REVOKED",
    4: "EXPIRED",
  };

  if (statusMap[choice]) {
    claim.status = statusMap[choice];
    claim.updatedAt = new Date().toISOString();
    displaySuccess(`AML status updated to: ${statusMap[choice]}`);
  } else {
    displayError("Invalid choice");
  }
}

/**
 * View AML history for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function viewAMLHistoryForIdentity(mod, identity) {
  console.log(`\n📜 AML HISTORY FOR: ${identity.address}`);
  console.log("=".repeat(50));

  const claim = mod.state.claims.get(`${identity.address}_AML`);
  if (!claim) {
    console.log("❌ No AML claim found");
    return;
  }

  console.log(`\n🔍 AML Claim Details:`);
  console.log(`   Status: ${claim.status}`);
  console.log(`   Issuer: ${claim.issuer}`);
  console.log(`   Issued At: ${claim.issuedAt}`);
  if (claim.updatedAt) console.log(`   Updated At: ${claim.updatedAt}`);
  if (claim.rejectedAt) console.log(`   Rejected At: ${claim.rejectedAt}`);
  if (claim.revokedAt) console.log(`   Revoked At: ${claim.revokedAt}`);
}

/**
 * Revoke AML claim for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function revokeAMLClaimForIdentity(mod, identity) {
  console.log(`\n🚫 REVOKING AML CLAIM FOR: ${identity.address}`);

  const claim = mod.state.claims.get(`${identity.address}_AML`);
  if (claim) {
    claim.status = "REVOKED";
    claim.revokedAt = new Date().toISOString();
    displaySuccess("AML claim revoked");
  } else {
    displayError("No AML claim found to revoke");
  }
}

module.exports = {
  issueKYCClaimForIdentity,
  rejectKYCClaimForIdentity,
  updateKYCStatusForIdentity,
  viewKYCHistoryForIdentity,
  revokeKYCClaimForIdentity,
  issueAMLClaimForIdentity,
  rejectAMLClaimForIdentity,
  updateAMLStatusForIdentity,
  viewAMLHistoryForIdentity,
  revokeAMLClaimForIdentity,
};
