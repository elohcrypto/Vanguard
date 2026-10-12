/**
 * @fileoverview Token options 21-22: deploy VSC, create the token issuer
 * @module TokenIssuerFlow
 * @description The ERC-3643 system deploy entry point and the token issuer (central
 * bank) setup.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
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

/** Option 21: Deploy ERC-3643 Vanguard StableCoin System */
async function deployERC3643System(mod) {
  await mod.deployer.deployDigitalTokenSystem();
}

/** Option 22: Create Token Issuer */
async function createTokenIssuer(mod) {
  displaySection("CREATE TOKEN ISSUER (CENTRAL BANK) - ON-CHAIN", "🏛️");

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    displayError("Please deploy Digital Token system first (option 21)");
    return;
  }

  if (!mod.state.getContract("onchainIDFactory")) {
    displayError("Please deploy contracts first (option 1)");
    return;
  }

  // Check if token issuer already exists
  const existingCentralBank = Array.from(
    mod.state.bankingInstitutions.values(),
  ).find((bank) => bank.type === "CENTRAL_BANK");
  if (existingCentralBank) {
    console.log("⚠️  Token Issuer already exists!");
    console.log(`🏛️ Name: ${existingCentralBank.name}`);
    console.log(`🆔 Address: ${existingCentralBank.address}`);
    console.log(`🔗 OnchainID: ${existingCentralBank.onchainId}`);
    return;
  }

  try {
    const signer = mod.state.signers[0];
    let totalGasUsed = 0n;

    console.log("\n🔗 CREATING TOKEN ISSUER ON-CHAIN...");
    console.log(`👤 Issuer Address: ${signer.address}`);
    console.log(
      `💡 Note: Central Bank is a government authority - no KYC/AML required`,
    );

    // Get allowed countries from ComplianceRules
    let centralBankCountry = 840; // Default: United States
    let countryName = "United States";
    let jurisdiction = "US";

    const complianceRules = mod.state.getContract("complianceRules");
    if (complianceRules) {
      try {
        const tokenAddress = await digitalToken.getAddress();
        const jurisdictionRule =
          await complianceRules.getJurisdictionRule(tokenAddress);

        console.log("\n🌍 SELECTING CENTRAL BANK COUNTRY:");
        console.log("=".repeat(50));

        // Show current jurisdiction rules
        if (jurisdictionRule.allowedCountries.length > 0) {
          console.log("✅ Allowed Countries (Whitelist):");
          const countryMap = {
            840: "United States (US)",
            826: "United Kingdom (UK)",
            124: "Canada (CA)",
            276: "Germany (DE)",
            250: "France (FR)",
            392: "Japan (JP)",
            702: "Singapore (SG)",
            36: "Australia (AU)",
          };

          jurisdictionRule.allowedCountries.forEach((code, index) => {
            const codeNum = Number(code);
            const name = countryMap[codeNum] || `Country ${codeNum}`;
            console.log(`   ${index + 1}. ${codeNum} - ${name}`);
          });

          // Use first allowed country as default
          centralBankCountry = Number(jurisdictionRule.allowedCountries[0]);
          countryName =
            countryMap[centralBankCountry] || `Country ${centralBankCountry}`;
          jurisdiction = countryName.match(/\(([^)]+)\)/)?.[1] || "XX";

          console.log(`\n💡 Using: ${centralBankCountry} - ${countryName}`);
        } else {
          console.log("ℹ️  No whitelist configured - using default country");
          console.log(`💡 Using: ${centralBankCountry} - ${countryName}`);
        }

        // Check if country is blocked
        if (jurisdictionRule.blockedCountries.length > 0) {
          const isBlocked = jurisdictionRule.blockedCountries.some(
            (c) => Number(c) === centralBankCountry,
          );
          if (isBlocked) {
            console.log(
              `\n⚠️  WARNING: Country ${centralBankCountry} is in the blocked list!`,
            );
            console.log(
              "💡 Please configure jurisdiction rules first (Option 14)",
            );
            return;
          }
        }
      } catch (error) {
        console.log(
          "ℹ️  Jurisdiction rules not configured yet - using default country",
        );
        console.log(`💡 Using: ${centralBankCountry} - ${countryName}`);
      }
    } else {
      console.log("\nℹ️  ComplianceRules not deployed - using default country");
      console.log(`💡 Using: ${centralBankCountry} - ${countryName}`);
    }

    // Steps 1-2: the demo's one onboarding path (Onboard.js, Task 4.16):
    // OnchainID through the factory, the registry entry with the country,
    // both claims through the trusted issuers (registration alone never
    // verifies), the verification cache.
    console.log(
      "\n📝 Steps 1-2: OnchainID, registry entry, KYC and AML claims on blockchain...",
    );
    const ob = await onboard(mod.state, signer.address, {
      country: centralBankCountry,
      label: "central-bank",
    });
    const identityAddress = ob.identity;
    totalGasUsed += ob.gasUsed;
    console.log(
      `   🆔 OnchainID ${ob.created ? "created" : "found"}: ${identityAddress}`,
    );
    for (const [step, rc] of Object.entries(ob.receipts)) {
      console.log(
        `   ✅ ${step}: tx ${rc.hash} (gas ${rc.gasUsed.toLocaleString()})`,
      );
    }
    console.log(`   🌍 Country Code: ${centralBankCountry} (${countryName})`);

    // Step 3: Add as agent to Token contract (allows minting)
    console.log("\n📝 Step 3: Granting minting authority on blockchain...");
    const tx3 = await digitalToken.addAgent(signer.address);
    const receipt3 = await tx3.wait();
    totalGasUsed += receipt3.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt3.hash}`);
    console.log(`   🧱 Block Number: ${receipt3.blockNumber}`);
    console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);
    console.log(`   🔐 Minting Authority: GRANTED`);

    // Step 4: Verify registration on-chain
    console.log("\n📝 Step 4: Verifying registration on blockchain...");
    const isVerified = await mod.state
      .getContract("identityRegistry")
      .isVerified(signer.address);
    console.log(
      `   ${isVerified ? "✅" : "❌"} Verification Status: ${isVerified ? "VERIFIED" : "NOT VERIFIED"}`,
    );

    // Store in state
    const centralBank = {
      name: "Central Bank",
      type: "CENTRAL_BANK",
      jurisdiction: jurisdiction,
      countryCode: centralBankCountry,
      countryName: countryName,
      address: signer.address,
      onchainId: identityAddress,
      signer: signer,
      canMint: true,
      canBurn: true,
      maxDailyMint: 10000000,
      createdAt: new Date().toISOString(),
      complianceStatus: "GOVERNMENT_AUTHORIZED",
      regulatoryLevel: "CENTRAL_AUTHORITY",
    };

    mod.state.bankingInstitutions.set(centralBank.address, centralBank);
    await mod._ensureTreasuryExempt(centralBank);

    // Store identity
    mod.state.identities.set(identityAddress, {
      address: identityAddress,
      owner: signer.address,
      signer: signer,
      createdAt: new Date().toISOString(),
      bankInfo: centralBank,
    });

    displaySuccess("TOKEN ISSUER CREATED ON-CHAIN SUCCESSFULLY!");
    console.log(`🏛️ Name: ${centralBank.name}`);
    console.log(`🏛️ Role: Government Authority (Central Bank)`);
    console.log(`🆔 Address: ${centralBank.address}`);
    console.log(`🔗 OnchainID: ${identityAddress}`);
    console.log(`🌍 Jurisdiction: ${countryName} (${jurisdiction})`);
    console.log(`🌍 Country Code: ${centralBankCountry}`);
    console.log(`📊 Status: ${centralBank.complianceStatus}`);
    console.log(`🔐 Authorities: Mint ✅ Burn ✅`);
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

    console.log("\n💡 Token Issuer Capabilities:");
    console.log("   • ✅ Mint tokens to approved investors");
    console.log("   • ✅ Burn tokens for supply management");
    console.log("   • ✅ Monitor all transactions");
    console.log("   • ✅ Enforce compliance rules");
    console.log("   • ✅ Government-authorized entity (no KYC/AML needed)");
    console.log("   • ✅ Fully registered on-chain");
  } catch (error) {
    displayError(`Token Issuer creation failed: ${error.message}`);
    console.log(
      "💡 Make sure you deployed contracts (option 1) and Digital Token (option 21) first",
    );
  }
}

module.exports = { deployERC3643System, createTokenIssuer };
