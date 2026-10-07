/**
 * @fileoverview OnchainID option 5: recover lost keys, remove a compromised key
 * @module OnchainIDRecoveryFlow
 * @description KeyManager recovery and rotation, and the owner's removal of a
 * compromised key.
 * Moved out of demo/modules/OnchainIDModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const {
  recoverInteractive,
  replaceInteractive,
} = require("./KeyLifecycleOptions");
const {
  signRemoval,
  removeWithProof,
  removeWithoutProof,
} = require("./KeyRemovalFlow");

/**
 * Option 5: Recover lost keys
 *
 * @returns {Promise<void>}
 */
async function recoverLostKeys(mod) {
  displaySection("RECOVER LOST KEYS", "🚨");

  if (mod.state.identities.size === 0) {
    displayError("Please create OnchainID first (option 3)");
    return;
  }

  try {
    // Show available identities
    console.log("\n🆔 Available Identities:");
    const identityArray = Array.from(mod.state.identities.values());
    let index = 0;

    for (const identity of identityArray) {
      console.log(`   ${index}: ${identity.address}`);
      console.log(`      Owner: ${identity.owner}`);
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

    // Get OnchainID contract instance
    const onchainID = await ethers.getContractAt(
      "OnchainID",
      selectedIdentity.address,
    );

    // 2 and 3 run through KeyManager (plan v2 Task 4.2): recovery agents
    // and a 48h timelock, or a rotation behind the identity's timelock.
    // They used to be instant owner addKey/removeKey calls. The owner
    // still sets recovery up; the agents and the timelocks are new.
    console.log("\n🚨 KEY RECOVERY OPTIONS:");
    console.log("1. Remove Compromised Key");
    console.log("2. Add Recovery Key (recovery agents, 48h, KeyManager)");
    console.log("3. Replace Management Key (rotation timelock, KeyManager)");
    console.log("0. Back");

    const choice = await mod.promptUser("Select option (0-3): ");

    switch (choice) {
      case "1":
        await mod.removeCompromisedKey(onchainID, selectedIdentity);
        break;
      case "2":
        await recoverInteractive(mod.state, selectedIdentity, mod.promptUser);
        break;
      case "3":
        await replaceInteractive(mod.state, selectedIdentity, mod.promptUser);
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`Key recovery failed: ${error.message}`);
  }
}

// ========== KEY RECOVERY HELPER METHODS ==========

/**
 * Remove a compromised key from an identity
 */
async function removeCompromisedKey(mod, onchainID, identity) {
  console.log("\n🗑️  REMOVE COMPROMISED KEY");
  console.log("=".repeat(40));

  // ========== STEP 1: OWNER CONFIRMATION ==========
  console.log("\n👑 OWNER CONFIRMATION REQUIRED");
  console.log("=".repeat(70));
  console.log(
    "⚠️  This operation will permanently remove a key from the identity",
  );
  console.log("⚠️  The identity owner must approve this action");
  console.log("");

  // Find owner's signer
  const ownerAddress = identity.owner;
  let ownerSigner;
  for (const signer of mod.state.signers) {
    const addr = await signer.getAddress();
    if (addr.toLowerCase() === ownerAddress.toLowerCase()) {
      ownerSigner = signer;
      break;
    }
  }

  if (!ownerSigner) {
    displayError(`Owner signer not found for address: ${ownerAddress}`);
    console.log(
      "   ℹ️  The identity owner must be one of the available signers",
    );
    return;
  }

  console.log(`   Owner: ${ownerAddress}`);
  console.log("   Please confirm you want to proceed with key removal");

  const ownerConfirm = await mod.promptUser(
    "Owner confirms key removal? (yes/no): ",
  );
  if (ownerConfirm.toLowerCase() !== "yes") {
    console.log("   ❌ Operation cancelled by owner");
    return;
  }

  // The owner's consent is the removal transaction it sends below; the
  // chain checks the key holder's signature (review of 4.5, N-5: an
  // off-chain owner signature nothing verified was removed).
  console.log("   ✅ The owner will send the removal transaction");

  // ========== STEP 2: SELECT KEY TO REMOVE ==========
  const keyPurposes = [
    { id: 1, name: "Management" },
    { id: 2, name: "Action" },
    { id: 3, name: "Claim Signer" },
    { id: 4, name: "Encryption" },
  ];

  console.log("\n📋 Select key purpose to remove:");
  keyPurposes.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.name} Keys`);
  });

  const purposeChoice = await mod.promptUser("Select purpose (1-4): ");
  const selectedPurpose = keyPurposes[parseInt(purposeChoice) - 1];

  if (!selectedPurpose) {
    displayError("Invalid purpose selection");
    return;
  }

  const keys = await onchainID.getKeysByPurpose(selectedPurpose.id);

  if (keys.length === 0) {
    displayError("No keys found for this purpose");
    return;
  }

  console.log(`\n🔑 ${selectedPurpose.name} Keys:`);
  for (let i = 0; i < keys.length; i++) {
    console.log(`   ${i}: ${keys[i]}`);
  }

  const keyIndex = await mod.promptUser(
    `Select key to remove (0-${keys.length - 1}): `,
  );
  const keyToRemove = keys[parseInt(keyIndex)];

  if (!keyToRemove) {
    displayError("Invalid key selection");
    return;
  }

  // ========== STEP 3: PROVE OWNERSHIP OF KEY BEING REMOVED ==========
  console.log("\n🔐 SECURITY CHECK: Prove ownership of the key being removed");
  console.log("=".repeat(70));
  console.log("⚠️  You must prove you own this key before it can be removed!");
  console.log("");
  console.log("📋 How was this key created?");
  console.log("1. From Ethereum Address (requires signature)");
  console.log("2. From String/Passphrase (requires exact match)");
  console.log("0. Cancel");

  const keyTypeChoice = await mod.promptUser("Select key type (0-2): ");

  if (keyTypeChoice === "0") {
    console.log("   ❌ Operation cancelled");
    return;
  }

  let keyOwnerSignature;
  let useSecureRemoval = false;

  if (keyTypeChoice === "1") {
    // Address-based key - require signature
    console.log("\n🔐 ADDRESS-BASED KEY VERIFICATION");
    console.log("Enter the Ethereum address of this key:");
    const keyAddress = await mod.promptUser("Address: ");

    // Verify hash matches
    const expectedHash = ethers.keccak256(
      ethers.solidityPacked(["address"], [keyAddress]),
    );
    if (expectedHash !== keyToRemove) {
      displayError("Address does not match the selected key hash");
      console.log(`   Expected: ${keyToRemove}`);
      console.log(`   Got: ${expectedHash}`);
      return;
    }

    // Find signer for this address
    let keySigner;
    for (const signer of mod.state.signers) {
      const addr = await signer.getAddress();
      if (addr.toLowerCase() === keyAddress.toLowerCase()) {
        keySigner = signer;
        break;
      }
    }

    if (!keySigner) {
      displayError(`Signer not found for address: ${keyAddress}`);
      console.log("   ℹ️  The key owner must be one of the available signers");
      return;
    }

    // The holder signs the digest the chain recovers from
    // (getRemoveKeyMessage), checked before and after signing.
    try {
      ({ signature: keyOwnerSignature } = await signRemoval(
        onchainID,
        keySigner,
        keyToRemove,
        selectedPurpose.id,
      ));
    } catch (e) {
      displayError(`Signature check failed: ${e.message}`);
      return;
    }

    console.log("   ✅ Key ownership verified via signature");
    useSecureRemoval = true;
  } else if (keyTypeChoice === "2") {
    // String-based key - require exact passphrase
    console.log("\n🔐 STRING-BASED KEY VERIFICATION");
    const keyString = await mod.promptUser(
      "Enter the exact string/passphrase: ",
    );

    const expectedHash = ethers.id(keyString);
    if (expectedHash !== keyToRemove) {
      displayError(
        "String does not match the selected key hash - incorrect passphrase!",
      );
      return;
    }

    console.log("   ✅ Key ownership verified via passphrase match");
    useSecureRemoval = false; // String-based keys cannot use removeKeyWithProof
  } else {
    displayError("Invalid choice");
    return;
  }

  // ========== STEP 4: REMOVE KEY WITH APPROPRIATE METHOD ==========
  // Prints the method called and reads the key back (KeyRemovalFlow).
  console.log("\n🗑️  Removing key...");
  const after = useSecureRemoval
    ? await removeWithProof(
        onchainID,
        ownerSigner,
        keyToRemove,
        selectedPurpose.id,
        keyOwnerSignature,
      )
    : await removeWithoutProof(
        onchainID,
        ownerSigner,
        keyToRemove,
        selectedPurpose.id,
      );
  if (after.active || after.revokedAt === 0) {
    displayError("The key still reads as active on chain");
    return;
  }
  displaySuccess("Key removed successfully!");
  console.log(`   Key: ${keyToRemove}`);
  console.log(`   Purpose: ${selectedPurpose.name}`);
}

module.exports = { recoverLostKeys, removeCompromisedKey };
