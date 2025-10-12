import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OnchainID, OnchainIDFactory, ClaimIssuer, KeyManager } from "../../typechain-types";

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
        minConfirmations: 1 // Use 1 for local testing to avoid hanging
    };

    // Network simulation parameters
    public networkConditions = {
        gasPrice: ethers.parseUnits("20", "gwei"),
        blockTime: 12, // seconds
        networkCongestion: false,
        mempoolSize: 0
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

        // Deploy with realistic gas settings
        // Note: Block gas limit is 12M, so we use 10M to stay under the limit
        const deployOptions = {
            gasPrice: this.networkConditions.gasPrice,
            gasLimit: 10000000
        };

        // 1. Deploy OnchainIDFactory
        const FactoryFactory = await ethers.getContractFactory("OnchainIDFactory");
        this.factory = await FactoryFactory.deploy(this.admin.address, deployOptions);
        await this.factory.waitForDeployment();
        console.log(`   Factory: ${await this.factory.getAddress()}`);

        // 2. Deploy KeyManager
        const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
        this.keyManager = await KeyManagerFactory.deploy(this.admin.address, deployOptions);
        await this.keyManager.waitForDeployment();
        console.log(`   KeyManager: ${await this.keyManager.getAddress()}`);

        // 3. Deploy KYC Issuer
        const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
        this.kycIssuer = await ClaimIssuerFactory.deploy(
            this.kycProvider.address,
            "Global KYC Solutions Ltd",
            "Enterprise-grade KYC verification for financial institutions worldwide",
            deployOptions
        );
        await this.kycIssuer.waitForDeployment();
        console.log(`   KYC Issuer: ${await this.kycIssuer.getAddress()}`);

        // 4. Deploy AML Issuer
        this.amlIssuer = await ClaimIssuerFactory.deploy(
            this.amlProvider.address,
            "AML Compliance International",
            "Anti-Money Laundering screening and compliance verification service",
            deployOptions
        );
        await this.amlIssuer.waitForDeployment();
        console.log(`   AML Issuer: ${await this.amlIssuer.getAddress()}`);

        // 5. Deploy Compliance Issuer
        this.complianceIssuer = await ClaimIssuerFactory.deploy(
            this.complianceOfficer.address,
            "Regulatory Compliance Corp",
            "Regulatory compliance verification and investor accreditation service",
            deployOptions
        );
        await this.complianceIssuer.waitForDeployment();
        console.log(`   Compliance Issuer: ${await this.complianceIssuer.getAddress()}`);
    }

    private async configureSystem(): Promise<void> {
        console.log("⚙️  Configuring production system...");

        // Configure factory
        await this.factory.connect(this.admin).setDeploymentFee(this.config.deploymentFee);
        await this.factory.connect(this.admin).setFeeRecipient(this.feeRecipient.address);

        // Configure key manager (KeyManager uses constants for timelocks)
        // DEFAULT_TIMELOCK = 24 hours and RECOVERY_TIMELOCK = 48 hours are built-in constants
        // We can set custom timelocks for specific identities if needed using setCustomTimelock

        console.log("   System configuration complete");
    }

    private async setupTrustedIssuers(): Promise<void> {
        console.log("🏛️  Setting up trusted issuers...");

        // Add issuer keys for each service (only if they don't already exist)
        // Note: The constructor automatically adds the owner as a management key

        // For KYC issuer, add the KYC provider as a claim signer (different from owner)
        const kycSignerKey = ethers.keccak256(ethers.solidityPacked(["address"], [this.kycProvider.address]));
        try {
            await this.kycIssuer.connect(this.kycProvider).addIssuerKey(kycSignerKey, 3, 1); // CLAIM_SIGNER_KEY
        } catch (error: any) {
            if (!error.message.includes("Key already exists")) {
                throw error;
            }
        }

        // For AML issuer, add the AML provider as a claim signer
        const amlSignerKey = ethers.keccak256(ethers.solidityPacked(["address"], [this.amlProvider.address]));
        try {
            await this.amlIssuer.connect(this.amlProvider).addIssuerKey(amlSignerKey, 3, 1);
        } catch (error: any) {
            if (!error.message.includes("Key already exists")) {
                throw error;
            }
        }

        // For compliance issuer, add the compliance officer as a claim signer
        const complianceSignerKey = ethers.keccak256(ethers.solidityPacked(["address"], [this.complianceOfficer.address]));
        try {
            await this.complianceIssuer.connect(this.complianceOfficer).addIssuerKey(complianceSignerKey, 3, 1);
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
        identityType: "individual" | "corporate" | "institutional"
    ): Promise<{ identity: OnchainID; address: string }> {
        console.log(`🆔 Creating ${identityType} identity for ${owner.address}...`);

        // Generate unique salt
        const salt = ethers.keccak256(
            ethers.solidityPacked(
                ["string", "address", "uint256"],
                [identityType, owner.address, Date.now()]
            )
        );

        // Deploy identity with production fee
        const tx = await this.factory.connect(owner).deployOnchainID(owner.address, salt, {
            value: this.config.deploymentFee,
            gasPrice: this.networkConditions.gasPrice
        });
        // For local testing, just wait for 1 confirmation to avoid hanging
        const confirmations = this.config.minConfirmations > 1 ? 1 : this.config.minConfirmations;
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
            pepScreening: "CLEAR"
        };

        const claimData = ethers.solidityPacked(["string"], [JSON.stringify(kycData)]);

        await this.kycIssuer.connect(this.kycProvider).issueClaim(
            identityAddress,
            this.config.kycTopic,
            this.config.ecdsaScheme,
            claimData,
            `https://kyc-provider.com/verification/${identityAddress}`,
            Math.floor(Date.now() / 1000) + this.config.claimValidityPeriod,
            { gasPrice: this.networkConditions.gasPrice }
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
            confidence: "HIGH"
        };

        const claimData = ethers.solidityPacked(["string"], [JSON.stringify(amlData)]);

        await this.amlIssuer.connect(this.amlProvider).issueClaim(
            identityAddress,
            this.config.amlTopic,
            this.config.ecdsaScheme,
            claimData,
            `https://aml-provider.com/screening/${identityAddress}`,
            Math.floor(Date.now() / 1000) + this.config.claimValidityPeriod,
            { gasPrice: this.networkConditions.gasPrice }
        );

        console.log("   AML claim issued successfully");
    }

    // Setup comprehensive recovery system
    async setupRecoverySystem(identityAddress: string, owner: SignerWithAddress): Promise<void> {
        console.log("🛡️  Setting up production recovery system...");

        const identity = await ethers.getContractAt("OnchainID", identityAddress);

        // Authorize key manager
        await identity.connect(owner).authorizeManager(await this.keyManager.getAddress());
        await this.keyManager.connect(this.admin).addAuthorizedManager(owner.address);

        // Setup 2-of-3 recovery
        await this.keyManager.connect(owner).setupKeyRecovery(
            identityAddress,
            this.recoveryAgents.map(agent => agent.address),
            2 // 2-of-3 threshold
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
            totalFeesCollected: await ethers.provider.getBalance(this.feeRecipient.address),
            factoryAddress: await this.factory.getAddress(),
            keyManagerAddress: await this.keyManager.getAddress(),
            kycIssuerAddress: await this.kycIssuer.getAddress(),
            amlIssuerAddress: await this.amlIssuer.getAddress(),
            complianceIssuerAddress: await this.complianceIssuer.getAddress(),
            currentGasPrice: this.networkConditions.gasPrice,
            networkCongestion: this.networkConditions.networkCongestion
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
            verificationId: `VER-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
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
                    address: "123 Main St, New York, NY 10001, USA"
                };

            case "corporate":
                return {
                    ...baseData,
                    companyName: "Blockchain Innovations Corp",
                    registrationNumber: `REG${Math.random().toString().substr(2, 9)}`,
                    jurisdiction: "Delaware, USA",
                    businessType: "Technology",
                    incorporationDate: "2020-01-15"
                };

            case "institutional":
                return {
                    ...baseData,
                    institutionName: "Global Investment Fund",
                    institutionType: "INVESTMENT_FUND",
                    regulatoryLicense: `LIC${Math.random().toString().substr(2, 9)}`,
                    aum: "500000000", // $500M AUM
                    jurisdiction: "Cayman Islands"
                };
        }
    },

    // Calculate gas costs in USD (assuming ETH price)
    calculateGasCostUSD: (gasUsed: bigint, gasPriceGwei: number, ethPriceUSD: number = 2000): string => {
        const gasCostEth = Number(gasUsed) * gasPriceGwei * 1e-9;
        const gasCostUSD = gasCostEth * ethPriceUSD;
        return gasCostUSD.toFixed(2);
    },

    // Validate production readiness
    validateProductionReadiness: async (env: ProductionEnvironment): Promise<boolean> => {
        console.log("🔍 Validating production readiness...");

        try {
            // Check all contracts are deployed
            const factoryCode = await ethers.provider.getCode(await env.factory.getAddress());
            const keyManagerCode = await ethers.provider.getCode(await env.keyManager.getAddress());
            const kycIssuerCode = await ethers.provider.getCode(await env.kycIssuer.getAddress());

            if (factoryCode === "0x" || keyManagerCode === "0x" || kycIssuerCode === "0x") {
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
    }
};