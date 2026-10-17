/**
 * @fileoverview OnchainID options 6, 7, 8, 11: claim menus, history, expiry
 * @module OnchainIDClaimMenuFlow
 * @description The KYC and AML claim menus, the claim status review and the
 * short-lived claim expiry demo.
 * Moved out of demo/modules/OnchainIDModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const { displaySection, displayError } = require("./DisplayHelpers");
const {
  attestKyc,
  attestAml,
  cacheVerification,
  KYC_TOPIC,
  AML_TOPIC,
  issuerOwnerSigner,
} = require("./Kyc");
const { onboard } = require("./Onboard");
const ChainTime = require("./ChainTime");

/**
 * Option 6: Manage KYC claims
 *
 * @returns {Promise<void>}
 */
async function manageKYCClaims(mod) {
  displaySection("KYC CLAIM MANAGEMENT", "📋");

  if (mod.state.identities.size === 0) {
    displayError("Please create OnchainID first (option 3)");
    return;
  }

  // Show available identities
  console.log("\n🆔 Available Identities:");
  let index = 0;
  const identityArray = Array.from(mod.state.identities.values());
  for (const identity of identityArray) {
    const kycClaim = mod.state.claims.get(`${identity.address}_KYC`);
    const status = kycClaim ? kycClaim.status || "ISSUED" : "NOT_ISSUED";
    console.log(
      `   ${index}: ${identity.address} (Owner: ${identity.owner}) - KYC: ${status}`,
    );
    index++;
  }

  const identityIndex = await mod.promptUser(
    `Select identity (0-${identityArray.length - 1}): `,
  );
  const selectedIdentity = identityArray[parseInt(identityIndex)];

  if (!selectedIdentity) {
    displayError("Invalid identity selection");
    return;
  }

  // Show KYC management options
  console.log(`\n🔐 KYC Management for: ${selectedIdentity.address}`);
  console.log("1. Issue KYC Claim");
  console.log("2. Reject KYC Claim");
  console.log("3. Update KYC Status");
  console.log("4. View KYC History");
  console.log("5. Revoke KYC Claim");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select KYC action (0-5): ");

  try {
    switch (choice) {
      case "1":
        await mod.issueKYCClaimForIdentity(selectedIdentity);
        break;
      case "2":
        await mod.rejectKYCClaimForIdentity(selectedIdentity);
        break;
      case "3":
        await mod.updateKYCStatusForIdentity(selectedIdentity);
        break;
      case "4":
        await mod.viewKYCHistoryForIdentity(selectedIdentity);
        break;
      case "5":
        await mod.revokeKYCClaimForIdentity(selectedIdentity);
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`KYC management failed: ${error.message}`);
  }
}

/**
 * Option 7: Manage AML claims
 *
 * @returns {Promise<void>}
 */
async function manageAMLClaims(mod) {
  displaySection("AML CLAIM MANAGEMENT", "🔍");

  if (mod.state.identities.size === 0) {
    displayError("Please create OnchainID first (option 3)");
    return;
  }

  // Show available identities
  console.log("\n🆔 Available Identities:");
  let index = 0;
  const identityArray = Array.from(mod.state.identities.values());
  for (const identity of identityArray) {
    const amlClaim = mod.state.claims.get(`${identity.address}_AML`);
    const status = amlClaim ? amlClaim.status || "ISSUED" : "NOT_ISSUED";
    console.log(
      `   ${index}: ${identity.address} (Owner: ${identity.owner}) - AML: ${status}`,
    );
    index++;
  }

  const identityIndex = await mod.promptUser(
    `Select identity (0-${identityArray.length - 1}): `,
  );
  const selectedIdentity = identityArray[parseInt(identityIndex)];

  if (!selectedIdentity) {
    displayError("Invalid identity selection");
    return;
  }

  // Show AML management options
  console.log(`\n🔐 AML Management for: ${selectedIdentity.address}`);
  console.log("1. Issue AML Claim");
  console.log("2. Reject AML Claim");
  console.log("3. Update AML Status");
  console.log("4. View AML History");
  console.log("5. Revoke AML Claim");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select AML action (0-5): ");

  try {
    switch (choice) {
      case "1":
        await mod.issueAMLClaimForIdentity(selectedIdentity);
        break;
      case "2":
        await mod.rejectAMLClaimForIdentity(selectedIdentity);
        break;
      case "3":
        await mod.updateAMLStatusForIdentity(selectedIdentity);
        break;
      case "4":
        await mod.viewAMLHistoryForIdentity(selectedIdentity);
        break;
      case "5":
        await mod.revokeAMLClaimForIdentity(selectedIdentity);
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`AML management failed: ${error.message}`);
  }
}

/**
 * Option 8: Review claim status and history
 *
 * @returns {Promise<void>}
 */
async function reviewClaimStatusHistory(mod) {
  displaySection("REVIEW CLAIM STATUS & HISTORY", "📊");

  if (mod.state.identities.size === 0) {
    displayError(
      "No identities found. Please create OnchainID first (option 3)",
    );
    return;
  }

  // Every status below is a chain read: the issuer's hasValidClaim (the
  // identity's latest claim on the topic is live) and the registry's
  // isVerified for the owner; the demo's own records give only the times.
  const kycIssuer = mod.state.getContract("kycIssuer");
  const amlIssuer = mod.state.getContract("amlIssuer");
  const registry = mod.state.getContract("identityRegistry");
  const live = (ok) => (ok ? "✅ LIVE" : "▫️ NONE");
  let kycLive = 0;
  let amlLive = 0;

  console.log("\n🆔 IDENTITY CLAIM STATUS (chain reads):");
  console.log("=".repeat(70));

  for (const identity of mod.state.identities.values()) {
    const kycOk = await kycIssuer.hasValidClaim(identity.address, KYC_TOPIC);
    const amlOk = await amlIssuer.hasValidClaim(identity.address, AML_TOPIC);
    if (kycOk) kycLive++;
    if (amlOk) amlLive++;
    const kycClaim = mod.state.claims.get(`${identity.address}_KYC`);
    const amlClaim = mod.state.claims.get(`${identity.address}_AML`);

    console.log(`\n👤 Identity: ${identity.address}`);
    console.log(`   Owner: ${identity.owner}`);
    console.log(`   Created: ${identity.createdAt} (demo record)`);
    console.log(
      `   📋 KYC: ${live(kycOk)} (chain: kycIssuer.hasValidClaim)${kycClaim?.issuedAt ? `, last demo issue ${kycClaim.issuedAt}` : ""}`,
    );
    console.log(
      `   🔍 AML: ${live(amlOk)} (chain: amlIssuer.hasValidClaim)${amlClaim?.issuedAt ? `, last demo issue ${amlClaim.issuedAt}` : ""}`,
    );
    const verified = await registry.isVerified(identity.owner);
    console.log(
      `   🪪 Owner verified: ${verified ? "✅ yes" : "▫️ no"} (chain: identityRegistry.isVerified)`,
    );
  }

  console.log("\n" + "=".repeat(70));
  console.log(`📊 Total Identities: ${mod.state.identities.size}`);
  console.log(`✅ KYC Issued: ${kycLive} (chain: hasValidClaim)`);
  console.log(`✅ AML Issued: ${amlLive} (chain: hasValidClaim)`);
}

/**
 * Option 11: Demo claim expiry. Issues a KYC claim valid for 60 seconds,
 * advances the local node past it, and shows isVerified() flip false then
 * true again after re-attestation (plan Task 1R.6).
 *
 * @returns {Promise<void>}
 */
async function demoClaimExpiry(mod) {
  displaySection("DEMO: KYC CLAIM EXPIRY", "⏳");
  if (mod.state.identities.size === 0) {
    displayError("Please create OnchainID first (option 3)");
    return;
  }
  // Readiness review L-2: the demo jumps the clock 120 s, which only a dev
  // node can; elsewhere it refuses before sending anything. Read through
  // the module so a test can stand in for a public chain.
  if (!(await ChainTime.canJumpTime())) {
    displayError(
      "Option 11 needs a dev node (it jumps the clock past a 60 s claim); on a public chain issue a short claim (option 6) and read it after expiry (option 8)",
    );
    return;
  }
  const identityArray = Array.from(mod.state.identities.values());
  console.log("\n🆔 Available Identities:");
  identityArray.forEach((id, i) =>
    console.log(`   ${i}: ${id.address} (Owner: ${id.owner})`),
  );
  const idx = parseInt(
    await mod.promptUser(`Select identity (0-${identityArray.length - 1}): `),
  );
  const identity = identityArray[idx];
  if (!identity) {
    displayError("Invalid identity selection");
    return;
  }

  try {
    const registry = mod.state.getContract("identityRegistry");
    // The registry entry if missing (Onboard.js, Task 4.16); the claims
    // below are this demo's own (a short-lived KYC claim).
    await onboard(mod.state, identity.owner, {
      country: 840,
      attest: false,
      cache: false,
    });
    // AML is required too (Task 1R.3): without it isVerified() never
    // returns true regardless of the KYC claim below.
    // Each issuer's current owner signs (Task 4.13: the deployer before
    // the handover, the issuer admin after it).
    const amlIssuer = mod.state.getContract("amlIssuer");
    const kycIssuer = mod.state.getContract("kycIssuer");
    await attestAml(
      amlIssuer,
      await issuerOwnerSigner(mod.state, amlIssuer),
      identity.address,
      "expiry-demo",
    );
    const issueKyc = async (label, validTo) =>
      attestKyc(
        kycIssuer,
        await issuerOwnerSigner(mod.state, kycIssuer),
        identity.address,
        label,
        validTo,
      );
    const verified = () => registry.isVerified(identity.owner);
    const shortValidTo =
      (await ethers.provider.getBlock("latest")).timestamp + 60;

    await issueKyc("expiry-demo-short", shortValidTo);
    // The new claim supersedes the old one; a cache entry from onboarding
    // would keep verifying until it lapses. Refresh: the entry is now
    // capped at this claim's expiry (Task 4.9).
    console.log("\n🔄 Refreshing the verification cache (anyone may)...");
    await cacheVerification(mod.state, identity.owner);
    console.log(
      `✅ Short-lived KYC claim issued (60s). isVerified: ${await verified()}`,
    );

    console.log("\n⏰ Advancing chain time by 120 seconds...");
    await ethers.provider.send("evm_increaseTime", [120]);
    await ethers.provider.send("evm_mine", []);
    const afterExpiry = await verified();
    console.log(
      afterExpiry
        ? "❌ After expiry: isVerified still true — expiry not enforced (chain read)"
        : "✅ After expiry: isVerified false, as expected (chain read)",
    );

    await issueKyc("expiry-demo-renewed");
    await cacheVerification(mod.state, identity.owner);
    console.log(
      `✅ Re-attested with default validity. isVerified: ${await verified()}`,
    );
  } catch (error) {
    displayError(`Claim expiry demo failed: ${error.message}`);
  }
}

module.exports = {
  manageKYCClaims,
  manageAMLClaims,
  reviewClaimStatusHistory,
  demoClaimExpiry,
};
