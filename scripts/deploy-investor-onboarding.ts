import { ethers } from "hardhat";

/**
 * Deploy Investor Onboarding System
 * 
 * This script deploys:
 * 1. InvestorRequestManager - Manages investor status requests
 * 2. Configures lock requirements for each investor type
 * 3. Authorizes the manager as a compliance officer
 */

async function main() {
    console.log('🚀 Deploying Investor Onboarding System');
    console.log('='.repeat(60));

    const [deployer, bank] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);
    console.log('Bank:', bank.address);

    // Get existing contract addresses (you should update these)
    const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || '';
    const INVESTOR_REGISTRY_ADDRESS = process.env.INVESTOR_REGISTRY_ADDRESS || '';
    const IDENTITY_REGISTRY_ADDRESS = process.env.IDENTITY_REGISTRY_ADDRESS || '';
    const BANK_ADDRESS = process.env.BANK_ADDRESS || bank.address;

    if (!TOKEN_ADDRESS || !INVESTOR_REGISTRY_ADDRESS || !IDENTITY_REGISTRY_ADDRESS) {
        console.log('\n⚠️  Missing contract addresses. Please set environment variables:');
        console.log('   TOKEN_ADDRESS');
        console.log('   INVESTOR_REGISTRY_ADDRESS');
        console.log('   IDENTITY_REGISTRY_ADDRESS');
        console.log('   BANK_ADDRESS (optional, defaults to second signer)');
        console.log('\nOr deploy the full system first using: npx hardhat run scripts/deploy-erc3643-system.ts');
        return;
    }

    console.log('\n📋 Using existing contracts:');
    console.log('   Token:', TOKEN_ADDRESS);
    console.log('   InvestorTypeRegistry:', INVESTOR_REGISTRY_ADDRESS);
    console.log('   IdentityRegistry:', IDENTITY_REGISTRY_ADDRESS);
    console.log('   Bank:', BANK_ADDRESS);

    // Deploy InvestorRequestManager
    console.log('\n🏗️ Deploying InvestorRequestManager...');
    const InvestorRequestManager = await ethers.getContractFactory('InvestorRequestManager');
    const investorRequestManager = await InvestorRequestManager.deploy(
        BANK_ADDRESS,
        TOKEN_ADDRESS,
        INVESTOR_REGISTRY_ADDRESS,
        IDENTITY_REGISTRY_ADDRESS
    );
    await investorRequestManager.waitForDeployment();

    const managerAddress = await investorRequestManager.getAddress();
    console.log('✅ InvestorRequestManager deployed:', managerAddress);

    // Verify default lock requirements
    console.log('\n📊 Default Lock Requirements:');
    const retailLock = await investorRequestManager.lockRequirements(1); // Retail
    const accreditedLock = await investorRequestManager.lockRequirements(2); // Accredited
    const institutionalLock = await investorRequestManager.lockRequirements(3); // Institutional

    console.log(`   Retail: ${ethers.formatEther(retailLock)} tokens`);
    console.log(`   Accredited: ${ethers.formatEther(accreditedLock)} tokens`);
    console.log(`   Institutional: ${ethers.formatEther(institutionalLock)} tokens`);

    // Authorize InvestorRequestManager as compliance officer
    console.log('\n🔐 Authorizing InvestorRequestManager as compliance officer...');
    const InvestorTypeRegistry = await ethers.getContractAt('InvestorTypeRegistry', INVESTOR_REGISTRY_ADDRESS);
    
    try {
        const tx = await InvestorTypeRegistry.setComplianceOfficer(managerAddress, true);
        await tx.wait();
        console.log('✅ InvestorRequestManager authorized as compliance officer');
    } catch (error: any) {
        console.log('⚠️  Could not authorize (may need owner permissions):', error.message);
    }

    // Summary
    console.log('\n✅ Deployment Complete!');
    console.log('='.repeat(60));
    console.log('\n📝 Deployment Summary:');
    console.log(`   InvestorRequestManager: ${managerAddress}`);
    console.log(`   Bank: ${BANK_ADDRESS}`);
    console.log(`   Token: ${TOKEN_ADDRESS}`);
    console.log(`   InvestorTypeRegistry: ${INVESTOR_REGISTRY_ADDRESS}`);
    console.log(`   IdentityRegistry: ${IDENTITY_REGISTRY_ADDRESS}`);

    console.log('\n🎯 Next Steps:');
    console.log('1. Users can request investor status using requestInvestorStatus()');
    console.log('2. Bank creates multi-sig wallets using createMultiSigWallet()');
    console.log('3. Users lock tokens in their multi-sig wallets');
    console.log('4. Users confirm tokens locked using confirmTokensLocked()');
    console.log('5. Bank approves requests using approveRequest()');

    console.log('\n💡 To test the system, run:');
    console.log('   npx hardhat run scripts/interactive-erc3643-demo.ts');

    // Save deployment info
    const deploymentInfo = {
        network: (await ethers.provider.getNetwork()).name,
        chainId: (await ethers.provider.getNetwork()).chainId,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            investorRequestManager: managerAddress,
            bank: BANK_ADDRESS,
            token: TOKEN_ADDRESS,
            investorTypeRegistry: INVESTOR_REGISTRY_ADDRESS,
            identityRegistry: IDENTITY_REGISTRY_ADDRESS
        },
        lockRequirements: {
            retail: ethers.formatEther(retailLock),
            accredited: ethers.formatEther(accreditedLock),
            institutional: ethers.formatEther(institutionalLock)
        }
    };

    console.log('\n📄 Deployment Info:');
    console.log(JSON.stringify(deploymentInfo, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Deployment failed:', error);
        process.exit(1);
    });

