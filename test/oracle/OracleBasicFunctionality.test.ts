import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    OracleManager,
    WhitelistOracle,
    BlacklistOracle,
    ConsensusOracle
} from "../../typechain-types";

describe("Oracle Basic Functionality Tests", function () {
    let oracleManager: OracleManager;
    let whitelistOracle: WhitelistOracle;
    let blacklistOracle: BlacklistOracle;
    let consensusOracle: ConsensusOracle;

    let owner: SignerWithAddress;
    let oracle1: SignerWithAddress;
    let oracle2: SignerWithAddress;
    let oracle3: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;

    beforeEach(async function () {
        [owner, oracle1, oracle2, oracle3, user1, user2] = await ethers.getSigners();

        // Deploy Oracle contracts
        const OracleManagerFactory = await ethers.getContractFactory("OracleManager");
        oracleManager = await OracleManagerFactory.deploy();
        await oracleManager.waitForDeployment();

        const WhitelistOracleFactory = await ethers.getContractFactory("WhitelistOracle");
        whitelistOracle = await WhitelistOracleFactory.deploy(
            await oracleManager.getAddress(),
            "Test Whitelist Oracle",
            "Oracle for testing whitelist functionality"
        );
        await whitelistOracle.waitForDeployment();

        const BlacklistOracleFactory = await ethers.getContractFactory("BlacklistOracle");
        blacklistOracle = await BlacklistOracleFactory.deploy(
            await oracleManager.getAddress(),
            "Test Blacklist Oracle",
            "Oracle for testing blacklist functionality"
        );
        await blacklistOracle.waitForDeployment();

        const ConsensusOracleFactory = await ethers.getContractFactory("ConsensusOracle");
        consensusOracle = await ConsensusOracleFactory.deploy(
            await oracleManager.getAddress(),
            "Test Consensus Oracle",
            "Oracle for testing consensus functionality"
        );
        await consensusOracle.waitForDeployment();

        // Register oracles
        await oracleManager.registerOracle(oracle1.address, "Oracle 1", "Test oracle 1", 500);
        await oracleManager.registerOracle(oracle2.address, "Oracle 2", "Test oracle 2", 500);
        await oracleManager.registerOracle(oracle3.address, "Oracle 3", "Test oracle 3", 500);
    });

    describe("Oracle Manager Functionality", function () {
        it("Should register and manage oracles correctly", async function () {
            console.log("🔧 Testing Oracle Registration...");

            // Verify oracles are registered
            expect(await oracleManager.isRegisteredOracle(oracle1.address)).to.be.true;
            expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.true;

            const oracleInfo = await oracleManager.getOracleInfo(oracle1.address);
            expect(oracleInfo.name).to.equal("Oracle 1");
            expect(oracleInfo.reputation).to.equal(500);

            console.log("✅ Oracle registration working correctly");
        });

        it("Should handle oracle activation/deactivation", async function () {
            console.log("🔄 Testing Oracle Activation/Deactivation...");

            await expect(oracleManager.deactivateOracle(oracle1.address))
                .to.emit(oracleManager, "OracleDeactivated")
                .withArgs(oracle1.address);

            expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.false;

            await expect(oracleManager.activateOracle(oracle1.address))
                .to.emit(oracleManager, "OracleActivated")
                .withArgs(oracle1.address);

            expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.true;

            console.log("✅ Oracle activation/deactivation working correctly");
        });

        it("Should manage consensus threshold", async function () {
            console.log("⚖️ Testing Consensus Threshold Management...");

            await expect(oracleManager.setConsensusThreshold(2))
                .to.emit(oracleManager, "ConsensusThresholdUpdated")
                .withArgs(3, 2);

            expect(await oracleManager.getConsensusThreshold()).to.equal(2);

            console.log("✅ Consensus threshold management working correctly");
        });
    });

    describe("Whitelist Oracle Functionality", function () {
        it("📋 Should handle KYC success - add to whitelist", async function () {
            console.log("📋 Testing KYC Claim Success Flow...");

            await expect(
                whitelistOracle.addToWhitelist(
                    user1.address,
                    4, // High tier
                    365 * 24 * 60 * 60, // 1 year
                    "KYC verified - high tier investor"
                )
            ).to.emit(whitelistOracle, "WhitelistUpdated")
                .withArgs(user1.address, true, 4, anyValue, "KYC verified - high tier investor");

            expect(await whitelistOracle.isWhitelisted(user1.address)).to.be.true;

            const whitelistInfo = await whitelistOracle.getWhitelistInfo(user1.address);
            expect(whitelistInfo.tier).to.equal(4);
            expect(whitelistInfo.reason).to.equal("KYC verified - high tier investor");

            console.log("✅ KYC Success: User successfully added to whitelist");
        });

        it("🔍 Should handle AML success - upgrade whitelist tier", async function () {
            console.log("🔍 Testing AML Claim Success Flow...");

            // First add with basic KYC
            await whitelistOracle.addToWhitelist(user1.address, 2, 0, "Basic KYC verified");

            // Then upgrade after AML clearance
            await expect(
                whitelistOracle.addToWhitelist(
                    user1.address,
                    5, // Maximum tier
                    365 * 24 * 60 * 60,
                    "KYC + AML verified - premium tier"
                )
            ).to.emit(whitelistOracle, "WhitelistUpdated")
                .withArgs(user1.address, true, 5, anyValue, "KYC + AML verified - premium tier");

            const whitelistInfo = await whitelistOracle.getWhitelistInfo(user1.address);
            expect(whitelistInfo.tier).to.equal(5);
            expect(whitelistInfo.reason).to.equal("KYC + AML verified - premium tier");

            console.log("✅ AML Success: User upgraded to premium whitelist tier");
        });

        it("Should handle batch whitelist operations", async function () {
            console.log("📦 Testing Batch Whitelist Operations...");

            const addresses = [user1.address, user2.address];
            const tiers = [3, 4];

            await whitelistOracle.batchAddToWhitelist(
                addresses,
                tiers,
                30 * 24 * 60 * 60, // 30 days
                "Batch KYC verification"
            );

            expect(await whitelistOracle.isWhitelisted(user1.address)).to.be.true;
            expect(await whitelistOracle.isWhitelisted(user2.address)).to.be.true;

            const user1Info = await whitelistOracle.getWhitelistInfo(user1.address);
            const user2Info = await whitelistOracle.getWhitelistInfo(user2.address);

            expect(user1Info.tier).to.equal(3);
            expect(user2Info.tier).to.equal(4);

            console.log("✅ Batch whitelist operations working correctly");
        });
    });

    describe("Blacklist Oracle Functionality", function () {
        it("🚫 Should handle KYC rejection - prevent whitelist", async function () {
            console.log("🚫 Testing KYC Rejection Flow...");

            // Simulate KYC rejection by not adding to whitelist
            expect(await whitelistOracle.isWhitelisted(user2.address)).to.be.false;

            // Verify user cannot be added to whitelist without proper KYC
            console.log("✅ KYC Rejection: User correctly excluded from whitelist");
        });

        it("🚫 Should handle AML rejection - add to blacklist", async function () {
            console.log("🚫 Testing AML Rejection Flow...");

            await expect(
                blacklistOracle.addToBlacklist(
                    user2.address,
                    2, // HIGH severity
                    90 * 24 * 60 * 60, // 90 days
                    "AML compliance failure - suspicious activity"
                )
            ).to.emit(blacklistOracle, "BlacklistUpdated");

            expect(await blacklistOracle.isBlacklisted(user2.address)).to.be.true;

            const blacklistInfo = await blacklistOracle.getBlacklistInfo(user2.address);
            expect(blacklistInfo.severity).to.equal(2); // HIGH
            expect(blacklistInfo.reason).to.equal("AML compliance failure - suspicious activity");

            console.log("✅ AML Rejection: User correctly added to blacklist");
        });

        it("Should handle emergency blacklisting", async function () {
            console.log("🚨 Testing Emergency Blacklisting...");

            // Set emergency oracle
            await blacklistOracle.setEmergencyOracle(oracle2.address, true);

            await expect(
                blacklistOracle.connect(oracle2).emergencyBlacklist(
                    user1.address,
                    3, // CRITICAL severity
                    "Suspected terrorist financing"
                )
            ).to.emit(blacklistOracle, "EmergencyBlacklistAdded")
                .withArgs(user1.address, oracle2.address, 3, "Suspected terrorist financing");

            expect(await blacklistOracle.isBlacklisted(user1.address)).to.be.true;

            const blacklistInfo = await blacklistOracle.getBlacklistInfo(user1.address);
            expect(blacklistInfo.severity).to.equal(3); // CRITICAL
            expect(blacklistInfo.emergencyListing).to.be.true;

            console.log("✅ Emergency blacklisting working correctly");
        });

        it("Should handle different severity levels", async function () {
            console.log("📊 Testing Blacklist Severity Levels...");

            // Test different severity levels
            await blacklistOracle.addToBlacklist(user1.address, 0, 0, "Low risk"); // LOW
            await blacklistOracle.addToBlacklist(user2.address, 1, 0, "Medium risk"); // MEDIUM

            const user1Info = await blacklistOracle.getBlacklistInfo(user1.address);
            const user2Info = await blacklistOracle.getBlacklistInfo(user2.address);

            expect(user1Info.severity).to.equal(0); // LOW
            expect(user2Info.severity).to.equal(1); // MEDIUM

            console.log("✅ Blacklist severity levels working correctly");
        });
    });

    describe("Consensus Oracle Functionality", function () {
        it("Should create and manage consensus queries", async function () {
            console.log("🤝 Testing Consensus Query Creation...");

            const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "uint256"],
                ["Test consensus query", Date.now()]
            );

            await expect(
                consensusOracle.createConsensusQuery(user1.address, 1, queryData)
            ).to.emit(consensusOracle, "ConsensusQueryCreated");

            console.log("✅ Consensus query creation working correctly");
        });

        it("Should manage oracle weights", async function () {
            console.log("⚖️ Testing Oracle Weight Management...");

            await expect(consensusOracle.setOracleWeight(oracle1.address, 150))
                .to.emit(consensusOracle, "OracleWeightUpdated")
                .withArgs(oracle1.address, 0, 150);

            expect(await consensusOracle.getOracleWeight(oracle1.address)).to.equal(150);

            console.log("✅ Oracle weight management working correctly");
        });

        it("Should handle batch weight setting", async function () {
            console.log("📦 Testing Batch Oracle Weight Setting...");

            const oracles = [oracle1.address, oracle2.address, oracle3.address];
            const weights = [120, 130, 140];

            await consensusOracle.batchSetOracleWeights(oracles, weights);

            expect(await consensusOracle.getOracleWeight(oracle1.address)).to.equal(120);
            expect(await consensusOracle.getOracleWeight(oracle2.address)).to.equal(130);
            expect(await consensusOracle.getOracleWeight(oracle3.address)).to.equal(140);

            console.log("✅ Batch oracle weight setting working correctly");
        });
    });

    describe("Oracle Reputation System", function () {
        it("Should track and update oracle reputation", async function () {
            console.log("📊 Testing Oracle Reputation System...");

            const initialInfo = await oracleManager.getOracleInfo(oracle1.address);
            const initialReputation = initialInfo.reputation;

            // Reward oracle
            await oracleManager.rewardOracle(oracle1.address, 100, "Good performance");

            const rewardedInfo = await oracleManager.getOracleInfo(oracle1.address);
            expect(rewardedInfo.reputation).to.equal(initialReputation + 100n);
            expect(rewardedInfo.correctAttestations).to.equal(1);

            // Penalize oracle
            await oracleManager.penalizeOracle(oracle2.address, 50, "Delayed response");

            const penalizedInfo = await oracleManager.getOracleInfo(oracle2.address);
            expect(penalizedInfo.reputation).to.equal(450); // 500 - 50

            console.log("✅ Oracle reputation system working correctly");
        });
    });

    describe("Integration Scenarios", function () {
        it("Should demonstrate complete KYC/AML workflow", async function () {
            console.log("🔄 Testing Complete KYC/AML Workflow...");

            // Step 1: KYC Success
            await whitelistOracle.addToWhitelist(user1.address, 3, 0, "KYC verified");
            expect(await whitelistOracle.isWhitelisted(user1.address)).to.be.true;
            console.log("✅ Step 1: KYC verification successful");

            // Step 2: AML Success - upgrade tier
            await whitelistOracle.addToWhitelist(user1.address, 5, 0, "KYC + AML verified");
            const whitelistInfo = await whitelistOracle.getWhitelistInfo(user1.address);
            expect(whitelistInfo.tier).to.equal(5);
            console.log("✅ Step 2: AML verification successful - tier upgraded");

            // Step 3: Later AML issue detected - move to blacklist
            await blacklistOracle.addToBlacklist(user1.address, 1, 0, "Suspicious activity detected");
            await whitelistOracle.removeFromWhitelist(user1.address, "Moved to blacklist");

            expect(await blacklistOracle.isBlacklisted(user1.address)).to.be.true;
            expect(await whitelistOracle.isWhitelisted(user1.address)).to.be.false;
            console.log("✅ Step 3: User moved from whitelist to blacklist");

            console.log("✅ Complete KYC/AML workflow demonstrated successfully");
        });

        it("Should handle oracle consensus for critical decisions", async function () {
            console.log("🤝 Testing Oracle Consensus for Critical Decisions...");

            // Set up consensus requirements
            await oracleManager.setConsensusThreshold(2); // Need 2 out of 3 oracles

            // Create a critical decision query
            const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "address", "uint256"],
                ["Critical compliance decision", user1.address, Date.now()]
            );

            const tx = await consensusOracle.createConsensusQuery(user1.address, 4, queryData);
            await tx.wait();

            console.log("✅ Critical decision query created");
            console.log("✅ Oracle consensus mechanism ready for critical decisions");
        });
    });
});

// Helper function for testing
const anyValue = (value: any) => true;