/**
 * @fileoverview OnchainID options 6, 7, 8, 11: claim menus, history, expiry
 * @module OnchainIDClaimMenuFlow
 * @description The KYC and AML claim menus, the claim status review and the
 * short-lived claim expiry demo.
 * Moved out of demo/modules/OnchainIDModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");
const { displaySection, displayError } = require("./DisplayHelpers");
const { attestKyc, attestAml, cacheVerification } = require("./Kyc");

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

  console.log("\n🆔 IDENTITY CLAIM STATUS:");
  console.log("=".repeat(70));

  for (const identity of mod.state.identities.values()) {
    const kycClaim = mod.state.claims.get(`${identity.address}_KYC`);
    const amlClaim = mod.state.claims.get(`${identity.address}_AML`);

    console.log(`\n👤 Identity: ${identity.address}`);
    console.log(`   Owner: ${identity.owner}`);
    console.log(`   Created: ${identity.createdAt}`);

    // KYC Status
    if (kycClaim) {
      console.log(`   📋 KYC: ${kycClaim.status || "ISSUED"}`);
      console.log(`      Issued: ${kycClaim.issuedAt}`);
      if (kycClaim.countryCode) {
        console.log(`      Country: ${kycClaim.countryCode}`);
      }
    } else {
      console.log(`   📋 KYC: NOT_ISSUED`);
    }

    // AML Status
    if (amlClaim) {
      console.log(`   🔍 AML: ${amlClaim.status || "ISSUED"}`);
      console.log(`      Issued: ${amlClaim.issuedAt}`);
    } else {
      console.log(`   🔍 AML: NOT_ISSUED`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`📊 Total Identities: ${mod.state.identities.size}`);
  console.log(
    `✅ KYC Issued: ${Array.from(mod.state.claims.values()).filter((c) => c.type === "KYC").length}`,
  );
  console.log(
    `✅ AML Issued: ${Array.from(mod.state.claims.values()).filter((c) => c.type === "AML").length}`,
  );
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
    if ((await registry.identity(identity.owner)) === ethers.ZeroAddress) {
      await registry.registerIdentity(identity.owner, identity.address, 840);
    }
    // AML is required too (Task 1R.3): without it isVerified() never
    // returns true regardless of the KYC claim below.
    await attestAml(
      mod.state.getContract("amlIssuer"),
      mod.state.signers[3],
      identity.address,
      "expiry-demo",
    );
    const issueKyc = (label, validTo) =>
      attestKyc(
        mod.state.getContract("kycIssuer"),
        mod.state.signers[2],
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
