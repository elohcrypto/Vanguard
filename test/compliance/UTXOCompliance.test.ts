import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    UTXOCompliance,
    ComplianceValidator,
    MockOracleManager,
    TransferRestrictions,
    ComplianceAggregator,
    ComplianceRules
} from "../../typechain-types";

describe("UTXO Compliance System", function () {
    let utxoCompliance: UTXOCompliance;
    let complianceValidator: ComplianceValidator;
    let oracleManager: MockOracleManager;
    let transferRestrictions: TransferRestrictions;
    let complianceAggregator: ComplianceAggregator;
    let complianceRules: ComplianceRules;

    let owner: SignerWithAddress;
    let oracle1: SignerWithAddress;
    let oracle2: SignerWithAddress;
    let oracle3: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;

    beforeEach(async function () {
        [owner, oracle1, oracle2, oracle3, user1, user2] = await ethers.getSigners();

        // Deploy MockOracleManager
        const MockOracleManagerFactory = await ethers.getContractFactory("MockOracleManager");
        oracleManager = await MockOracleManagerFactory.deploy();
        await oracleManager.waitForDeployment();

        // Deploy mock registries
        const MockIdentityRegistryFactory = await ethers.getContractFactory("MockIdentityRegistry");
        const mockIdentityRegistry = await MockIdentityRegistryFactory.deploy();
        await mockIdentityRegistry.waitForDeployment();

        const MockComplianceRegistryFactory = await ethers.getContractFactory("MockComplianceRegistry");
        const mockComplianceRegistry = await MockComplianceRegistryFactory.deploy();
        await mockComplianceRegistry.waitForDeployment();

        // Deploy ComplianceValidator
        const ComplianceValidatorFactory = await ethers.getContractFactory("ComplianceValidator");
        complianceValidator = await ComplianceValidatorFactory.deploy(
            await oracleManager.getAddress(),
            await mockIdentityRegistry.getAddress(),
            await mockComplianceRegistry.getAddress(),
            owner.address
        );
        await complianceValidator.waitForDeployment();

        // Deploy ComplianceRules
        const ComplianceRulesFactory = await ethers.getContractFactory("ComplianceRules");
        complianceRules = await ComplianceRulesFactory.deploy(
            owner.address,
            [840, 826, 756], // Allowed countries: USA, UK, Switzerland
            [] // No blocked countries
        );
        await complianceRules.waitForDeployment();

        // Deploy UTXOCompliance
        const UTXOComplianceFactory = await ethers.getContractFactory("UTXOCompliance");
        utxoCompliance = await UTXOComplianceFactory.deploy(
            await complianceValidator.getAddress(),
            await oracleManager.getAddress(),
            await complianceRules.getAddress(),
            owner.address
        );
        await utxoCompliance.waitForDeployment();

        // Deploy TransferRestrictions
        const TransferRestrictionsFactory = await ethers.getContractFactory("TransferRestrictions");
        transferRestrictions = await TransferRestrictionsFactory.deploy(owner.address);
        await transferRestrictions.waitForDeployment();

        // Deploy ComplianceAggregator
        const ComplianceAggregatorFactory = await ethers.getContractFactory("ComplianceAggregator");
        complianceAggregator = await ComplianceAggregatorFactory.deploy(
            await complianceValidator.getAddress(),
            owner.address
        );
        await complianceAggregator.waitForDeployment();

        // Register oracles
        await oracleManager.registerOracle(oracle1.address, "Oracle 1");
        await oracleManager.registerOracle(oracle2.address, "Oracle 2");
        await oracleManager.registerOracle(oracle3.address, "Oracle 3");
    });

    describe("Contract Deployment", function () {
        it("Should deploy all contracts successfully", async function () {
            expect(await utxoCompliance.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await complianceValidator.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await oracleManager.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await transferRestrictions.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await complianceAggregator.getAddress()).to.not.equal(ethers.ZeroAddress);
        });

        it("Should have correct initial configuration", async function () {
            expect(await utxoCompliance.complianceValidator()).to.equal(await complianceValidator.getAddress());
            expect(await utxoCompliance.oracleManager()).to.equal(await oracleManager.getAddress());
            expect(await oracleManager.getOracleCount()).to.equal(3);
        });
    });

    describe("UTXO Creation", function () {
        it("Should create UTXO with compliance metadata", async function () {
            const metadata = {
                value: ethers.parseEther("1"),
                scriptPubkey: ethers.keccak256(ethers.toUtf8Bytes("test_script")),
                tokenAddress: ethers.ZeroAddress,
                onchainId: ethers.ZeroAddress,
                identityRegistry: ethers.ZeroAddress,
                complianceRegistry: ethers.ZeroAddress,
                trustedIssuersRegistry: ethers.ZeroAddress,
                claimTopicsRegistry: ethers.ZeroAddress,
                complianceHash: ethers.keccak256(ethers.toUtf8Bytes("compliance_data")),
                whitelistTier: 1,
                jurisdictionMask: 1,
                expiryBlock: 0,
                requiredClaims: 0,
                countryCode: 840,
                investorType: 1,
                isWhitelisted: true,
                isBlacklisted: false,
                blacklistSeverity: 0,
                lastValidated: 0
            };

            const tx = await utxoCompliance.createUTXO(
                user1.address,
                ethers.parseEther("1"),
                metadata.scriptPubkey,
                metadata
            );

            const receipt = await tx.wait();
            expect(receipt?.status).to.equal(1);

            // Check event emission
            const events = receipt?.logs.filter(log => {
                try {
                    const parsed = utxoCompliance.interface.parseLog(log);
                    return parsed?.name === 'UTXOCreated';
                } catch {
                    return false;
                }
            });

            expect(events?.length).to.be.greaterThan(0);
        });
    });

    describe("Whitelist Management", function () {
        it("Should update whitelist status with oracle consensus", async function () {
            // Create oracle signatures (without timestamp as per contract implementation)
            const message = ethers.solidityPackedKeccak256(
                ['address', 'bool', 'uint8'],
                [user1.address, true, 2]
            );

            const signatures = [];
            for (const oracle of [oracle1, oracle2, oracle3]) {
                const signature = await oracle.signMessage(ethers.getBytes(message));
                signatures.push(signature);
            }

            const tx = await utxoCompliance.updateWhitelistStatus(
                user1.address,
                true,
                2,
                signatures
            );

            const receipt = await tx.wait();
            expect(receipt?.status).to.equal(1);

            // Check whitelist status
            const status = await utxoCompliance.getWhitelistStatus(user1.address);
            expect(status.isWhitelisted).to.be.true;
            expect(status.tier).to.equal(2);
        });
    });

    describe("Compliance Validation", function () {
        let utxoId: string;

        beforeEach(async function () {
            const metadata = {
                value: ethers.parseEther("1"),
                scriptPubkey: ethers.keccak256(ethers.toUtf8Bytes("test_script")),
                tokenAddress: ethers.ZeroAddress,
                onchainId: ethers.ZeroAddress,
                identityRegistry: ethers.ZeroAddress,
                complianceRegistry: ethers.ZeroAddress,
                trustedIssuersRegistry: ethers.ZeroAddress,
                claimTopicsRegistry: ethers.ZeroAddress,
                complianceHash: ethers.keccak256(ethers.toUtf8Bytes("compliance_data")),
                whitelistTier: 1,
                jurisdictionMask: 1,
                expiryBlock: 0,
                requiredClaims: 0,
                countryCode: 840,
                investorType: 1,
                isWhitelisted: true,
                isBlacklisted: false,
                blacklistSeverity: 0,
                lastValidated: 0
            };

            const tx = await utxoCompliance.createUTXO(
                user1.address,
                ethers.parseEther("1"),
                metadata.scriptPubkey,
                metadata
            );

            const receipt = await tx.wait();
            const event = receipt?.logs.find(log => {
                try {
                    const parsed = utxoCompliance.interface.parseLog(log);
                    return parsed?.name === 'UTXOCreated';
                } catch {
                    return false;
                }
            });

            if (event) {
                const parsed = utxoCompliance.interface.parseLog(event);
                utxoId = parsed?.args.utxoId;
            }
        });

        it("Should validate UTXO compliance", async function () {
            const validation = await utxoCompliance.validateUTXO(utxoId);
            expect(validation.isValid).to.be.true;
            expect(validation.reason).to.equal("Compliance validation passed");
        });

        it("Should check UTXO validity", async function () {
            const isValid = await utxoCompliance.isUTXOValid(utxoId);
            expect(isValid).to.be.true;
        });
    });

    describe("Transfer Restrictions", function () {
        it("Should set transfer restriction rules", async function () {
            const tokenAddress = ethers.ZeroAddress;
            const holdingPeriod = 86400; // 1 day
            const maxAmount = ethers.parseEther("1000");
            const dailyLimit = ethers.parseEther("100");
            const monthlyLimit = ethers.parseEther("1000");

            const tx = await transferRestrictions.setRestrictionRule(
                tokenAddress,
                holdingPeriod,
                maxAmount,
                dailyLimit,
                monthlyLimit,
                [840, 826], // US, UK
                [1, 2], // Retail, Accredited
                false // No approval required
            );

            const receipt = await tx.wait();
            expect(receipt?.status).to.equal(1);

            const rule = await transferRestrictions.getRestrictionRule(tokenAddress);
            expect(rule.isActive).to.be.true;
            expect(rule.holdingPeriod).to.equal(holdingPeriod);
            expect(rule.maxTransferAmount).to.equal(maxAmount);
        });
    });
});