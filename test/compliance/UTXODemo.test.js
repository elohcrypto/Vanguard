const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("UTXO Compliance Demo", function () {
    let mockOracleManager;
    let complianceValidator;
    let utxoCompliance;
    let transferRestrictions;
    let complianceAggregator;

    let owner, oracle1, oracle2, oracle3, user1, user2;

    before(async function () {
        [owner, oracle1, oracle2, oracle3, user1, user2] = await ethers.getSigners();

        console.log('\n🚀 UTXO Compliance System Demo');
        console.log('='.repeat(60));
        console.log(`📝 Deploying contracts...`);

        // Deploy MockOracleManager
        const MockOracleManagerFactory = await ethers.getContractFactory("MockOracleManager");
        mockOracleManager = await MockOracleManagerFactory.deploy();
        await mockOracleManager.waitForDeployment();
        console.log(`✅ MockOracleManager: ${await mockOracleManager.getAddress()}`);

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
            await mockOracleManager.getAddress(),
            await mockIdentityRegistry.getAddress(),
            await mockComplianceRegistry.getAddress(),
            owner.address
        );
        await complianceValidator.waitForDeployment();
        console.log(`✅ ComplianceValidator: ${await complianceValidator.getAddress()}`);

        // Deploy ComplianceRules first
        const ComplianceRulesFactory = await ethers.getContractFactory("ComplianceRules");
        const complianceRules = await ComplianceRulesFactory.deploy(
            owner.address,
            [840, 826, 756], // Allowed countries: USA, UK, Switzerland
            [] // No blocked countries
        );
        await complianceRules.waitForDeployment();
        console.log(`✅ ComplianceRules: ${await complianceRules.getAddress()}`);

        // Deploy UTXOCompliance
        const UTXOComplianceFactory = await ethers.getContractFactory("UTXOCompliance");
        utxoCompliance = await UTXOComplianceFactory.deploy(
            await complianceValidator.getAddress(),
            await mockOracleManager.getAddress(),
            await complianceRules.getAddress(),
            owner.address
        );
        await utxoCompliance.waitForDeployment();
        console.log(`✅ UTXOCompliance: ${await utxoCompliance.getAddress()}`);

        // Deploy TransferRestrictions (now fixed!)
        const TransferRestrictionsFactory = await ethers.getContractFactory("TransferRestrictions");
        transferRestrictions = await TransferRestrictionsFactory.deploy(owner.address);
        await transferRestrictions.waitForDeployment();
        console.log(`✅ TransferRestrictions: ${await transferRestrictions.getAddress()}`);

        // Deploy ComplianceAggregator
        const ComplianceAggregatorFactory = await ethers.getContractFactory("ComplianceAggregator");
        complianceAggregator = await ComplianceAggregatorFactory.deploy(
            await complianceValidator.getAddress(),
            owner.address
        );
        await complianceAggregator.waitForDeployment();
        console.log(`✅ ComplianceAggregator: ${await complianceAggregator.getAddress()}`);

        // Register oracles
        console.log('\n🔗 Setting up oracles...');
        await mockOracleManager.registerOracle(oracle1.address, "Oracle 1");
        await mockOracleManager.registerOracle(oracle2.address, "Oracle 2");
        await mockOracleManager.registerOracle(oracle3.address, "Oracle 3");
        console.log('✅ Registered 3 oracles');
    });

    it("Should deploy all contracts successfully", async function () {
        expect(await mockOracleManager.getAddress()).to.not.equal(ethers.ZeroAddress);
        expect(await complianceValidator.getAddress()).to.not.equal(ethers.ZeroAddress);
        expect(await utxoCompliance.getAddress()).to.not.equal(ethers.ZeroAddress);
        expect(await transferRestrictions.getAddress()).to.not.equal(ethers.ZeroAddress);
        expect(await complianceAggregator.getAddress()).to.not.equal(ethers.ZeroAddress);

        console.log('\n✅ All contracts deployed successfully!');
    });

    it("Demo 1: Create UTXO with compliance metadata", async function () {
        console.log('\n📦 Demo 1: Creating UTXO...');

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
            whitelistTier: 2,
            jurisdictionMask: 1,
            expiryBlock: 0,
            requiredClaims: 0,
            countryCode: 840, // US
            investorType: 2, // Accredited
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
        expect(receipt.status).to.equal(1);

        console.log(`✅ UTXO created successfully!`);
        console.log(`   Transaction Hash: ${receipt.hash}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

        // Extract UTXO ID from events
        let utxoId;
        for (const log of receipt.logs) {
            try {
                const parsed = utxoCompliance.interface.parseLog(log);
                if (parsed.name === 'UTXOCreated') {
                    utxoId = parsed.args.utxoId;
                    console.log(`   UTXO ID: ${utxoId}`);
                    break;
                }
            } catch (e) {
                // Skip non-matching logs
            }
        }

        expect(utxoId).to.not.be.undefined;
        this.utxoId = utxoId; // Store for next test
    });

    it("Demo 2: Validate UTXO compliance", async function () {
        console.log('\n✅ Demo 2: Validating UTXO...');

        const validation = await utxoCompliance.validateUTXO(this.utxoId);

        console.log(`   Valid: ${validation.isValid}`);
        console.log(`   Reason: ${validation.reason}`);
        console.log(`   Valid Until Block: ${validation.validUntil.toString()}`);

        expect(validation.isValid).to.be.true;
        expect(validation.reason).to.equal("Compliance validation passed");
    });

    it("Demo 3: Update whitelist status with oracle consensus", async function () {
        console.log('\n⚪ Demo 3: Updating whitelist status...');

        const message = ethers.solidityPackedKeccak256(
            ['address', 'bool', 'uint8'],
            [user2.address, true, 3]
        );

        const signatures = [];
        for (const oracle of [oracle1, oracle2, oracle3]) {
            const signature = await oracle.signMessage(ethers.getBytes(message));
            signatures.push(signature);
        }

        const tx = await utxoCompliance.updateWhitelistStatus(
            user2.address,
            true,
            3,
            signatures
        );

        const receipt = await tx.wait();
        expect(receipt.status).to.equal(1);

        console.log(`✅ Whitelist status updated!`);
        console.log(`   Transaction Hash: ${receipt.hash}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

        // Check whitelist status
        const whitelistStatus = await utxoCompliance.getWhitelistStatus(user2.address);
        console.log(`   User2 Whitelisted: ${whitelistStatus.isWhitelisted}`);
        console.log(`   User2 Tier: ${whitelistStatus.tier}`);

        expect(whitelistStatus.isWhitelisted).to.be.true;
        expect(whitelistStatus.tier).to.equal(3);
    });

    it("Demo 4: Aggregate compliance from multiple UTXOs", async function () {
        console.log('\n🔗 Demo 4: Aggregating compliance...');

        const metadata1 = {
            value: ethers.parseEther("1"),
            scriptPubkey: ethers.keccak256(ethers.toUtf8Bytes("script1")),
            tokenAddress: ethers.ZeroAddress,
            onchainId: ethers.ZeroAddress,
            identityRegistry: ethers.ZeroAddress,
            complianceRegistry: ethers.ZeroAddress,
            trustedIssuersRegistry: ethers.ZeroAddress,
            claimTopicsRegistry: ethers.ZeroAddress,
            complianceHash: ethers.keccak256(ethers.toUtf8Bytes("compliance1")),
            whitelistTier: 2,
            jurisdictionMask: 1,
            expiryBlock: 0,
            requiredClaims: 0,
            countryCode: 840,
            investorType: 2,
            isWhitelisted: true,
            isBlacklisted: false,
            blacklistSeverity: 0,
            lastValidated: 0
        };

        const metadata2 = {
            ...metadata1,
            whitelistTier: 1,
            scriptPubkey: ethers.keccak256(ethers.toUtf8Bytes("script2")),
            complianceHash: ethers.keccak256(ethers.toUtf8Bytes("compliance2"))
        };

        const aggregated = await utxoCompliance.aggregateCompliance([metadata1, metadata2]);

        console.log(`   Aggregated Whitelist Tier: ${aggregated.whitelistTier}`);
        console.log(`   Aggregated Is Whitelisted: ${aggregated.isWhitelisted}`);
        console.log(`   Aggregated Is Blacklisted: ${aggregated.isBlacklisted}`);

        expect(aggregated.whitelistTier).to.equal(1); // Minimum tier
        expect(aggregated.isWhitelisted).to.be.true;
        expect(aggregated.isBlacklisted).to.be.false;
    });

    it("Demo 5: Set transfer restrictions", async function () {
        console.log('\n🚫 Demo 5: Setting transfer restrictions...');

        const tx = await transferRestrictions.setRestrictionRule(
            ethers.ZeroAddress, // token address
            86400, // 1 day holding period
            ethers.parseEther("1000"), // max transfer amount
            ethers.parseEther("100"), // daily limit
            ethers.parseEther("1000"), // monthly limit
            [840, 826], // US, UK
            [1, 2], // Retail, Accredited
            false // No approval required
        );

        const receipt = await tx.wait();
        expect(receipt.status).to.equal(1);

        console.log(`✅ Transfer restrictions set!`);
        console.log(`   Transaction Hash: ${receipt.hash}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

        const rule = await transferRestrictions.getRestrictionRule(ethers.ZeroAddress);
        console.log(`   Holding Period: ${rule.holdingPeriod} seconds`);
        console.log(`   Max Transfer Amount: ${ethers.formatEther(rule.maxTransferAmount)} ETH`);

        expect(rule.isActive).to.be.true;
        expect(rule.holdingPeriod).to.equal(86400);
    });

    after(async function () {
        console.log('\n🎉 Demo completed successfully!');
        console.log('\n📋 Summary:');
        console.log('   ✅ Deployed UTXO compliance contracts');
        console.log('   ✅ Created UTXO with compliance metadata');
        console.log('   ✅ Validated UTXO compliance');
        console.log('   ✅ Updated whitelist status with oracle consensus');
        console.log('   ✅ Aggregated compliance from multiple UTXOs');
        console.log('   ✅ Set transfer restrictions');
        console.log('\n🔧 Contracts deployed:');
        console.log(`   • MockOracleManager: ${await mockOracleManager.getAddress()}`);
        console.log(`   • ComplianceValidator: ${await complianceValidator.getAddress()}`);
        console.log(`   • UTXOCompliance: ${await utxoCompliance.getAddress()}`);
        if (transferRestrictions) {
            console.log(`   • TransferRestrictions: ${await transferRestrictions.getAddress()}`);
        }
        console.log(`   • ComplianceAggregator: ${await complianceAggregator.getAddress()}`);
    });
});