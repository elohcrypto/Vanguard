/**
 * @fileoverview OnchainID options 3, 9, 10: create an identity, UTXO record
 * @module OnchainIDCreationFlow
 * @description Creates an OnchainID and registers it, and the UTXO record with its
 * KYC/AML data.
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
  displayInfo,
} = require("./DisplayHelpers");

/**
 * Option 3: Create OnchainID for a user
 *
 * @returns {Promise<void>}
 *
 * @example
 * await module.createOnchainID();
 */
async function createOnchainID(mod) {
  displaySection("CREATING ONCHAINID", "🆔");

  if (!mod.state.getContract("onchainIDFactory")) {
    displayError("Please deploy contracts first (option 1)");
    return;
  }

  try {
    console.log("\n📋 SELECT ADDRESS TYPE:");
    console.log("1. Use existing signer (from test accounts)");
    console.log("2. Enter custom wallet address");
    console.log("");

    const addressType = await mod.promptUser("Select option (1-2): ");

    let selectedAddress;
    let selectedSigner;

    if (addressType === "2") {
      // Custom wallet address
      displayInfo("CUSTOM WALLET ADDRESS");
      const customAddress = await mod.promptUser(
        "Enter wallet address (0x...): ",
      );

      if (!ethers.isAddress(customAddress)) {
        displayError("Invalid Ethereum address format");
        return;
      }

      selectedAddress = customAddress;
      selectedSigner = mod.state.signers[0];

      console.log(
        `\n👤 Creating OnchainID for custom address: ${selectedAddress}`,
      );
      console.log(`   💰 Transaction paid by: ${selectedSigner.address}`);
    } else {
      // Existing signer
      console.log("\n👥 Available Signers (Hardhat Test Accounts):");
      console.log("=".repeat(70));

      // Define role labels
      const roleLabels = {
        0: "👑 Platform Owner/Deployer",
        1: "💰 Fee Wallet",
        2: "✅ KYC Issuer",
        3: "🔍 AML Issuer",
      };

      // Show all available signers with role labels
      for (let i = 0; i < mod.state.signers.length; i++) {
        const address = await mod.state.signers[i].getAddress();
        const role = roleLabels[i] || "👤 Available for users";
        console.log(`   ${i.toString().padStart(2)}: ${address}  ${role}`);
      }

      console.log("=".repeat(70));
      console.log(
        `   ℹ️  Total available: ${mod.state.signers.length} signers`,
      );
      console.log(`   ⚠️  Signers 0-3 are reserved for system roles`);
      console.log(
        `   ✅ Signers 4-${mod.state.signers.length - 1} are available for users/investors`,
      );

      const signerIndex = await mod.promptUser(
        `\nSelect signer (0-${mod.state.signers.length - 1}): `,
      );
      const index = parseInt(signerIndex);

      if (index < 0 || index >= mod.state.signers.length) {
        displayError("Invalid signer selection");
        return;
      }

      selectedSigner = mod.state.signers[index];
      selectedAddress = await selectedSigner.getAddress();

      const selectedRole = roleLabels[index] || "👤 User/Investor";
      console.log(`\n👤 Creating OnchainID for: ${selectedAddress}`);
      console.log(`   Role: ${selectedRole}`);
    }

    const salt = ethers.randomBytes(32);
    const factory = mod.state.getContract("onchainIDFactory");

    const { receipt } = await mod.logger.logTransaction(
      "OnchainID Creation",
      factory.connect(selectedSigner).deployOnchainID(selectedAddress, salt),
      {
        owner: selectedAddress,
        salt: salt,
        factory: await factory.getAddress(),
        paidBy: selectedSigner.address,
      },
      {
        operation: "Create OnchainID",
        userSelected: selectedAddress,
        transactionPaidBy: selectedSigner.address,
      },
    );

    const identityAddress = await factory.getIdentityByOwner(selectedAddress);

    mod.state.identities.set(identityAddress, {
      address: identityAddress,
      owner: selectedAddress,
      signer: selectedSigner,
      createdAt: new Date().toISOString(),
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      isCustomAddress: addressType === "2",
    });

    displaySuccess("ONCHAINID CREATED SUCCESSFULLY!");
    console.log(`   User Address: ${selectedAddress}`);
    console.log(`   OnchainID: ${identityAddress}`);

    if (addressType === "2") {
      console.log(`   💰 Transaction paid by: ${selectedSigner.address}`);
      console.log(`   ⚠️  Note: This is a custom address, not a test signer`);
    }

    console.log("\n💡 Next Steps:");
    console.log("   1. Issue KYC Claim (Option 6)");
    console.log("   2. Issue AML Claim (Option 7)");

    // Register in ERC-3643 if available
    if (mod.state.getContract("identityRegistry")) {
      await mod.registerInERC3643(selectedSigner, identityAddress);
    }
  } catch (error) {
    displayError(`OnchainID creation failed: ${error.message}`);
  }
}

/**
 * Register identity in ERC-3643 registry
 *
 * @param {Object} signer - Signer object
 * @param {string} identityAddress - OnchainID address
 * @returns {Promise<void>}
 * @private
 */
async function registerInERC3643(mod, signer, identityAddress) {
  // SKIP ERC-3643 registration during OnchainID creation
  // Registration will happen during KYC claim issuance with proper country code
  console.log("\n📝 ERC-3643 Registration Status:");
  console.log(
    "   ⏭️  Skipping registration (will occur during KYC claim issuance)",
  );
  console.log("   ℹ️  OnchainID created successfully");
  console.log(
    "   ℹ️  Country verification will occur when KYC claim is issued",
  );
  console.log("   ℹ️  Compliance rules will be enforced at that time");
  console.log("");
  console.log("💡 Next Steps:");
  console.log(
    "   1. Issue KYC Claim (Option 6) - This will register the identity with country code",
  );
  console.log("   2. Issue AML Claim (Option 7) - After KYC is issued");
}

/**
 * Option 9: Create UTXO with KYC/AML data
 *
 * @returns {Promise<void>}
 */
async function createUTXOWithCompliance(mod) {
  displaySection("CREATE UTXO WITH KYC/AML DATA", "💰");

  if (mod.state.identities.size === 0) {
    displayError("Please create OnchainID first (option 3)");
    return;
  }

  try {
    // Show available identities with their compliance status
    console.log("\n🆔 Available Identities:");
    const identityArray = Array.from(mod.state.identities.values());
    let index = 0;

    for (const identity of identityArray) {
      const kycClaim = mod.state.claims.get(`${identity.address}_KYC`);
      const amlClaim = mod.state.claims.get(`${identity.address}_AML`);
      const kycStatus = kycClaim ? kycClaim.status : "NOT_ISSUED";
      const amlStatus = amlClaim ? amlClaim.status : "NOT_ISSUED";
      const utxoEligible = kycStatus === "ISSUED" && amlStatus === "ISSUED";

      console.log(
        `   ${index}: ${identity.address} (Owner: ${identity.owner})`,
      );
      console.log(
        `      KYC: ${kycStatus} | AML: ${amlStatus} | UTXO Eligible: ${utxoEligible ? "✅" : "❌"}`,
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

    // Check compliance status
    const kycClaim = mod.state.claims.get(`${selectedIdentity.address}_KYC`);
    const amlClaim = mod.state.claims.get(`${selectedIdentity.address}_AML`);
    const kycStatus = kycClaim ? kycClaim.status : "NOT_ISSUED";
    const amlStatus = amlClaim ? amlClaim.status : "NOT_ISSUED";
    const utxoEligible = kycStatus === "ISSUED" && amlStatus === "ISSUED";

    console.log(`\n🔍 COMPLIANCE CHECK FOR: ${selectedIdentity.address}`);
    console.log(`📋 KYC Status: ${kycStatus}`);
    console.log(`🔍 AML Status: ${amlStatus}`);
    console.log(`💰 UTXO Eligible: ${utxoEligible ? "✅ YES" : "❌ NO"}`);

    if (!utxoEligible) {
      console.log("\n❌ UTXO CREATION BLOCKED");
      console.log("💡 Requirements for UTXO creation:");
      console.log("   • KYC Status: ISSUED");
      console.log("   • AML Status: ISSUED");
      return;
    }

    // Create UTXO
    const value = await mod.promptUser("Enter UTXO value (in ETH): ");
    const utxoId = ethers.id(`${selectedIdentity.address}_${Date.now()}`);

    // Store UTXO in state
    if (!mod.state.utxos) {
      mod.state.utxos = new Map();
    }

    mod.state.utxos.set(utxoId, {
      owner: selectedIdentity.owner,
      identity: selectedIdentity.address,
      value: ethers.parseEther(value),
      kycStatus: kycStatus,
      amlStatus: amlStatus,
      complianceStatus: "COMPLIANT",
      createdAt: new Date().toISOString(),
    });

    displaySuccess("UTXO CREATED SUCCESSFULLY!");
    console.log(
      `   UTXO ID: ${utxoId.substring(0, 10)}...${utxoId.substring(58)}`,
    );
    console.log(`   Owner: ${selectedIdentity.owner}`);
    console.log(`   Value: ${value} ETH`);
    console.log(`   KYC: ${kycStatus}`);
    console.log(`   AML: ${amlStatus}`);
  } catch (error) {
    displayError(`UTXO creation failed: ${error.message}`);
  }
}

/**
 * Option 10: show a UTXO record option 9 stored in demo memory, with the
 * KYC/AML statuses copied into it then. Nothing is read from chain here.
 *
 * @returns {Promise<void>}
 */
async function showUTXORecord(mod) {
  displaySection("VERIFY UTXO CONTAINS COMPLIANCE DATA", "🔍");

  if (!mod.state.utxos || mod.state.utxos.size === 0) {
    displayError("No UTXOs found. Please create a UTXO first (option 9)");
    return;
  }

  try {
    // Show available UTXOs
    console.log("\n💰 Available UTXOs:");
    const utxoArray = Array.from(mod.state.utxos.entries());
    let index = 0;

    for (const [utxoId, metadata] of utxoArray) {
      console.log(
        `   ${index}: ${utxoId.substring(0, 10)}...${utxoId.substring(58)}`,
      );
      console.log(`      Owner: ${metadata.owner}`);
      console.log(`      Value: ${ethers.formatEther(metadata.value)} ETH`);
      console.log(`      Status: ${metadata.complianceStatus}`);
      index++;
    }

    const utxoIndex = await mod.promptUser(
      `Select UTXO to verify (0-${utxoArray.length - 1}): `,
    );
    const [selectedUtxoId, selectedMetadata] = utxoArray[parseInt(utxoIndex)];

    if (!selectedMetadata) {
      displayError("Invalid UTXO selection");
      return;
    }

    console.log(
      "\n📋 UTXO RECORD (demo memory; statuses as option 9 read them)",
    );
    console.log("=".repeat(60));
    console.log(`📋 UTXO ID: ${selectedUtxoId}`);
    console.log(`👤 Owner: ${selectedMetadata.owner}`);
    console.log(`💰 Value: ${ethers.formatEther(selectedMetadata.value)} ETH`);
    console.log(`📋 KYC Status: ${selectedMetadata.kycStatus}`);
    console.log(`🔍 AML Status: ${selectedMetadata.amlStatus}`);
    console.log(`✅ Compliance Status: ${selectedMetadata.complianceStatus}`);
    console.log(`📅 Created: ${selectedMetadata.createdAt}`);
  } catch (error) {
    displayError(`UTXO verification failed: ${error.message}`);
  }
}

module.exports = {
  createOnchainID,
  registerInERC3643,
  createUTXOWithCompliance,
  showUTXORecord,
};
