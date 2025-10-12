import { ethers } from "hardhat";
import { InvestorTypeRegistry, InvestorTypeCompliance } from "../typechain-types";

async function main() {
    console.log("🚀 Deploying Investor Type System...");

    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

    // Deploy InvestorTypeRegistry
    console.log("\n📋 Deploying InvestorTypeRegistry...");
    const InvestorTypeRegistryFactory = await ethers.getContractFactory("InvestorTypeRegistry");
    const investorTypeRegistry: InvestorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
    await investorTypeRegistry.waitForDeployment();
    const investorTypeRegistryAddress = await investorTypeRegistry.getAddress();
    console.log("✅ InvestorTypeRegistry deployed to:", investorTypeRegistryAddress);

    // Deploy InvestorTypeCompliance
    console.log("\n🔒 Deploying InvestorTypeCompliance...");
    const InvestorTypeComplianceFactory = await ethers.getContractFactory("InvestorTypeCompliance");
    const investorTypeCompliance: InvestorTypeCompliance = await InvestorTypeComplianceFactory.deploy(
        investorTypeRegistryAddress
    );
    await investorTypeCompliance.waitForDeployment();
    const investorTypeComplianceAddress = await investorTypeCompliance.getAddress();
    console.log("✅ InvestorTypeCompliance deployed to:", investorTypeComplianceAddress);

    // Verify default configurations
    console.log("\n🔍 Verifying default investor type configurations...");
    const [normalConfig, retailConfig, accreditedConfig, institutionalConfig] =
        await investorTypeRegistry.getAllInvestorTypeConfigs();

    console.log("\n📊 Investor Type Configurations:");
    console.log("Normal Investor:");
    console.log(`  - Max Transfer: ${ethers.formatEther(normalConfig.maxTransferAmount)} VSC`);
    console.log(`  - Max Holding: ${ethers.formatEther(normalConfig.maxHoldingAmount)} VSC`);
    console.log(`  - Required Whitelist Tier: ${normalConfig.requiredWhitelistTier}`);
    console.log(`  - Transfer Cooldown: ${normalConfig.transferCooldownMinutes} minutes`);
    console.log(`  - Enhanced Logging: ${normalConfig.enhancedLogging}`);

    console.log("\nRetail Investor:");
    console.log(`  - Max Transfer: ${ethers.formatEther(retailConfig.maxTransferAmount)} VSC`);
    console.log(`  - Max Holding: ${ethers.formatEther(retailConfig.maxHoldingAmount)} VSC`);
    console.log(`  - Required Whitelist Tier: ${retailConfig.requiredWhitelistTier}`);
    console.log(`  - Transfer Cooldown: ${retailConfig.transferCooldownMinutes} minutes`);
    console.log(`  - Enhanced Logging: ${retailConfig.enhancedLogging}`);

    console.log("\nAccredited Investor:");
    console.log(`  - Max Transfer: ${ethers.formatEther(accreditedConfig.maxTransferAmount)} VSC`);
    console.log(`  - Max Holding: ${ethers.formatEther(accreditedConfig.maxHoldingAmount)} VSC`);
    console.log(`  - Required Whitelist Tier: ${accreditedConfig.requiredWhitelistTier}`);
    console.log(`  - Transfer Cooldown: ${accreditedConfig.transferCooldownMinutes} minutes`);
    console.log(`  - Large Transfer Threshold: ${ethers.formatEther(accreditedConfig.largeTransferThreshold)} VSC`);
    console.log(`  - Enhanced Logging: ${accreditedConfig.enhancedLogging}`);

    console.log("\nInstitutional Investor:");
    console.log(`  - Max Transfer: ${ethers.formatEther(institutionalConfig.maxTransferAmount)} VSC`);
    console.log(`  - Max Holding: ${ethers.formatEther(institutionalConfig.maxHoldingAmount)} VSC`);
    console.log(`  - Required Whitelist Tier: ${institutionalConfig.requiredWhitelistTier}`);
    console.log(`  - Transfer Cooldown: ${institutionalConfig.transferCooldownMinutes} minutes`);
    console.log(`  - Large Transfer Threshold: ${ethers.formatEther(institutionalConfig.largeTransferThreshold)} VSC`);
    console.log(`  - Enhanced Logging: ${institutionalConfig.enhancedLogging}`);

    // Set up compliance officer (deployer for now)
    console.log("\n👮 Setting up compliance officer...");
    await investorTypeRegistry.setComplianceOfficer(deployer.address, true);
    await investorTypeCompliance.setComplianceOfficer(deployer.address, true);
    console.log("✅ Compliance officer set up:", deployer.address);

    console.log("\n🎉 Investor Type System deployment completed!");
    console.log("\n📋 Deployment Summary:");
    console.log("InvestorTypeRegistry:", investorTypeRegistryAddress);
    console.log("InvestorTypeCompliance:", investorTypeComplianceAddress);
    console.log("Deployer (Compliance Officer):", deployer.address);

    // Save deployment addresses to file
    const deploymentInfo = {
        network: await ethers.provider.getNetwork(),
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
            InvestorTypeRegistry: investorTypeRegistryAddress,
            InvestorTypeCompliance: investorTypeComplianceAddress
        },
        configurations: {
            normal: {
                maxTransfer: ethers.formatEther(normalConfig.maxTransferAmount),
                maxHolding: ethers.formatEther(normalConfig.maxHoldingAmount),
                whitelistTier: normalConfig.requiredWhitelistTier.toString(),
                cooldownMinutes: normalConfig.transferCooldownMinutes.toString()
            },
            retail: {
                maxTransfer: ethers.formatEther(retailConfig.maxTransferAmount),
                maxHolding: ethers.formatEther(retailConfig.maxHoldingAmount),
                whitelistTier: retailConfig.requiredWhitelistTier.toString(),
                cooldownMinutes: retailConfig.transferCooldownMinutes.toString()
            },
            accredited: {
                maxTransfer: ethers.formatEther(accreditedConfig.maxTransferAmount),
                maxHolding: ethers.formatEther(accreditedConfig.maxHoldingAmount),
                whitelistTier: accreditedConfig.requiredWhitelistTier.toString(),
                cooldownMinutes: accreditedConfig.transferCooldownMinutes.toString(),
                largeTransferThreshold: ethers.formatEther(accreditedConfig.largeTransferThreshold)
            },
            institutional: {
                maxTransfer: ethers.formatEther(institutionalConfig.maxTransferAmount),
                maxHolding: ethers.formatEther(institutionalConfig.maxHoldingAmount),
                whitelistTier: institutionalConfig.requiredWhitelistTier.toString(),
                cooldownMinutes: institutionalConfig.transferCooldownMinutes.toString(),
                largeTransferThreshold: ethers.formatEther(institutionalConfig.largeTransferThreshold)
            }
        }
    };

    const fs = require('fs');
    const path = require('path');

    const deploymentsDir = path.join(__dirname, '../deployments');
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const deploymentFile = path.join(deploymentsDir, 'investor-type-system.json');
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));

    console.log(`\n💾 Deployment info saved to: ${deploymentFile}`);

    return {
        investorTypeRegistry,
        investorTypeCompliance,
        addresses: {
            investorTypeRegistry: investorTypeRegistryAddress,
            investorTypeCompliance: investorTypeComplianceAddress
        }
    };
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });