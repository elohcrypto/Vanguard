import { artifacts, ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OnchainID,
  OnchainIDFactory,
  ClaimIssuer,
  KeyManager,
  IdentityRegistry,
} from "../../typechain-types";
import { signClaim } from "../helpers/kyc";

/**
 * Production Environment Simulator
 * Creates a realistic production-like environment for testing
 */
export class ProductionEnvironment {
  // Core contracts
  public factory!: OnchainIDFactory;
  public keyManager!: KeyManager;
  public kycIssuer!: ClaimIssuer;
  public amlIssuer!: ClaimIssuer;
  public complianceIssuer!: ClaimIssuer;
  public identityRegistry!: IdentityRegistry;

  // Network actors
  public admin!: SignerWithAddress;
  public feeRecipient!: SignerWithAddress;
  public kycProvider!: SignerWithAddress;
  public amlProvider!: SignerWithAddress;
  public complianceOfficer!: SignerWithAddress;
  public regulator!: SignerWithAddress;

  // Recovery agents
  public recoveryAgents!: SignerWithAddress[];

  // Test users
  public individualUser!: SignerWithAddress;
  public corporateUser!: SignerWithAddress;
  public institutionalUser!: SignerWithAddress;

  // Attackers for security testing
  public maliciousActor1!: SignerWithAddress;
  public maliciousActor2!: SignerWithAddress;

  // Production configuration
  public readonly config = {
    deploymentFee: ethers.parseEther("0.01"),
    kycTopic: 6,
    amlTopic: 7,
    investorTypeTopic: 8,
    accreditationTopic: 9,
    ecdsaScheme: 1,
    recoveryTimelock: 48 * 60 * 60, // 48 hours
    keyRotationTimelock: 24 * 60 * 60, // 24 hours
    claimValidityPeriod: 365 * 24 * 60 * 60, // 1 year
    maxGasPrice: ethers.parseUnits("50", "gwei"),
    minConfirmations: 1, // Use 1 for local testing to avoid hanging
  };

  // Network simulation parameters
  public networkConditions = {
    gasPrice: ethers.parseUnits("20", "gwei"),
    blockTime: 12, // seconds
    networkCongestion: false,
    mempoolSize: 0,
  };

  async initialize(): Promise<void> {
    console.log("🏗️  Initializing Production Environment...");

    await this.setupActors();
    await this.deployContracts();
    await this.configureSystem();
    await this.setupTrustedIssuers();

    console.log("✅ Production Environment Ready!");
  }

  private async setupActors(): Promise<void> {
    console.log("👥 Setting up network actors...");

    const signers = await ethers.getSigners();

    // Assign roles to different signers
    this.admin = signers[0];
    this.feeRecipient = signers[1];
    this.kycProvider = signers[2];
    this.amlProvider = signers[3];
    this.complianceOfficer = signers[4];
    this.regulator = signers[5];

    // Recovery agents (3 for 2-of-3 multisig)
    this.recoveryAgents = [signers[6], signers[7], signers[8]];

    // Test users
    this.individualUser = signers[9];
    this.corporateUser = signers[10];
    this.institutionalUser = signers[11];

    // Malicious actors for security testing
    this.maliciousActor1 = signers[12];
    this.maliciousActor2 = signers[13];

    console.log(`   Admin: ${this.admin.address}`);
    console.log(`   KYC Provider: ${this.kycProvider.address}`);
    console.log(`   AML Provider: ${this.amlProvider.address}`);
    console.log(`   Recovery Agents: ${this.recoveryAgents.length}`);
  }

  private async deployContracts(): Promise<void> {
    console.log("📦 Deploying production contracts...");

    // 10M fits the plain network's 12M block limit; under solidity-coverage
    // the instrumented factory initcode is ~1.9x larger, so `npm run
    // test:coverage` sets DEPLOY_GAS_LIMIT=16000000 (hardhat's per-tx cap
    // is 2^24 = 16,777,216).
    const deployOptions = {
      gasPrice: this.networkConditions.gasPrice,
      gasLimit: Number(process.env.DEPLOY_GAS_LIMIT ?? 10000000),
    };

    // 1. Deploy OnchainIDFactory, accepting only the compiled KeyManager as
    //    recovery manager (Task 4.11; Task 4.16 W-2: as the demo deploys).
    const kmHash = ethers.keccak256(
      (await artifacts.readArtifact("KeyManager")).deployedBytecode,
    );
    const FactoryFactory = await ethers.getContractFactory("OnchainIDFactory");
    this.factory = await FactoryFactory.deploy(
      this.admin.address,
      kmHash,
      deployOptions,
    );
    await this.factory.waitForDeployment();
    console.log(`   Factory: ${await this.factory.getAddress()}`);

    // 2. Deploy KeyManager; the factory pins it on every identity it creates.
    const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
    this.keyManager = await KeyManagerFactory.deploy(deployOptions);
    await this.keyManager.waitForDeployment();
    const kmAddr = await this.keyManager.getAddress();
    await this.factory.setRecoveryManager(kmAddr, deployOptions);
    console.log(`   KeyManager: ${kmAddr} (pinned on the factory)`);

    // 3. Deploy KYC Issuer
    const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
    this.kycIssuer = await ClaimIssuerFactory.deploy(
      this.kycProvider.address,
      "Global KYC Solutions Ltd",
      "Enterprise-grade KYC verification for financial institutions worldwide",
      deployOptions,
    );
    await this.kycIssuer.waitForDeployment();
    console.log(`   KYC Issuer: ${await this.kycIssuer.getAddress()}`);

    // 4. Deploy AML Issuer
    this.amlIssuer = await ClaimIssuerFactory.deploy(
      this.amlProvider.address,
      "AML Compliance International",
      "Anti-Money Laundering screening and compliance verification service",
      deployOptions,
    );
    await this.amlIssuer.waitForDeployment();
    console.log(`   AML Issuer: ${await this.amlIssuer.getAddress()}`);

    // 5. Deploy Compliance Issuer
    this.complianceIssuer = await ClaimIssuerFactory.deploy(
      this.complianceOfficer.address,
      "Regulatory Compliance Corp",
      "Regulatory compliance verification and investor accreditation service",
      deployOptions,
    );
    await this.complianceIssuer.waitForDeployment();
    console.log(
      `   Compliance Issuer: ${await this.complianceIssuer.getAddress()}`,
    );

    // 6. Deploy IdentityRegistry
    const IdentityRegistryFactory =
      await ethers.getContractFactory("IdentityRegistry");
    this.identityRegistry = await IdentityRegistryFactory.deploy(deployOptions);
    await this.identityRegistry.waitForDeployment();
    console.log(
      `   IdentityRegistry: ${await this.identityRegistry.getAddress()}`,
    );
  }

  private async configureSystem(): Promise<void> {
    console.log("⚙️  Configuring production system...");

    // Configure factory
    await this.factory
      .connect(this.admin)
      .setDeploymentFee(this.config.deploymentFee);
    await this.factory
      .connect(this.admin)
      .setFeeRecipient(this.feeRecipient.address);

    // KeyManager timelocks are constants (24h default, 48h recovery; an
    // identity's MANAGEMENT key may setCustomTimelock). IdentityRegistry:
    // require the KYC and AML claims, else anyone registered would verify.
    await this.identityRegistry
      .connect(this.admin)
      .addTrustedIssuer(await this.kycIssuer.getAddress(), [
        this.config.kycTopic,
      ]);
    await this.identityRegistry
      .connect(this.admin)
      .addTrustedIssuer(await this.amlIssuer.getAddress(), [
        this.config.amlTopic,
      ]);
    await this.identityRegistry
      .connect(this.admin)
      .addClaimTopic(this.config.kycTopic);
    await this.identityRegistry
      .connect(this.admin)
      .addClaimTopic(this.config.amlTopic);
    console.log(
      "   IdentityRegistry requires KYC and AML claims from trusted issuers",
    );

    console.log("   System configuration complete");
  }

  private async setupTrustedIssuers(): Promise<void> {
    console.log("🏛️  Setting up trusted issuers...");

    // Add issuer keys for each service (only if they don't already exist)
    // Note: The constructor automatically adds the owner as a management key

    // For KYC issuer, add the KYC provider as a claim signer (different from owner)
    const kycSignerKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [this.kycProvider.address]),
    );
    try {
      await this.kycIssuer
        .connect(this.kycProvider)
        .addIssuerKey(kycSignerKey, 3, 1); // CLAIM_SIGNER_KEY
    } catch (error: any) {
      if (!error.message.includes("Key already exists")) {
        throw error;
      }
    }

    // For AML issuer, add the AML provider as a claim signer
    const amlSignerKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [this.amlProvider.address]),
    );
    try {
      await this.amlIssuer
        .connect(this.amlProvider)
        .addIssuerKey(amlSignerKey, 3, 1);
    } catch (error: any) {
      if (!error.message.includes("Key already exists")) {
        throw error;
      }
    }

    // For compliance issuer, add the compliance officer as a claim signer
    const complianceSignerKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [this.complianceOfficer.address]),
    );
    try {
      await this.complianceIssuer
        .connect(this.complianceOfficer)
        .addIssuerKey(complianceSignerKey, 3, 1);
    } catch (error: any) {
      if (!error.message.includes("Key already exists")) {
        throw error;
      }
    }

    console.log("   Trusted issuers configured");
  }

  // Simulate network conditions
  async simulateNetworkCongestion(enabled: boolean): Promise<void> {
    this.networkConditions.networkCongestion = enabled;
    if (enabled) {
      this.networkConditions.gasPrice = ethers.parseUnits("100", "gwei"); // High gas price
      console.log("🚦 Network congestion simulation: ENABLED");
    } else {
      this.networkConditions.gasPrice = ethers.parseUnits("20", "gwei"); // Normal gas price
      console.log("🚦 Network congestion simulation: DISABLED");
    }
  }

  // Create a production-ready identity with full compliance
  async createProductionIdentity(
    owner: SignerWithAddress,
    identityType: "individual" | "corporate" | "institutional",
  ): Promise<{ identity: OnchainID; address: string }> {
    console.log(`🆔 Creating ${identityType} identity for ${owner.address}...`);

    // Generate unique salt
    const salt = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "address", "uint256"],
        [identityType, owner.address, Date.now()],
      ),
    );

    // Deploy identity with production fee
    const tx = await this.factory
      .connect(owner)
      .deployOnchainID(owner.address, salt, {
        value: this.config.deploymentFee,
        gasPrice: this.networkConditions.gasPrice,
      });
    // For local testing, just wait for 1 confirmation to avoid hanging
    const confirmations =
      this.config.minConfirmations > 1 ? 1 : this.config.minConfirmations;
    await tx.wait(confirmations);

    const identityAddress = await this.factory.saltToIdentity(salt);
    const identity = await ethers.getContractAt("OnchainID", identityAddress);

    console.log(`   Identity deployed: ${identityAddress}`);
    return { identity, address: identityAddress };
  }

  // Issue production-grade KYC claim with real data structure
  async issueKYCClaim(identityAddress: string, userData: any): Promise<void> {
    console.log("📋 Issuing production KYC claim...");

    const kycData = {
      ...userData,
      verificationDate: new Date().toISOString(),
      verificationLevel: "ENHANCED",
      documentVerification: true,
      biometricVerification: true,
      addressVerification: true,
      sourceOfFunds: "VERIFIED",
      riskAssessment: "LOW",
      sanctionsScreening: "CLEAR",
      pepScreening: "CLEAR",
    };

    const claimData = ethers.solidityPacked(
      ["string"],
      [JSON.stringify(kycData)],
    );

    await this.issueSigned(
      this.kycIssuer,
      this.kycProvider,
      identityAddress,
      this.config.kycTopic,
      claimData,
      `https://kyc-provider.com/verification/${identityAddress}`,
    );

    console.log("   KYC claim issued successfully");
  }

  // Issue production-grade AML claim
  async issueAMLClaim(identityAddress: string): Promise<void> {
    console.log("🔍 Issuing production AML claim...");

    const amlData = {
      screeningDate: new Date().toISOString(),
      sanctionsCheck: "CLEAR",
      pepCheck: "CLEAR",
      adverseMediaCheck: "CLEAR",
      watchlistScreening: "CLEAR",
      riskScore: Math.floor(Math.random() * 20) + 1, // 1-20 (low risk)
      jurisdiction: "GLOBAL",
      dataSource: "WORLD-CHECK",
      confidence: "HIGH",
    };

    const claimData = ethers.solidityPacked(
      ["string"],
      [JSON.stringify(amlData)],
    );

    await this.issueSigned(
      this.amlIssuer,
      this.amlProvider,
      identityAddress,
      this.config.amlTopic,
      claimData,
      `https://aml-provider.com/screening/${identityAddress}`,
    );

    console.log("   AML claim issued successfully");
  }

  /** Signs every claim field (Task 5.2, L-D) and issues the claim. */
  private async issueSigned(
    issuer: any,
    signer: any,
    ...c: [string, number, string, string]
  ) {
    const [identity, topic, data, uri] = c;
    const block = await ethers.provider.getBlock("latest");
    const validTo = block!.timestamp + this.config.claimValidityPeriod;
    const scheme = this.config.ecdsaScheme;
    const f = { scheme, uri, validTo };
    const sig = await signClaim(signer, issuer, identity, topic, data, f);
    await issuer
      .connect(signer)
      .issueClaim(identity, topic, scheme, data, uri, validTo, sig, {
        gasPrice: this.networkConditions.gasPrice,
      });
  }

  // Setup comprehensive recovery system
  async setupRecoverySystem(
    identityAddress: string,
    owner: SignerWithAddress,
  ): Promise<void> {
    console.log("🛡️  Setting up production recovery system...");

    const identity = await ethers.getContractAt("OnchainID", identityAddress);

    // The identity owner authorizes KeyManager; KeyManager has no
    // allowlist of its own, the owner's MANAGEMENT key is the gate.
    await identity
      .connect(owner)
      .authorizeManager(await this.keyManager.getAddress());
    // Task 4.11: recovery runs through the pinned recovery manager.
    if ((await identity.recoveryManager()) === ethers.ZeroAddress) {
      await identity
        .connect(owner)
        .pinRecoveryManager(await this.keyManager.getAddress());
    }

    // Setup 2-of-3 recovery
    await this.keyManager.connect(owner).setupKeyRecovery(
      identityAddress,
      this.recoveryAgents.map((agent) => agent.address),
      2, // 2-of-3 threshold
    );

    console.log("   Recovery system configured");
  }

  // Simulate time passage for testing timelocks
  async fastForwardTime(seconds: number): Promise<void> {
    console.log(`⏰ Fast forwarding ${seconds} seconds...`);
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // Get comprehensive system statistics
  async getSystemStats(): Promise<any> {
    const stats = {
      totalIdentities: await this.factory.totalIdentities(),
      totalFeesCollected: await ethers.provider.getBalance(
        this.feeRecipient.address,
      ),
      factoryAddress: await this.factory.getAddress(),
      keyManagerAddress: await this.keyManager.getAddress(),
      kycIssuerAddress: await this.kycIssuer.getAddress(),
      amlIssuerAddress: await this.amlIssuer.getAddress(),
      complianceIssuerAddress: await this.complianceIssuer.getAddress(),
      currentGasPrice: this.networkConditions.gasPrice,
      networkCongestion: this.networkConditions.networkCongestion,
    };

    return stats;
  }

  // Cleanup resources
  async cleanup(): Promise<void> {
    console.log("🧹 Cleaning up production environment...");
    // Reset network conditions
    this.networkConditions.gasPrice = ethers.parseUnits("20", "gwei");
    this.networkConditions.networkCongestion = false;
    console.log("   Cleanup complete");
  }
}

// Export utility functions for production testing
export const ProductionUtils = {
  // Generate realistic user data
  generateUserData: (type: "individual" | "corporate" | "institutional") => {
    const baseData = {
      timestamp: new Date().toISOString(),
      verificationId: `VER-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    switch (type) {
      case "individual":
        return {
          ...baseData,
          fullName: "Alice Johnson",
          dateOfBirth: "1990-05-15",
          nationality: "US",
          documentType: "PASSPORT",
          documentNumber: `US${Math.random().toString().substr(2, 9)}`,
          address: "123 Main St, New York, NY 10001, USA",
        };

      case "corporate":
        return {
          ...baseData,
          companyName: "Blockchain Innovations Corp",
          registrationNumber: `REG${Math.random().toString().substr(2, 9)}`,
          jurisdiction: "Delaware, USA",
          businessType: "Technology",
          incorporationDate: "2020-01-15",
        };

      case "institutional":
        return {
          ...baseData,
          institutionName: "Global Investment Fund",
          institutionType: "INVESTMENT_FUND",
          regulatoryLicense: `LIC${Math.random().toString().substr(2, 9)}`,
          aum: "500000000", // $500M AUM
          jurisdiction: "Cayman Islands",
        };
    }
  },

  // Calculate gas costs in USD (assuming ETH price)
  calculateGasCostUSD: (
    gasUsed: bigint,
    gasPriceGwei: number,
    ethPriceUSD: number = 2000,
  ): string => {
    const gasCostEth = Number(gasUsed) * gasPriceGwei * 1e-9;
    const gasCostUSD = gasCostEth * ethPriceUSD;
    return gasCostUSD.toFixed(2);
  },

  // Validate production readiness
  validateProductionReadiness: async (
    env: ProductionEnvironment,
  ): Promise<boolean> => {
    console.log("🔍 Validating production readiness...");

    try {
      // Check all contracts are deployed
      const factoryCode = await ethers.provider.getCode(
        await env.factory.getAddress(),
      );
      const keyManagerCode = await ethers.provider.getCode(
        await env.keyManager.getAddress(),
      );
      const kycIssuerCode = await ethers.provider.getCode(
        await env.kycIssuer.getAddress(),
      );

      if (
        factoryCode === "0x" ||
        keyManagerCode === "0x" ||
        kycIssuerCode === "0x"
      ) {
        console.log("❌ Contract deployment validation failed");
        return false;
      }

      // Check configuration
      const deploymentFee = await env.factory.deploymentFee();
      if (deploymentFee !== env.config.deploymentFee) {
        console.log("❌ Configuration validation failed");
        return false;
      }

      console.log("✅ Production readiness validation passed");
      return true;
    } catch (error) {
      console.log(`❌ Production readiness validation failed: ${error}`);
      return false;
    }
  },
};
