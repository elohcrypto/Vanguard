/**
 * @fileoverview OnchainID options 6 and 7 sub-actions: issue, reject, update, view, revoke
 * @module OnchainIDClaimFlow
 * @description The per-identity KYC and AML claim actions behind options 6 and 7.
 * Moved out of demo/modules/OnchainIDModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const { markRevoked, updateStatus } = require("./OnchainIDClaimChain");
const { displaySuccess, displayError } = require("./DisplayHelpers");
const {
  attestAml,
  cacheVerification,
  issuerOwnerSigner,
  AML_TOPIC,
} = require("./Kyc");
const { onboard } = require("./Onboard");

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

    // Steps 2-3: the demo's one onboarding path (Onboard.js, Task 4.16):
    // the registry entry with the chosen country (the jurisdiction rule
    // decides; an entry that exists is kept), then both claims through the
    // trusted ClaimIssuers (a claim added directly on the OnchainID never
    // verifies: isVerified() reads only issuer-signed claims, both topics,
    // plan Task 1R.3), then the verification cache.
    const identityRegistry = mod.state.getContract("identityRegistry");
    const registered =
      identityRegistry &&
      (await identityRegistry.identity(identity.owner)) !== ethers.ZeroAddress;
    console.log(
      registered
        ? `\n⚠️  IDENTITY ALREADY REGISTERED: proceeding with the claims`
        : `\n📝 Registering identity with country code ${countryCode}, then the claims...`,
    );
    try {
      await onboard(mod.state, identity.owner, {
        country: countryCode,
        label: `country:${countryCode}`,
        register: Boolean(identityRegistry),
        cache: Boolean(identityRegistry),
      });
    } catch (error) {
      if (
        error.message.includes("Country not allowed") ||
        error.message.includes("Country is blocked")
      ) {
        console.log("\n⛔ Registration refused by the jurisdiction rule");
        console.log(`   ${error.message}`);
        console.log(
          "   The user's country is blocked or not allowed: no claim issued",
        );
        return;
      }
      throw error;
    }
    identity.countryCode = countryCode;
    if (!registered && identityRegistry) {
      console.log("✅ IDENTITY REGISTERED (jurisdiction rule passed)");
    }
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
  console.log(`\n🚫 REJECTING KYC CLAIM FOR: ${identity.address}`);
  await markRevoked(mod.state, identity, "KYC", "REJECTED");
}

/**
 * Update KYC status for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function updateKYCStatusForIdentity(mod, identity) {
  console.log(`\n🔄 UPDATING KYC STATUS FOR: ${identity.address}`);
  await updateStatus(mod, identity, "KYC");
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
    console.log("ℹ️  No KYC claim found");
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
  await markRevoked(mod.state, identity, "KYC", "REVOKED");
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
    // Through the AML ClaimIssuer (wallet 3 signs, as Kyc.attestAll does):
    // the only AML claim IdentityRegistry.isVerified() reads.
    const amlIssuer = mod.state.getContract("amlIssuer");
    const amlIssuerAddr = await amlIssuer.getAddress();
    console.log("\n📝 Issuing AML claim on-chain (ClaimIssuer.issueClaim)...");
    const code = identity.countryCode ?? 0;
    const rc = await attestAml(
      amlIssuer,
      await issuerOwnerSigner(mod.state, amlIssuer), // its owner signs (4.13)
      identity.address,
      `country:${code}`,
    );
    console.log(`   ✅ issueClaim mined in block ${rc.blockNumber}`);
    const registry = mod.state.getContract("identityRegistry");
    if (
      registry &&
      (await registry.identity(identity.owner)) === identity.address
    )
      await cacheVerification(mod.state, identity.owner);
    const valid = await amlIssuer.hasValidClaim(identity.address, AML_TOPIC);
    if (!valid) {
      displayError("AML claim not valid on chain after issuance");
      return;
    }

    // Store claim in state
    mod.state.claims.set(`${identity.address}_AML`, {
      type: "AML",
      identity: identity.address,
      issuer: amlIssuerAddr,
      status: "ISSUED",
      issuedAt: new Date().toISOString(),
    });

    displaySuccess("AML CLAIM ISSUED (hasValidClaim true, chain)");
    console.log(`   Identity: ${identity.address}`);
    console.log(`   Issuer: ${amlIssuerAddr}`);
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
  console.log(`\n🚫 REJECTING AML CLAIM FOR: ${identity.address}`);
  await markRevoked(mod.state, identity, "AML", "REJECTED");
}

/**
 * Update AML status for an identity
 * @param {Object} identity - Identity object
 * @returns {Promise<void>}
 * @private
 */
async function updateAMLStatusForIdentity(mod, identity) {
  console.log(`\n🔄 UPDATING AML STATUS FOR: ${identity.address}`);
  await updateStatus(mod, identity, "AML");
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
    console.log("ℹ️  No AML claim found");
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
  await markRevoked(mod.state, identity, "AML", "REVOKED");
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
