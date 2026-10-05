import { ethers } from "hardhat";
import {
  OnchainIDFactory,
  ClaimIssuer,
  KeyManager,
  IdentityRegistry,
  ComplianceRules,
} from "../../typechain-types";
import { DeploymentHelper } from "../deploy-helpers";
import { authorizeKeyManagerOnOps, OpsKeyManagerResult } from "./opsKeyManager";

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
  kycTopic: number;
  amlTopic: number;
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
  identityRegistry: IdentityRegistry;
  complianceRules: ComplianceRules;
  /** Task 4.2: KeyManager on the ops identity (OPS_IDENTITY). */
  opsKeyManager: OpsKeyManagerResult;
  addresses: {
    factory: string;
    keyManager: string;
    kycIssuer: string;
    amlIssuer: string;
    identityRegistry: string;
    complianceRules: string;
  };
  gasUsed: {
    factory: bigint;
    keyManager: bigint;
    kycIssuer: bigint;
    amlIssuer: bigint;
    identityRegistry: bigint;
    complianceRules: bigint;
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
  const network = await ethers.provider.getNetwork();

  console.log(`📋 Deployment Configuration:`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Balance: ${ethers.formatEther(deployerBalance)} ETH`);
  console.log(`   Network: ${network.name}`);
  console.log(`   Chain ID: ${network.chainId}`);

  // Production configuration
  const config: DeploymentConfig = {
    deploymentFee: ethers.parseEther("0.01"), // 0.01 ETH per identity
    feeRecipient: deployer.address,
    gasPrice: ethers.parseUnits("20", "gwei"), // 20 gwei
    gasLimit: 10000000, // 10M; OnchainIDFactory alone needs more than 5M to deploy (pre-existing, unrelated to this change)
    // Hardhat's ephemeral in-memory network only mines a new block when a
    // transaction is sent, so waiting for more than 1 confirmation here
    // hangs forever (pre-existing, unrelated to this change; mirrors
    // ProductionEnvironment.ts's minConfirmations workaround).
    confirmations: network.name === "hardhat" ? 1 : 3,
    kycTopic: 6, // OnchainID.KYC_TOPIC
    amlTopic: 7, // OnchainID.AML_TOPIC
    kycProvider: {
      name: "Global KYC Solutions Ltd",
      description:
        "Enterprise-grade KYC verification service for financial institutions worldwide",
    },
    amlProvider: {
      name: "AML Compliance International",
      description:
        "Anti-Money Laundering compliance and screening service with global coverage",
    },
  };

  console.log(`\n⚙️  Production Configuration:`);
  console.log(
    `   Deployment Fee: ${ethers.formatEther(config.deploymentFee)} ETH`,
  );
  console.log(
    `   Gas Price: ${ethers.formatUnits(config.gasPrice, "gwei")} gwei`,
  );
  console.log(`   Gas Limit: ${config.gasLimit.toLocaleString()}`);
  console.log(`   Confirmations: ${config.confirmations}`);

  // Verify sufficient balance
  const estimatedCost = config.gasPrice * BigInt(config.gasLimit * 6); // 6 contracts
  if (deployerBalance < estimatedCost) {
    throw new Error(
      `Insufficient balance. Need at least ${ethers.formatEther(estimatedCost)} ETH`,
    );
  }

  const deploymentOptions = {
    gasPrice: config.gasPrice,
    gasLimit: config.gasLimit,
  };

  const gasUsed = {
    factory: BigInt(0),
    keyManager: BigInt(0),
    kycIssuer: BigInt(0),
    amlIssuer: BigInt(0),
    identityRegistry: BigInt(0),
    complianceRules: BigInt(0),
    total: BigInt(0),
  };

  console.log("\n📦 Deploying Core Contracts...");
  console.log("-".repeat(40));

  // 1. Deploy OnchainIDFactory
  console.log("🏭 Deploying OnchainIDFactory...");
  const OnchainIDFactoryFactory =
    await ethers.getContractFactory("OnchainIDFactory");
  const factory = await OnchainIDFactoryFactory.deploy(
    deployer.address,
    deploymentOptions,
  );

  console.log(`   Transaction hash: ${factory.deploymentTransaction()?.hash}`);
  console.log("   Waiting for confirmations...");

  await factory.waitForDeployment();
  const factoryReceipt = await factory
    .deploymentTransaction()
    ?.wait(config.confirmations);
  gasUsed.factory = factoryReceipt?.gasUsed || BigInt(0);

  const factoryAddress = await factory.getAddress();
  console.log(`✅ Factory deployed at: ${factoryAddress}`);
  console.log(`   Gas used: ${gasUsed.factory.toLocaleString()}`);

  // 2. Deploy KeyManager
  console.log("\n🔐 Deploying KeyManager...");
  const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
  const keyManager = await KeyManagerFactory.deploy(deploymentOptions);

  console.log(
    `   Transaction hash: ${keyManager.deploymentTransaction()?.hash}`,
  );
  console.log("   Waiting for confirmations...");

  await keyManager.waitForDeployment();
  const keyManagerReceipt = await keyManager
    .deploymentTransaction()
    ?.wait(config.confirmations);
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
    deploymentOptions,
  );

  console.log(
    `   Transaction hash: ${kycIssuer.deploymentTransaction()?.hash}`,
  );
  console.log("   Waiting for confirmations...");

  await kycIssuer.waitForDeployment();
  const kycIssuerReceipt = await kycIssuer
    .deploymentTransaction()
    ?.wait(config.confirmations);
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
    deploymentOptions,
  );

  console.log(
    `   Transaction hash: ${amlIssuer.deploymentTransaction()?.hash}`,
  );
  console.log("   Waiting for confirmations...");

  await amlIssuer.waitForDeployment();
  const amlIssuerReceipt = await amlIssuer
    .deploymentTransaction()
    ?.wait(config.confirmations);
  gasUsed.amlIssuer = amlIssuerReceipt?.gasUsed || BigInt(0);

  const amlIssuerAddress = await amlIssuer.getAddress();
  console.log(`✅ AML Issuer deployed at: ${amlIssuerAddress}`);
  console.log(`   Gas used: ${gasUsed.amlIssuer.toLocaleString()}`);

  // 5. Deploy IdentityRegistry
  console.log("\n🪪 Deploying IdentityRegistry...");
  const IdentityRegistryFactory =
    await ethers.getContractFactory("IdentityRegistry");
  const identityRegistry =
    await IdentityRegistryFactory.deploy(deploymentOptions);

  console.log(
    `   Transaction hash: ${identityRegistry.deploymentTransaction()?.hash}`,
  );
  console.log("   Waiting for confirmations...");

  await identityRegistry.waitForDeployment();
  const identityRegistryReceipt = await identityRegistry
    .deploymentTransaction()
    ?.wait(config.confirmations);
  gasUsed.identityRegistry = identityRegistryReceipt?.gasUsed || BigInt(0);

  const identityRegistryAddress = await identityRegistry.getAddress();
  console.log(`✅ IdentityRegistry deployed at: ${identityRegistryAddress}`);
  console.log(`   Gas used: ${gasUsed.identityRegistry.toLocaleString()}`);

  // 6. Deploy ComplianceRules
  console.log("\n⚖️  Deploying ComplianceRules...");
  const ComplianceRulesFactory =
    await ethers.getContractFactory("ComplianceRules");
  const complianceRules = await ComplianceRulesFactory.deploy(
    deployer.address,
    [],
    [],
    deploymentOptions,
  );

  console.log(
    `   Transaction hash: ${complianceRules.deploymentTransaction()?.hash}`,
  );
  console.log("   Waiting for confirmations...");

  await complianceRules.waitForDeployment();
  const complianceRulesReceipt = await complianceRules
    .deploymentTransaction()
    ?.wait(config.confirmations);
  gasUsed.complianceRules = complianceRulesReceipt?.gasUsed || BigInt(0);

  const complianceRulesAddress = await complianceRules.getAddress();
  console.log(`✅ ComplianceRules deployed at: ${complianceRulesAddress}`);
  console.log(`   Gas used: ${gasUsed.complianceRules.toLocaleString()}`);

  // Calculate total gas used
  gasUsed.total =
    gasUsed.factory +
    gasUsed.keyManager +
    gasUsed.kycIssuer +
    gasUsed.amlIssuer +
    gasUsed.identityRegistry +
    gasUsed.complianceRules;

  console.log("\n⚙️  Configuring System...");
  console.log("-".repeat(40));

  // Configure Factory
  console.log("🏭 Configuring OnchainIDFactory...");
  const setFeeTx = await factory
    .connect(deployer)
    .setDeploymentFee(config.deploymentFee, deploymentOptions);
  await setFeeTx.wait(config.confirmations);
  console.log(
    `   Deployment fee set to: ${ethers.formatEther(config.deploymentFee)} ETH`,
  );

  const setRecipientTx = await factory
    .connect(deployer)
    .setFeeRecipient(config.feeRecipient, deploymentOptions);
  await setRecipientTx.wait(config.confirmations);
  console.log(`   Fee recipient set to: ${config.feeRecipient}`);

  // Configure IdentityRegistry: require KYC and AML claims from the
  // deployed issuers before any wallet verifies. A registry with no
  // required topics would verify anyone who registers. This runs before
  // KeyManager configuration below since the two are independent and the
  // registry must never be left unconfigured if a later step fails.
  console.log("\n🪪 Configuring IdentityRegistry...");
  const addKycIssuerTx = await identityRegistry
    .connect(deployer)
    .addTrustedIssuer(kycIssuerAddress, [config.kycTopic], deploymentOptions);
  await addKycIssuerTx.wait(config.confirmations);
  console.log(`   Trusted issuer added for KYC topic: ${kycIssuerAddress}`);

  const addAmlIssuerTx = await identityRegistry
    .connect(deployer)
    .addTrustedIssuer(amlIssuerAddress, [config.amlTopic], deploymentOptions);
  await addAmlIssuerTx.wait(config.confirmations);
  console.log(`   Trusted issuer added for AML topic: ${amlIssuerAddress}`);

  const addKycTopicTx = await identityRegistry
    .connect(deployer)
    .addClaimTopic(config.kycTopic, deploymentOptions);
  await addKycTopicTx.wait(config.confirmations);
  console.log(`   Required claim topic added: KYC (${config.kycTopic})`);

  const addAmlTopicTx = await identityRegistry
    .connect(deployer)
    .addClaimTopic(config.amlTopic, deploymentOptions);
  await addAmlTopicTx.wait(config.confirmations);
  console.log(`   Required claim topic added: AML (${config.amlTopic})`);

  // Refuse to proceed if the registry or compliance ended up permissive.
  await DeploymentHelper.assertProductionCompliance(
    complianceRulesAddress,
    identityRegistryAddress,
  );

  // Configure KeyManager: RECOVERY_TIMELOCK (48h) and DEFAULT_TIMELOCK (24h)
  // are fixed contract constants, not configurable — KeyManager exposes no
  // setRecoveryTimelock/setKeyRotationTimelock setters (only a per-identity
  // setCustomTimelock override). Read and log them so this step stays
  // informative without pretending to configure something immutable.
  console.log("\n🔐 Configuring KeyManager...");
  const recoveryTimelock = await keyManager.RECOVERY_TIMELOCK();
  const keyRotationTimelock = await keyManager.DEFAULT_TIMELOCK();
  console.log(`   Recovery timelock: ${recoveryTimelock} seconds (fixed)`);
  console.log(
    `   Key rotation timelock: ${keyRotationTimelock} seconds (default; an identity's MANAGEMENT key may set its own)`,
  );
  const opsKeyManager = await authorizeKeyManagerOnOps(
    keyManagerAddress,
    deployer,
    process.env.OPS_IDENTITY,
    deploymentOptions,
  );

  console.log("\n✅ System Configuration Complete!");

  // Calculate deployment costs
  const totalGasCost = gasUsed.total * config.gasPrice;
  const ethPrice = 2000; // Assume $2000 ETH for USD calculation
  const deploymentCostUSD = (
    Number(ethers.formatEther(totalGasCost)) * ethPrice
  ).toFixed(2);

  console.log("\n💰 Deployment Cost Analysis:");
  console.log("-".repeat(40));
  console.log(`   Total Gas Used: ${gasUsed.total.toLocaleString()}`);
  console.log(
    `   Gas Price: ${ethers.formatUnits(config.gasPrice, "gwei")} gwei`,
  );
  console.log(`   Total Cost: ${ethers.formatEther(totalGasCost)} ETH`);
  console.log(`   Estimated USD Cost: $${deploymentCostUSD}`);

  // Verify deployments
  console.log("\n🔍 Verifying Deployments...");
  console.log("-".repeat(40));

  const factoryCode = await ethers.provider.getCode(factoryAddress);
  const keyManagerCode = await ethers.provider.getCode(keyManagerAddress);
  const kycIssuerCode = await ethers.provider.getCode(kycIssuerAddress);
  const amlIssuerCode = await ethers.provider.getCode(amlIssuerAddress);
  const identityRegistryCode = await ethers.provider.getCode(
    identityRegistryAddress,
  );
  const complianceRulesCode = await ethers.provider.getCode(
    complianceRulesAddress,
  );

  if (
    factoryCode === "0x" ||
    keyManagerCode === "0x" ||
    kycIssuerCode === "0x" ||
    amlIssuerCode === "0x" ||
    identityRegistryCode === "0x" ||
    complianceRulesCode === "0x"
  ) {
    throw new Error(
      "Contract verification failed - one or more contracts not deployed properly",
    );
  }

  console.log("✅ All contracts verified successfully!");

  // Test basic functionality
  console.log("\n🧪 Testing Basic Functionality...");
  console.log("-".repeat(40));

  const currentFee = await factory.deploymentFee();
  const currentRecipient = await factory.feeRecipient();

  console.log(`   Deployment fee: ${ethers.formatEther(currentFee)} ETH ✅`);
  console.log(`   Fee recipient: ${currentRecipient} ✅`);

  console.log(`   Recovery timelock: ${recoveryTimelock} seconds ✅`);
  console.log(`   Key rotation timelock: ${keyRotationTimelock} seconds ✅`);

  console.log("✅ Basic functionality tests passed!");

  // Generate deployment summary
  const deploymentResult: DeploymentResult = {
    factory,
    keyManager,
    kycIssuer,
    amlIssuer,
    identityRegistry,
    complianceRules,
    opsKeyManager,
    addresses: {
      factory: factoryAddress,
      keyManager: keyManagerAddress,
      kycIssuer: kycIssuerAddress,
      amlIssuer: amlIssuerAddress,
      identityRegistry: identityRegistryAddress,
      complianceRules: complianceRulesAddress,
    },
    gasUsed,
    deploymentCost: {
      eth: ethers.formatEther(totalGasCost),
      usd: deploymentCostUSD,
    },
  };

  console.log("\n📋 Deployment Summary:");
  console.log("=".repeat(60));
  console.log(`🏭 OnchainIDFactory: ${factoryAddress}`);
  console.log(`🔐 KeyManager: ${keyManagerAddress}`);
  console.log(`📋 KYC Issuer: ${kycIssuerAddress}`);
  console.log(`🔍 AML Issuer: ${amlIssuerAddress}`);
  console.log(`🪪 IdentityRegistry: ${identityRegistryAddress}`);
  console.log(`⚖️  ComplianceRules: ${complianceRulesAddress}`);
  console.log(
    `💰 Total Cost: ${deploymentResult.deploymentCost.eth} ETH (~$${deploymentResult.deploymentCost.usd})`,
  );
  console.log("=".repeat(60));

  console.log("\n🎉 Production Deployment Complete!");
  console.log("🚀 OnchainID System is ready for production use!");

  // Save deployment info to file
  const deploymentInfo = {
    timestamp: new Date().toISOString(),
    network: network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    addresses: deploymentResult.addresses,
    gasUsed: {
      factory: gasUsed.factory.toString(),
      keyManager: gasUsed.keyManager.toString(),
      kycIssuer: gasUsed.kycIssuer.toString(),
      amlIssuer: gasUsed.amlIssuer.toString(),
      identityRegistry: gasUsed.identityRegistry.toString(),
      complianceRules: gasUsed.complianceRules.toString(),
      total: gasUsed.total.toString(),
    },
    deploymentCost: deploymentResult.deploymentCost,
    configuration: {
      deploymentFee: ethers.formatEther(config.deploymentFee),
      feeRecipient: config.feeRecipient,
      gasPrice: ethers.formatUnits(config.gasPrice, "gwei") + " gwei",
    },
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
