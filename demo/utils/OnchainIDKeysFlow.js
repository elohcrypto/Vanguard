/**
 * @fileoverview OnchainID options 2 and 4: management keys, key review
 * @module OnchainIDKeysFlow
 * @description Adds management keys to an identity and reviews its keys.
 * Moved out of demo/modules/OnchainIDModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");

/**
 * Option 2: Create management keys
 *
 * @returns {Promise<void>}
 */
async function createManagementKeys(mod) {
  displaySection("CREATE MANAGEMENT KEYS", "🔑");

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

    // Key management menu
    console.log("\n🔑 KEY MANAGEMENT OPTIONS:");
    console.log(
      "1. Add Management Key   (executes alone - use this for automation)",
    );
    console.log(
      "2. Add Action Key       (PROPOSES only - needs a 2nd approver)",
    );
    console.log("3. Add Claim Signer Key");
    console.log("4. Add Encryption Key");
    console.log("0. Back");

    const choice = await mod.promptUser("Select option (0-4): ");

    let keyPurpose;
    let keyPurposeName;

    switch (choice) {
      case "1":
        keyPurpose = 1; // MANAGEMENT_KEY
        keyPurposeName = "Management";
        break;
      case "2":
        keyPurpose = 2; // ACTION_KEY
        keyPurposeName = "Action";
        // An action key proposes; it cannot approve its own
        // request (that would be 1-of-1 in disguise). Say so here,
        // where the choice is made, not after the fact.
        console.log(
          "\n   ⚠️  An ACTION key can PROPOSE an execution but not run it alone.",
        );
        console.log(
          "      execute() leaves the request pending and emits ExecutionPending;",
        );
        console.log("      a DIFFERENT key must then call approve(id, true).");
        console.log(
          "      For unattended automation, add a MANAGEMENT key instead (option 1).",
        );
        break;
      case "3":
        keyPurpose = 3; // CLAIM_SIGNER_KEY
        keyPurposeName = "Claim Signer";
        break;
      case "4":
        keyPurpose = 4; // ENCRYPTION_KEY
        keyPurposeName = "Encryption";
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
        return;
    }

    // Choose key input method
    console.log("\n🔐 KEY INPUT METHOD:");
    console.log("1. From Ethereum Address");
    console.log("2. From String/Passphrase");
    console.log("0. Back");

    const inputMethod = await mod.promptUser("Select input method (0-2): ");

    let keyHash;
    let keyInfo;

    if (inputMethod === "1") {
      // Method 1: From Ethereum Address (with signature verification)

      // Show available signers
      console.log("\n👥 Available Signers:");
      const signerAddresses = await Promise.all(
        mod.state.signers.map((s) => s.getAddress()),
      );

      for (let i = 0; i < signerAddresses.length; i++) {
        console.log(`   ${i}: ${signerAddresses[i]}`);
      }
      console.log(`   ${signerAddresses.length}: Enter custom address`);

      const signerChoice = await mod.promptUser(
        `Select signer (0-${signerAddresses.length}): `,
      );
      const signerIndex = parseInt(signerChoice);

      let keyAddress;

      if (signerIndex >= 0 && signerIndex < signerAddresses.length) {
        // Selected from available signers
        keyAddress = signerAddresses[signerIndex];
      } else if (signerIndex === signerAddresses.length) {
        // Custom address
        keyAddress = await mod.promptUser("Enter custom Ethereum address: ");
      } else {
        displayError("Invalid selection");
        return;
      }

      // Validate address
      if (!ethers.isAddress(keyAddress)) {
        displayError("Invalid Ethereum address");
        return;
      }

      // Check if this address is one of our signers (can auto-sign)
      const availableSignerIndex = signerAddresses.findIndex(
        (addr) => addr.toLowerCase() === keyAddress.toLowerCase(),
      );

      if (availableSignerIndex >= 0) {
        // This is one of our signers - we can auto-sign
        console.log("\n🔐 Verifying ownership via signature...");
        const message = `Add ${keyPurposeName} Key to OnchainID: ${selectedIdentity.address}`;
        const signer = mod.state.signers[availableSignerIndex];
        const signature = await signer.signMessage(message);

        // Verify signature
        const recoveredAddress = ethers.verifyMessage(message, signature);

        if (recoveredAddress.toLowerCase() !== keyAddress.toLowerCase()) {
          displayError("Signature verification failed");
          return;
        }

        console.log("✅ Signature verified!");
        keyHash = ethers.keccak256(
          ethers.solidityPacked(["address"], [keyAddress]),
        );
        keyInfo = `Address: ${keyAddress} (Verified via signature)`;
      } else {
        // External address - user needs to provide signature manually
        console.log("\n⚠️  External address detected");
        console.log(
          "💡 To prove ownership, you need to sign a message with this address",
        );
        console.log("\n📝 Message to sign:");
        const message = `Add ${keyPurposeName} Key to OnchainID: ${selectedIdentity.address}`;
        console.log(`   "${message}"`);
        console.log(
          "\n🔐 Sign this message with your wallet and paste the signature:",
        );

        const signature = await mod.promptUser("Enter signature (0x...): ");

        try {
          // Verify signature
          const recoveredAddress = ethers.verifyMessage(message, signature);

          if (recoveredAddress.toLowerCase() !== keyAddress.toLowerCase()) {
            displayError("Signature verification failed - address mismatch");
            console.log(`   Expected: ${keyAddress}`);
            console.log(`   Recovered: ${recoveredAddress}`);
            return;
          }

          console.log("✅ Signature verified!");
          keyHash = ethers.keccak256(
            ethers.solidityPacked(["address"], [keyAddress]),
          );
          keyInfo = `Address: ${keyAddress} (Verified via signature)`;
        } catch (error) {
          displayError(`Signature verification failed: ${error.message}`);
          return;
        }
      }
    } else if (inputMethod === "2") {
      // Method 2: From String/Passphrase
      const keyString = await mod.promptUser(
        "Enter string/passphrase for the new key: ",
      );

      if (!keyString || keyString.trim().length === 0) {
        displayError("String cannot be empty");
        return;
      }

      // Create key hash from string
      keyHash = ethers.id(keyString); // keccak256 hash of the string
      keyInfo = `String: "${keyString}" (length: ${keyString.length})`;
    } else if (inputMethod === "0") {
      return;
    } else {
      displayError("Invalid input method");
      return;
    }

    // Add key to OnchainID (must be called by owner or someone with management key)
    console.log(`\n🔐 Adding ${keyPurposeName} Key...`);

    // Debug: Check current management keys
    console.log("\n🔍 DEBUG: Checking current management keys...");
    const currentManagementKeys = await onchainID.getKeysByPurpose(1);
    console.log(
      `   Current management keys count: ${currentManagementKeys.length}`,
    );
    for (let i = 0; i < currentManagementKeys.length; i++) {
      console.log(`   Key ${i}: ${currentManagementKeys[i]}`);
    }

    // Check what the owner's key should be (FIXED: use solidityPacked to match constructor)
    const ownerAddress = selectedIdentity.owner;
    const expectedOwnerKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [ownerAddress]),
    );
    console.log(`   Expected owner key: ${expectedOwnerKey}`);
    console.log(`   Owner address: ${ownerAddress}`);

    // Check if owner has management key
    const ownerHasKey = await onchainID.keyHasPurpose(expectedOwnerKey, 1);
    console.log(`   Owner has management key: ${ownerHasKey}`);

    // Find the owner's signer
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
      console.log("   ℹ️  Owner address: " + ownerAddress);
      return;
    }

    console.log(`\n   ℹ️  Transaction will be sent by owner: ${ownerAddress}`);

    const tx = await onchainID
      .connect(ownerSigner)
      .addKey(keyHash, keyPurpose, 1); // 1 = ECDSA_TYPE
    await tx.wait();

    displaySuccess(`${keyPurposeName} Key Added Successfully!`);
    if (keyPurpose === 2) {
      const threshold = await onchainID.executionThreshold();
      console.log(`\n   🔐 Execution threshold: ${threshold} approvals.`);
      console.log(
        "      This key can propose; one other key must approve to execute.",
      );
    }
    console.log(`   Identity: ${selectedIdentity.address}`);
    console.log(`   ${keyInfo}`);
    console.log(`   Key Hash: ${keyHash}`);
    console.log(`   Purpose: ${keyPurposeName} (${keyPurpose})`);
    console.log(`   Type: ECDSA (1)`);
  } catch (error) {
    displayError(`Key creation failed: ${error.message}`);
  }
}

/**
 * Option 4: Review identity keys
 *
 * @returns {Promise<void>}
 */
async function reviewIdentityKeys(mod) {
  displaySection("REVIEW IDENTITY KEYS", "🔍");

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

    console.log(`\n🔍 REVIEWING KEYS FOR: ${selectedIdentity.address}`);
    console.log("=".repeat(70));

    // Key purposes to check
    const keyPurposes = [
      { id: 1, name: "Management Keys" },
      { id: 2, name: "Action Keys" },
      { id: 3, name: "Claim Signer Keys" },
      { id: 4, name: "Encryption Keys" },
    ];

    for (const purpose of keyPurposes) {
      console.log(`\n🔑 ${purpose.name}:`);

      try {
        const keys = await onchainID.getKeysByPurpose(purpose.id);

        if (keys.length === 0) {
          console.log("   No keys found");
        } else {
          for (let i = 0; i < keys.length; i++) {
            const keyHash = keys[i];
            const keyInfo = await onchainID.getKey(keyHash);

            console.log(`   ${i + 1}. Key Hash: ${keyHash}`);
            console.log(`      Purpose: ${keyInfo.purpose}`);
            console.log(
              `      Type: ${keyInfo.keyType === 1n ? "ECDSA" : "RSA"}`,
            );
            console.log(
              `      Revoked: ${keyInfo.revokedAt > 0n ? "Yes" : "No"}`,
            );
            if (keyInfo.revokedAt > 0n) {
              const revokedDate = new Date(Number(keyInfo.revokedAt) * 1000);
              console.log(`      Revoked At: ${revokedDate.toISOString()}`);
            }
          }
        }
      } catch (error) {
        console.log(`   Error retrieving keys: ${error.message}`);
      }
    }

    console.log("\n✅ Key review completed!");
  } catch (error) {
    displayError(`Key review failed: ${error.message}`);
  }
}

module.exports = { createManagementKeys, reviewIdentityKeys };
