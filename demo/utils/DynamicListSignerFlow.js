/**
 * @fileoverview Dynamic list option 89: verify an existing signer for voting
 * @module DynamicListSignerFlow
 * @description Verifies an existing signer so it can vote on list updates.
 * Moved out of demo/modules/DynamicListModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { onboard } = require("./Onboard");
const { ethers } = require("hardhat");

/** Option 89: Quick Fix: Verify Existing Signer for Voting */
async function verifyExistingSigner(mod) {
  displaySection("QUICK FIX: VERIFY EXISTING SIGNER FOR VOTING", "🔧");
  console.log("This will register an existing signer in the IdentityRegistry");
  console.log(
    "and issue KYC/AML claims so they can vote on governance proposals.",
  );
  console.log("");

  const identityRegistry = mod.state.getContract("identityRegistry");
  const onchainIDFactory = mod.state.getContract("onchainIDFactory");
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");

  if (!identityRegistry || !onchainIDFactory) {
    displayError("Deploy ERC-3643 system first (Option 21)");
    return;
  }

  if (!vanguardGovernance) {
    displayError("Deploy Governance system first (Option 74)");
    return;
  }

  try {
    const governanceToken = mod.state.getContract("governanceToken");

    // Show available signers
    console.log("📋 Available Signers:");
    for (let i = 0; i < Math.min(5, mod.state.signers.length); i++) {
      const address = mod.state.signers[i].address;
      const balance = await governanceToken.balanceOf(address);
      const isVerified = await identityRegistry.isVerified(address);

      console.log(
        `${i}. ${address.slice(0, 10)}... - ${ethers.formatEther(balance)} VGT - Verified: ${isVerified ? "✅" : "❌"}`,
      );
    }
    console.log("");

    const signerChoice = await mod.promptUser(
      "Select signer to verify (0-4): ",
    );
    const signerIndex = parseInt(signerChoice);

    if (signerIndex < 0 || signerIndex >= mod.state.signers.length) {
      displayError("Invalid signer index");
      return;
    }

    const signer = mod.state.signers[signerIndex];
    const address = signer.address;

    // Check if already verified
    const alreadyVerified = await identityRegistry.isVerified(address);
    if (alreadyVerified) {
      displaySuccess(`Signer ${signerIndex} is already verified!`);
      console.log(`   Address: ${address}`);
      console.log(`   You can vote with this signer now.`);
      return;
    }

    console.log(`\n🔧 Verifying Signer ${signerIndex}...`);
    console.log(`   Address: ${address}`);

    // The demo's one onboarding path (Onboard.js, Task 4.16): the
    // OnchainID (existing or new, through the factory), the registry
    // entry (840), both claims through the trusted issuers, the cache.
    console.log("   📝 OnchainID, registry entry, KYC and AML claims...");
    const ob = await onboard(mod.state, address, {
      country: 840,
      label: `signer:${signerIndex}`,
    });
    const identityAddress = ob.identity;
    console.log(
      `   ✅ OnchainID ${ob.created ? "created" : "exists"}: ${identityAddress}`,
    );
    console.log(
      `   ✅ ${ob.registered ? "Registered" : "Already registered"} in IdentityRegistry; KYC and AML claims issued`,
    );

    // Verify registration
    const isVerified = ob.verified;

    displaySuccess("SIGNER VERIFIED SUCCESSFULLY!");
    console.log("=".repeat(70));
    console.log(`   Signer: ${signerIndex}`);
    console.log(`   Address: ${address}`);
    console.log(`   OnchainID: ${identityAddress}`);
    console.log(`   KYC: ✅ Issued`);
    console.log(`   AML: ✅ Issued`);
    console.log(`   Verified: ${isVerified ? "✅" : "❌"}`);
    console.log("");
    console.log("💡 Next Steps:");
    console.log("   1. Distribute VGT tokens to this signer (Option 75)");
    console.log("   2. Signer can now create proposals (Option 76)");
    console.log("   3. Signer can now vote on proposals (Option 77)");
  } catch (error) {
    displayError(`Verification failed: ${error.message}`);
  }
}

module.exports = {
  verifyExistingSigner,
};
