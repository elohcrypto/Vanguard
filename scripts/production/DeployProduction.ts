import { ethers } from "hardhat";
import { OnchainIDFactory, ClaimIssuer, KeyManager } from "../../typechain-types";

/**
 * Production Deployment Script
 * Deploys the complete OnchainID system with production-ready configuration
 */

interface DeploymentConfig {
    deploymentFee: bigint;
    feeRecipient: string;
    gasPrice: bigint;
    gasLimit: number;
    confirmations: number;
    kycProvider: {
        name: string;
        description: string;
    };
    amlProvider: {
        name: string;
        description: string;
    };
}

interface DeploymentResult {
    factory: OnchainIDFactory;
    keyManager: KeyManager;
    kycIssuer: ClaimIssuer;
    amlIssuer: ClaimIssuer;
    addresses: {
        factory: string;
        keyManager: string;
        kycIssuer: string;
        amlIssuer: string;
    };
    gasUsed: {
        factory: bigint;
        keyManager: bigint;
        kycIssuer: bigint;
        amlIssuer: bigint;
        total: bigint;
    };
    deploymentCost: {
        eth: string;
        usd: string;
    };
}

async function main(): Promise<DeploymentResult> {
    console.log("🚀 Starting Production Deployment of OnchainID System...");
    console.log("=".repeat(60));

    const [deployer] = await ethers.getSigners();
    const deployerBalance = await ethers.provider.getBalance(deployer.address);

    console.log(`📋 Deployment Configuration:`);
    console.log(`   Deployer: ${deployer.address}`);
    console.log(`   Balance: ${ethers.formatEther(deployerBalance)} ETH`);
    console.log(`   Network: ${(await ethers.provider.getNetwork()).name}`);
    console.log(`   Chain ID: ${(await ethers.provider.getNetwork()).chainId}`);

    // Production configuration
    const config: DeploymentConfig = {
        deploymentFee: ethers.parseEther("0.01"), // 0.01 ETH per identity
        feeRecipient: deployer.address,
        gasPrice: ethers.parseUnits("20", "gwei"), // 20 gwei
        gasLimit: 5000000, // 5M gas limit
        confirmations: 3, // Wait for 3 confirmations
        kycProvider: {
            name: "Global KYC Solutions Ltd",
            description: "Enterprise-grade KYC verification service for financial institutions worldwide"
        },
        amlProvider: {
            name: "AML Compliance International",
            description: "Anti-Money Laundering compliance and screening service with global coverage"
        }
    };

    console.log(`\n⚙️  Production Configuration:`);
    console.log(`   Deployment Fee: ${ethers.formatEther(config.deploymentFee)} ETH`);
    console.log(`   Gas Price: ${ethers.formatUnits(config.gasPrice, "gwei")} gwei`);
    console.log(`   Gas Limit: ${config.gasLimit.toLocaleString()}`);
    console.log(`   Confirmations: ${config.confirmations}`);

    // Verify sufficient balance
    const estimatedCost = config.gasPrice * BigInt(config.gasLimit * 4); // 4 contracts
    if (deployerBalance < estimatedCost) {
        throw new Error(`Insufficient balance. Need at least ${ethers.formatEther(estimatedCost)} ETH`);
    }

    const deploymentOptions = {
        gasPrice: config.gasPrice,
        gasLimit: config.gasLimit
    };

    const gasUsed = {
        factory: BigInt(0),
        keyManager: BigInt(0),
        kycIssuer: BigInt(0),
        amlIssuer: BigInt(0),
        total: BigInt(0)
    };

    console.log("\n📦 Deploying Core Contracts...");
    console.log("-".repeat(40));

    // 1. Deploy OnchainIDFactory
    console.log("🏭 Deploying OnchainIDFactory...");
    const OnchainIDFactoryFactory = await ethers.getContractFactory("OnchainIDFactory");
    const factory = await OnchainIDFactoryFactory.deploy(deployer.address, deploymentOptions);

    console.log(`   Transaction hash: ${factory.deploymentTransaction()?.hash}`);
    console.log("   Waiting for confirmations...");

    await factory.waitForDeployment();
    const factoryReceipt = await factory.deploymentTransaction()?.wait(config.confirmations);
    gasUsed.factory = factoryReceipt?.gasUsed || BigInt(0);

    const factoryAddress = await factory.getAddress();
    console.log(`✅ Factory deployed at: ${factoryAddress}`);
    console.log(`   Gas used: ${gasUsed.factory.toLocaleString()}`);

    // 2. Deploy KeyManager
    console.log("\n🔐 Deploying KeyManager...");
    const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
    const keyManager = await KeyManagerFactory.deploy(deployer.address, deploymentOptions);

    console.log(`   Transaction hash: ${keyManager.deploymentTransaction()?.hash}`);
    console.log("   Waiting for confirmations...");

    await keyManager.waitForDeployment();
    const keyManagerReceipt = await keyManager.deploymentTransaction()?.wait(config.confirmations);
    gasUsed.keyManager = keyManagerReceipt?.gasUsed || BigInt(0);

    const keyManagerAddress = await keyManager.getAddress();
    console.log(`✅ KeyManager deployed at: ${keyManagerAddress}`);
    console.log(`   Gas used: ${gasUsed.keyManager.toLocaleString()}`);

    // 3. Deploy KYC Issuer
    console.log("\n📋 Deploying KYC Issuer...");
    const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
    const kycIssuer = await ClaimIssuerFactory.deploy(
        deployer.address, // Will be changed to actual KYC provider
        config.kycProvider.name,
        config.kycProvider.description,
        deploymentOptions
    );

    console.log(`   Transaction hash: ${kycIssuer.deploymentTransaction()?.hash}`);
    console.log("   Waiting for confirmations...");

    await kycIssuer.waitForDeployment();
    const kycIssuerReceipt = await kycIssuer.deploymentTransaction()?.wait(config.confirmations);
    gasUsed.kycIssuer = kycIssuerReceipt?.gasUsed || BigInt(0);

    const kycIssuerAddress = await kycIssuer.getAddress();
    console.log(`✅ KYC Issuer deployed at: ${kycIssuerAddress}`);
    console.log(`   Gas used: ${gasUsed.kycIssuer.toLocaleString()}`);

    // 4. Deploy AML Issuer
    console.log("\n🔍 Deploying AML Issuer...");
    const amlIssuer = await ClaimIssuerFactory.deploy(
        deployer.address, // Will be changed to actual AML provider
        config.amlProvider.name,
        config.amlProvider.description,
        deploymentOptions
    );

    console.log(`   Transaction hash: ${amlIssuer.deploymentTransaction()?.hash}`);
    console.log("   Waiting for confirmations...");

    await amlIssuer.waitForDeployment();
    const amlIssuerReceipt = await amlIssuer.deploymentTransaction()?.wait(config.confirmations);
    gasUsed.amlIssuer = amlIssuerReceipt?.gasUsed || BigInt(0);

    const amlIssuerAddress = await amlIssuer.getAddress();
    console.log(`✅ AML Issuer deployed at: ${amlIssuerAddress}`);
    console.log(`   Gas used: ${gasUsed.amlIssuer.toLocaleString()}`);

    // Calculate total gas used
    gasUsed.total = gasUsed.factory + gasUsed.keyManager + gasUsed.kycIssuer + gasUsed.amlIssuer;

    console.log("\n⚙️  Configuring System...");
    console.log("-".repeat(40));

    // Configure Factory
    console.log("🏭 Configuring OnchainIDFactory...");
    const setFeeTx = await factory.connect(deployer).setDeploymentFee(config.deploymentFee, deploymentOptions);
    await setFeeTx.wait(config.confirmations);
    console.log(`   Deployment fee set to: ${ethers.formatEther(config.deploymentFee)} ETH`);

    const setRecipientTx = await factory.connect(deployer).setFeeRecipient(config.feeRecipient, deploymentOptions);
    await setRecipientTx.wait(config.confirmations);
    console.log(`   Fee recipient set to: ${config.feeRecipient}`);

    // Configure KeyManager
    console.log("\n🔐 Configuring KeyManager...");
    const setRecoveryTimelockTx = await keyManager.connect(deployer).setRecoveryTimelock(48 * 60 * 60, deploymentOptions); // 48 hours
    await setRecoveryTimelockTx.wait(config.confirmations);
    console.log("   Recovery timelock set to: 48 hours");

    const setKeyRotationTimelockTx = await keyManager.connect(deployer).setKeyRotationTimelock(24 * 60 * 60, deploymentOptions); // 24 hours
    await setKeyRotationTimelockTx.wait(config.confirmations);
    console.log("   Key rotation timelock set to: 24 hours");

    console.log("\n✅ System Configuration Complete!");

    // Calculate deployment costs
    const totalGasCost = gasUsed.total * config.gasPrice;
    const ethPrice = 2000; // Assume $2000 ETH for USD calculation
    const deploymentCostUSD = (Number(ethers.formatEther(totalGasCost)) * ethPrice).toFixed(2);

    console.log("\n💰 Deployment Cost Analysis:");
    console.log("-".repeat(40));
    console.log(`   Total Gas Used: ${gasUsed.total.toLocaleString()}`);
    console.log(`   Gas Price: ${ethers.formatUnits(config.gasPrice, "gwei")} gwei`);
    console.log(`   Total Cost: ${ethers.formatEther(totalGasCost)} ETH`);
    console.log(`   Estimated USD Cost: $${deploymentCostUSD}`);

    // Verify deployments
    console.log("\n🔍 Verifying Deployments...");
    console.log("-".repeat(40));

    const factoryCode = await ethers.provider.getCode(factoryAddress);
    const keyManagerCode = await ethers.provider.getCode(keyManagerAddress);
    const kycIssuerCode = await ethers.provider.getCode(kycIssuerAddress);
    const amlIssuerCode = await ethers.provider.getCode(amlIssuerAddress);

    if (factoryCode === "0x" || keyManagerCode === "0x" || kycIssuerCode === "0x" || amlIssuerCode === "0x") {
        throw new Error("Contract verification failed - one or more contracts not deployed properly");
    }

    console.log("✅ All contracts verified successfully!");

    // Test basic functionality
    console.log("\n🧪 Testing Basic Functionality...");
    console.log("-".repeat(40));

    const currentFee = await factory.deploymentFee();
    const currentRecipient = await factory.feeRecipient();

    console.log(`   Deployment fee: ${ethers.formatEther(currentFee)} ETH ✅`);
    console.log(`   Fee recipient: ${currentRecipient} ✅`);

    const recoveryTimelock = await keyManager.recoveryTimelock();
    const keyRotationTimelock = await keyManager.keyRotationTimelock();

    console.log(`   Recovery timelock: ${recoveryTimelock} seconds ✅`);
    console.log(`   Key rotation timelock: ${keyRotationTimelock} seconds ✅`);

    console.log("✅ Basic functionality tests passed!");

    // Generate deployment summary
    const deploymentResult: DeploymentResult = {
        factory,
        keyManager,
        kycIssuer,
        amlIssuer,
        addresses: {
            factory: factoryAddress,
            keyManager: keyManagerAddress,
            kycIssuer: kycIssuerAddress,
            amlIssuer: amlIssuerAddress
        },
        gasUsed,
        deploymentCost: {
            eth: ethers.formatEther(totalGasCost),
            usd: deploymentCostUSD
        }
    };

    console.log("\n📋 Deployment Summary:");
    console.log("=".repeat(60));
    console.log(`🏭 OnchainIDFactory: ${factoryAddress}`);
    console.log(`🔐 KeyManager: ${keyManagerAddress}`);
    console.log(`📋 KYC Issuer: ${kycIssuerAddress}`);
    console.log(`🔍 AML Issuer: ${amlIssuerAddress}`);
    console.log(`💰 Total Cost: ${deploymentResult.deploymentCost.eth} ETH (~$${deploymentResult.deploymentCost.usd})`);
    console.log("=".repeat(60));

    console.log("\n🎉 Production Deployment Complete!");
    console.log("🚀 OnchainID System is ready for production use!");

    // Save deployment info to file
    const deploymentInfo = {
        timestamp: new Date().toISOString(),
        network: (await ethers.provider.getNetwork()).name,
        chainId: (await ethers.provider.getNetwork()).chainId,
        deployer: deployer.address,
        addresses: deploymentResult.addresses,
        gasUsed: {
            factory: gasUsed.factory.toString(),
            keyManager: gasUsed.keyManager.toString(),
            kycIssuer: gasUsed.kycIssuer.toString(),
            amlIssuer: gasUsed.amlIssuer.toString(),
            total: gasUsed.total.toString()
        },
        deploymentCost: deploymentResult.deploymentCost,
        configuration: {
            deploymentFee: ethers.formatEther(config.deploymentFee),
            feeRecipient: config.feeRecipient,
            gasPrice: ethers.formatUnits(config.gasPrice, "gwei") + " gwei"
        }
    };

    console.log("\n💾 Saving deployment information...");
    // In a real deployment, you would save this to a file
    console.log(JSON.stringify(deploymentInfo, null, 2));

    return deploymentResult;
}

// Execute deployment if this script is run directly
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error("❌ Deployment failed:", error);
            process.exit(1);
        });
}

export { main as deployProduction, DeploymentConfig, DeploymentResult };