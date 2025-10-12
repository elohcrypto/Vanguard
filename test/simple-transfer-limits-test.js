const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Simple Transfer Limits Test - 8,000 Yuan Max", function () {
    let investorTypeRegistry;
    let owner, investor1, investor2;

    const EIGHT_THOUSAND_YUAN = ethers.parseEther("8000"); // 8,000 tokens
    const OVER_LIMIT = ethers.parseEther("8001"); // Over limit
    const UNDER_LIMIT = ethers.parseEther("7999"); // Under limit

    beforeEach(async function () {
        [owner, investor1, investor2] = await ethers.getSigners();

        // Deploy Investor Type Registry
        const InvestorTypeRegistry = await ethers.getContractFactory("InvestorTypeRegistry");
        investorTypeRegistry = await InvestorTypeRegistry.deploy();

        // Set compliance officer
        await investorTypeRegistry.setComplianceOfficer(owner.address, true);

        // Assign investor types (Normal = 0, which has 8,000 limit)
        await investorTypeRegistry.assignInvestorType(investor1.address, 0); // Normal
        await investorTypeRegistry.assignInvestorType(investor2.address, 0); // Normal
    });

    describe("Transfer Limit Configuration Verification", function () {
        it("Should verify Normal investor type has exactly 8,000 limit", async function () {
            const config = await investorTypeRegistry.getInvestorTypeConfig(0); // Normal type
            expect(config.maxTransferAmount).to.equal(EIGHT_THOUSAND_YUAN);
            console.log("✅ Normal investor max transfer:", ethers.formatEther(config.maxTransferAmount), "tokens");
        });

        it("Should verify Retail investor type has exactly 8,000 limit", async function () {
            const config = await investorTypeRegistry.getInvestorTypeConfig(1); // Retail type
            expect(config.maxTransferAmount).to.equal(EIGHT_THOUSAND_YUAN);
            console.log("✅ Retail investor max transfer:", ethers.formatEther(config.maxTransferAmount), "tokens");
        });

        it("Should verify Accredited investor type has 50,000 limit", async function () {
            const config = await investorTypeRegistry.getInvestorTypeConfig(2); // Accredited type
            expect(config.maxTransferAmount).to.equal(ethers.parseEther("50000"));
            console.log("✅ Accredited investor max transfer:", ethers.formatEther(config.maxTransferAmount), "tokens");
        });

        it("Should verify Institutional investor type has 500,000 limit", async function () {
            const config = await investorTypeRegistry.getInvestorTypeConfig(3); // Institutional type
            expect(config.maxTransferAmount).to.equal(ethers.parseEther("500000"));
            console.log("✅ Institutional investor max transfer:", ethers.formatEther(config.maxTransferAmount), "tokens");
        });
    });

    describe("Transfer Amount Validation", function () {
        it("Should ALLOW transfer of exactly 8,000 Yuan for Normal investor", async function () {
            const canTransfer = await investorTypeRegistry.canTransferAmount(investor1.address, EIGHT_THOUSAND_YUAN);
            expect(canTransfer).to.be.true;
            console.log("✅ Normal investor CAN transfer exactly 8,000 tokens");
        });

        it("Should ALLOW transfer under 8,000 Yuan for Normal investor", async function () {
            const canTransfer = await investorTypeRegistry.canTransferAmount(investor1.address, UNDER_LIMIT);
            expect(canTransfer).to.be.true;
            console.log("✅ Normal investor CAN transfer", ethers.formatEther(UNDER_LIMIT), "tokens");
        });

        it("Should REJECT transfer over 8,000 Yuan for Normal investor", async function () {
            const canTransfer = await investorTypeRegistry.canTransferAmount(investor1.address, OVER_LIMIT);
            expect(canTransfer).to.be.false;
            console.log("❌ Normal investor CANNOT transfer", ethers.formatEther(OVER_LIMIT), "tokens");
        });

        it("Should verify exact boundary conditions", async function () {
            // Test exactly at the limit
            const exactLimit = ethers.parseEther("8000");
            const canTransferExact = await investorTypeRegistry.canTransferAmount(investor1.address, exactLimit);
            expect(canTransferExact).to.be.true;
            console.log("✅ Exact limit (8000) is allowed");

            // Test 1 wei over the limit
            const overByOne = exactLimit + 1n;
            const canTransferOverOne = await investorTypeRegistry.canTransferAmount(investor1.address, overByOne);
            expect(canTransferOverOne).to.be.false;
            console.log("❌ Over limit by 1 wei is rejected");
        });
    });

    describe("Investor Type Upgrades", function () {
        it("Should allow higher transfer limits after upgrade to Accredited", async function () {
            // Initially Normal investor (8,000 limit)
            let canTransfer10k = await investorTypeRegistry.canTransferAmount(investor1.address, ethers.parseEther("10000"));
            expect(canTransfer10k).to.be.false;
            console.log("❌ Normal investor cannot transfer 10,000 tokens");

            // Upgrade to Accredited (50,000 limit)
            await investorTypeRegistry.upgradeInvestorType(investor1.address, 2); // Accredited

            // Now should be able to transfer 10,000
            canTransfer10k = await investorTypeRegistry.canTransferAmount(investor1.address, ethers.parseEther("10000"));
            expect(canTransfer10k).to.be.true;
            console.log("✅ Accredited investor CAN transfer 10,000 tokens");
        });

        it("Should allow even higher limits for Institutional investors", async function () {
            // Upgrade to Institutional (500,000 limit)
            await investorTypeRegistry.upgradeInvestorType(investor1.address, 2); // First to Accredited
            await investorTypeRegistry.upgradeInvestorType(investor1.address, 3); // Then to Institutional

            // Should be able to transfer 100,000
            const canTransfer100k = await investorTypeRegistry.canTransferAmount(investor1.address, ethers.parseEther("100000"));
            expect(canTransfer100k).to.be.true;
            console.log("✅ Institutional investor CAN transfer 100,000 tokens");
        });
    });

    describe("Multiple Investor Types", function () {
        it("Should enforce different limits for different investor types", async function () {
            // Upgrade investor2 to Accredited
            await investorTypeRegistry.upgradeInvestorType(investor2.address, 2); // Accredited

            // investor1 (Normal) should be limited to 8,000
            const investor1CanTransfer10k = await investorTypeRegistry.canTransferAmount(investor1.address, ethers.parseEther("10000"));
            expect(investor1CanTransfer10k).to.be.false;

            // investor2 (Accredited) should be able to transfer 10,000
            const investor2CanTransfer10k = await investorTypeRegistry.canTransferAmount(investor2.address, ethers.parseEther("10000"));
            expect(investor2CanTransfer10k).to.be.true;

            console.log("✅ Different investor types have different limits enforced correctly");
        });
    });

    describe("Configuration Display", function () {
        it("Should display all investor type configurations", async function () {
            const configs = await investorTypeRegistry.getAllInvestorTypeConfigs();

            console.log("\n📊 INVESTOR TYPE TRANSFER LIMITS:");
            console.log("================================");
            console.log("Normal:        ", ethers.formatEther(configs.normalConfig.maxTransferAmount), "tokens");
            console.log("Retail:        ", ethers.formatEther(configs.retailConfig.maxTransferAmount), "tokens");
            console.log("Accredited:    ", ethers.formatEther(configs.accreditedConfig.maxTransferAmount), "tokens");
            console.log("Institutional: ", ethers.formatEther(configs.institutionalConfig.maxTransferAmount), "tokens");
            console.log("================================\n");

            // Verify the 8,000 limit for Normal and Retail
            expect(configs.normalConfig.maxTransferAmount).to.equal(EIGHT_THOUSAND_YUAN);
            expect(configs.retailConfig.maxTransferAmount).to.equal(EIGHT_THOUSAND_YUAN);
        });
    });
});