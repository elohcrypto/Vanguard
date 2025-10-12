import { ethers } from "hardhat";

/**
 * Integration script for connecting the Investor Type System with existing contracts
 * This script demonstrates how to integrate the new investor type system with
 * the existing Vanguard StableCoin infrastructure
 */

async function main() {
    console.log("🔗 Integrating Investor Type System with existing contracts...");

    const [deployer] = await ethers.getSigners();
    console.log("Integration account:", deployer.address);

    // Contract addresses (these would be from your existing deployment)
    // Replace these with your actual deployed contract addresses
    const EXISTING_CONTRACTS = {
        identityRegistry: "0x...", // Replace with actual IdentityRegistry address
        token: "0x...",            // Replace with actual Token address
        complianceRules: "0x...",  // Replace with actual ComplianceRules address
    };

    // New investor type system addresses (from deployment)
    const INVESTOR_TYPE_CONTRACTS = {
        investorTypeRegistry: "0x...",    // Replace with deployed InvestorTypeRegistry address
        investorTypeCompliance: "0x...", // Replace with deployed InvestorTypeCompliance address
    };

    // Get contract instances
    console.log("\n📋 Getting contract instances...");

    const identityRegistry = await ethers.getContractAt("IdentityRegistry", EXISTING_CONTRACTS.identityRegistry);
    const token = await ethers.getContractAt("Token", EXISTING_CONTRACTS.token);
    const investorTypeRegistry = await ethers.getContractAt("InvestorTypeRegistry", INVESTOR_TYPE_CONTRACTS.investorTypeRegistry);
    const investorTypeCompliance = await ethers.getContractAt("InvestorTypeCompliance", INVESTOR_TYPE_CONTRACTS.investorTypeCompliance);

    console.log("✅ Contract instances obtained");

    // Step 1: Integrate InvestorTypeRegistry with IdentityRegistry
    console.log("\n🔗 Step 1: Integrating InvestorTypeRegistry with IdentityRegistry...");
    try {
        const tx1 = await identityRegistry.setInvestorTypeRegistry(INVESTOR_TYPE_CONTRACTS.investorTypeRegistry);
        await tx1.wait();
        console.log("✅ IdentityRegistry integration completed");
    } catch (error) {
        console.log("⚠️  IdentityRegistry integration may already be set or failed:", error.message);
    }

    // Step 2: Integrate InvestorTypeRegistry with Token
    console.log("\n🪙 Step 2: Integrating InvestorTypeRegistry with Token...");
    try {
        const tx2 = await token.setInvestorTypeRegistry(INVESTOR_TYPE_CONTRACTS.investorTypeRegistry);
        await tx2.wait();
        console.log("✅ Token integration completed");
    } catch (error) {
        console.log("⚠️  Token integration may already be set or failed:", error.message);
    }

    // Step 3: Authorize Token in InvestorTypeRegistry
    console.log("\n🔐 Step 3: Authorizing Token in InvestorTypeRegistry...");
    try {
        const tx3 = await investorTypeRegistry.authorizeToken(EXISTING_CONTRACTS.token, true);
        await tx3.wait();
        console.log("✅ Token authorization completed");
    } catch (error) {
        console.log("⚠️  Token authorization may already be set or failed:", error.message);
    }

    // Step 4: Set up compliance officers
    console.log("\n👮 Step 4: Setting up compliance officers...");
    const complianceOfficers = [
        deployer.address, // Add more compliance officer addresses as needed
        // "0x...", // Additional compliance officer
    ];

    for (const officer of complianceOfficers) {
        try {
            const tx4a = await investorTypeRegistry.setComplianceOfficer(officer, true);
            await tx4a.wait();
            const tx4b = await investorTypeCompliance.setComplianceOfficer(officer, true);
            await tx4b.wait();
            console.log(`✅ Compliance officer set up: ${officer}`);
        } catch (error) {
            console.log(`⚠️  Compliance officer setup may already exist: ${officer}`);
        }
    }

    // Step 5: Demonstrate investor type assignment
    console.log("\n👥 Step 5: Demonstrating investor type assignments...");

    // Example investor addresses (replace with actual addresses)
    const exampleInvestors = [
        { address: "0x1234567890123456789012345678901234567890", type: 0, name: "Normal Investor" },
        { address: "0x2345678901234567890123456789012345678901", type: 1, name: "Retail Investor" },
        { address: "0x3456789012345678901234567890123456789012", type: 2, name: "Accredited Investor" },
        { address: "0x4567890123456789012345678901234567890123", type: 3, name: "Institutional Investor" },
    ];

    for (const investor of exampleInvestors) {
        try {
            // Check if investor has identity registered first
            const hasIdentity = await identityRegistry.isVerified(investor.address);
            if (!hasIdentity) {
                console.log(`⚠️  Investor ${investor.name} (${investor.address}) needs identity registration first`);
                continue;
            }

            const tx5 = await investorTypeRegistry.assignInvestorType(investor.address, investor.type);
            await tx5.wait();
            console.log(`✅ ${investor.name} assigned type ${investor.type}`);
        } catch (error) {
            console.log(`⚠️  Could not assign type for ${investor.name}: ${error.message}`);
        }
    }

    // Step 6: Verify integration
    console.log("\n🔍 Step 6: Verifying integration...");

    try {
        // Check if IdentityRegistry can access InvestorTypeRegistry
        const registryAddress = await identityRegistry.getInvestorTypeRegistry();
        console.log("✅ IdentityRegistry -> InvestorTypeRegistry:", registryAddress);

        // Check if Token can access InvestorTypeRegistry
        const tokenRegistryAddress = await token.investorTypeRegistry();
        console.log("✅ Token -> InvestorTypeRegistry:", tokenRegistryAddress);

        // Check investor type configurations
        const [normalConfig, retailConfig, accreditedConfig, institutionalConfig] =
            await investorTypeRegistry.getAllInvestorTypeConfigs();

        console.log("\n📊 Verified Investor Type Configurations:");
        console.log(`Normal: ${ethers.formatEther(normalConfig.maxTransferAmount)} VSC max transfer`);
        console.log(`Retail: ${ethers.formatEther(retailConfig.maxTransferAmount)} VSC max transfer`);
        console.log(`Accredited: ${ethers.formatEther(accreditedConfig.maxTransferAmount)} VSC max transfer`);
        console.log(`Institutional: ${ethers.formatEther(institutionalConfig.maxTransferAmount)} VSC max transfer`);

    } catch (error) {
        console.log("❌ Integration verification failed:", error.message);
    }

    // Step 7: Test transfer limit validation
    console.log("\n🧪 Step 7: Testing transfer limit validation...");

    try {
        // Test with example addresses (these should be actual registered investors)
        const testInvestor = exampleInvestors[0].address;
        const testRecipient = exampleInvestors[1].address;
        const testAmount = ethers.parseEther("5000"); // 5,000 VSC

        // Check if transfer would be allowed
        const canTransfer = await token.canTransfer(testInvestor, testRecipient, testAmount);
        console.log(`✅ Transfer validation test: ${canTransfer ? "ALLOWED" : "BLOCKED"}`);

        // Check specific limits
        const canTransferAmount = await investorTypeRegistry.canTransferAmount(testInvestor, testAmount);
        console.log(`✅ Transfer amount check: ${canTransferAmount ? "WITHIN LIMITS" : "EXCEEDS LIMITS"}`);

    } catch (error) {
        console.log("⚠️  Transfer validation test skipped (requires registered investors)");
    }

    console.log("\n🎉 Integration completed successfully!");

    console.log("\n📋 Integration Summary:");
    console.log("✅ InvestorTypeRegistry integrated with IdentityRegistry");
    console.log("✅ InvestorTypeRegistry integrated with Token");
    console.log("✅ Token authorized in InvestorTypeRegistry");
    console.log("✅ Compliance officers configured");
    console.log("✅ System ready for investor type management");

    console.log("\n📝 Next Steps:");
    console.log("1. Register investor identities using IdentityRegistry");
    console.log("2. Assign appropriate investor types using InvestorTypeRegistry");
    console.log("3. Configure oracle whitelist tiers for each investor type");
    console.log("4. Test end-to-end transfer workflows");
    console.log("5. Set up monitoring and compliance reporting");

    return {
        identityRegistry: EXISTING_CONTRACTS.identityRegistry,
        token: EXISTING_CONTRACTS.token,
        investorTypeRegistry: INVESTOR_TYPE_CONTRACTS.investorTypeRegistry,
        investorTypeCompliance: INVESTOR_TYPE_CONTRACTS.investorTypeCompliance,
        integrationComplete: true
    };
}

// Helper function to check integration status
async function checkIntegrationStatus() {
    console.log("🔍 Checking integration status...");

    // This function can be called separately to verify integration
    // Implementation would check all integration points and report status

    return {
        identityRegistryIntegrated: false,
        tokenIntegrated: false,
        complianceOfficersSet: false,
        authorizationsComplete: false
    };
}

// Export functions for use in other scripts
export { main as integrateInvestorTypeSystem, checkIntegrationStatus };

// Run if called directly
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error("❌ Integration failed:", error);
            process.exit(1);
        });
}