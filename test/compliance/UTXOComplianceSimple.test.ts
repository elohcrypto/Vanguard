import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("UTXO Compliance System - Simple Test", function () {
    let mockOracleManager: any;
    let complianceValidator: any;
    let utxoCompliance: any;

    let owner: SignerWithAddress;
    let user1: SignerWithAddress;

    beforeEach(async function () {
        [owner, user1] = await ethers.getSigners();

        // Deploy MockOracleManager
        const MockOracleManagerFactory = await ethers.getContractFactory("MockOracleManager");
        mockOracleManager = await MockOracleManagerFactory.deploy();
        await mockOracleManager.waitForDeployment();

        // Deploy mock registries
        const MockIdentityRegistryFactory = await ethers.getContractFactory("MockIdentityRegistry");
        const mockIdentityRegistry = await MockIdentityRegistryFactory.deploy();
        await mockIdentityRegistry.waitForDeployment();

        const MockComplianceRegistryFactory = await ethers.getContractFactory("MockComplianceRegistry");
        const mockComplianceRegistry = await MockComplianceRegistryFactory.deploy();
        await mockComplianceRegistry.waitForDeployment();

        // Deploy ComplianceValidator with mock registries
        const ComplianceValidatorFactory = await ethers.getContractFactory("ComplianceValidator");
        complianceValidator = await ComplianceValidatorFactory.deploy(
            await mockOracleManager.getAddress(),
            await mockIdentityRegistry.getAddress(),
            await mockComplianceRegistry.getAddress(),
            owner.address
        );
        await complianceValidator.waitForDeployment();

        // Deploy ComplianceRules
        const ComplianceRulesFactory = await ethers.getContractFactory("ComplianceRules");
        const complianceRules = await ComplianceRulesFactory.deploy(
            owner.address,
            [840, 826, 756], // Allowed countries: USA, UK, Switzerland
            [] // No blocked countries
        );
        await complianceRules.waitForDeployment();

        // Deploy UTXOCompliance
        const UTXOComplianceFactory = await ethers.getContractFactory("UTXOCompliance");
        utxoCompliance = await UTXOComplianceFactory.deploy(
            await complianceValidator.getAddress(),
            await mockOracleManager.getAddress(),
            await complianceRules.getAddress(),
            owner.address
        );
        await utxoCompliance.waitForDeployment();
    });

    it("Should deploy contracts successfully", async function () {
        expect(await utxoCompliance.getAddress()).to.not.equal(ethers.ZeroAddress);
        expect(await complianceValidator.getAddress()).to.not.equal(ethers.ZeroAddress);
        expect(await mockOracleManager.getAddress()).to.not.equal(ethers.ZeroAddress);
    });

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

        console.log("✅ UTXO created successfully!");
        console.log(`   Transaction Hash: ${receipt?.hash}`);
        console.log(`   Gas Used: ${receipt?.gasUsed.toString()}`);
    });
});