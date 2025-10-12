import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    TransferRestrictions
} from "../../typechain-types";

describe("Comprehensive Compliance Rule Enforcement", function () {
    let transferRestrictions: TransferRestrictions;
    let owner: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;

    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();

        // Deploy TransferRestrictions contract
        const TransferRestrictionsFactory = await ethers.getContractFactory("TransferRestrictions");
        transferRestrictions = await TransferRestrictionsFactory.deploy(owner.address);
        await transferRestrictions.waitForDeployment();
    });

    describe("Transfer Amount Restrictions", function () {
        it("should enforce maximum transfer amount limits (8,000 yuan)", async function () {
            // Set 8,000 VSC limit
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress, // Token address
                0, // No holding period
                8000, // Max 8,000 VSC
                0, // No daily limit
                0, // No monthly limit
                [], // All jurisdictions
                [], // All investor types
                false // No approval required
            );

            // Test transfer within limit
            const result1 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                5000
            );
            expect(result1[0]).to.be.true;
            expect(result1[1]).to.equal("Transfer allowed");

            // Test transfer exceeding limit
            const result2 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                10000
            );
            expect(result2[0]).to.be.false;
            expect(result2[1]).to.equal("Amount exceeds maximum transfer limit");
        });

        it("should enforce daily transfer limits", async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0,
                0, // No single transfer limit
                5000, // Daily limit 5,000
                0,
                [],
                [],
                false
            );

            // First transfer should succeed
            const result1 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                3000
            );
            expect(result1[0]).to.be.true;

            // Record the transfer
            await transferRestrictions.recordTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                3000
            );

            // Second transfer within daily limit should succeed
            const result2 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                1000
            );
            expect(result2[0]).to.be.true;

            // Third transfer exceeding daily limit should fail
            const result3 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                3000 // This would make total 6000, exceeding 5000 limit
            );
            expect(result3[0]).to.be.false;
            expect(result3[1]).to.equal("Daily transfer limit exceeded");
        });

        it("should enforce monthly transfer limits", async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0,
                0,
                0,
                20000, // Monthly limit 20,000
                [],
                [],
                false
            );

            // Transfer within monthly limit should succeed
            const result1 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                15000
            );
            expect(result1[0]).to.be.true;

            // Record the transfer
            await transferRestrictions.recordTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                15000
            );

            // Transfer exceeding monthly limit should fail
            const result2 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                10000
            );
            expect(result2[0]).to.be.false;
            expect(result2[1]).to.equal("Monthly transfer limit exceeded");
        });
    });

    describe("Holding Period Enforcement", function () {
        it("should enforce holding periods", async function () {
            // Set 30-day holding period
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                30 * 24 * 60 * 60, // 30 days in seconds
                0,
                0,
                0,
                [],
                [],
                false
            );

            // Initial transfer should succeed
            const result1 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                1000
            );
            expect(result1[0]).to.be.true;

            // Record the transfer
            await transferRestrictions.recordTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                1000
            );

            // Immediate subsequent transfer should fail due to holding period
            const result2 = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                500
            );
            expect(result2[0]).to.be.false;
            expect(result2[1]).to.equal("Holding period not met");
        });
    });

    describe("Error Handling and Edge Cases", function () {
        it("should handle zero-value transfers", async function () {
            const result = await transferRestrictions.canTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                0
            );
            expect(result[0]).to.be.true; // Zero transfers should be allowed
        });

        it("should handle transfers with no restrictions", async function () {
            // No restrictions set, should allow any transfer
            const result = await transferRestrictions.canTransfer(
                user1.address, // Different token (no rules set)
                user1.address,
                user2.address,
                1000000
            );
            expect(result[0]).to.be.true;
        });

        it("should get restriction rules correctly", async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                86400, // 1 day
                8000,
                10000,
                50000,
                [840, 826], // US, UK
                [1, 2], // Retail, Professional
                false
            );

            const rule = await transferRestrictions.getRestrictionRule(ethers.ZeroAddress);
            expect(rule.isActive).to.be.true;
            expect(rule.maxTransferAmount).to.equal(8000);
            expect(rule.holdingPeriod).to.equal(86400);
            expect(rule.dailyLimit).to.equal(10000);
            expect(rule.monthlyLimit).to.equal(50000);
        });

        it("should track transfer statistics", async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 0, 10000, 50000, [], [], false
            );

            // Record some transfers
            await transferRestrictions.recordTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                3000
            );

            await transferRestrictions.recordTransfer(
                ethers.ZeroAddress,
                user1.address,
                user2.address,
                2000
            );

            // Check transfer stats
            const stats = await transferRestrictions.getTransferStats(
                ethers.ZeroAddress,
                user1.address
            );
            expect(stats[0]).to.equal(5000); // Daily transferred
            expect(stats[1]).to.equal(5000); // Monthly transferred
        });
    });

    describe("Administrative Functions", function () {
        it("should only allow owner to set restriction rules", async function () {
            // Owner should be able to set rules
            await expect(
                transferRestrictions.setRestrictionRule(
                    ethers.ZeroAddress, 0, 8000, 0, 0, [], [], false
                )
            ).to.not.be.reverted;

            // Non-owner should not be able to set rules
            await expect(
                transferRestrictions.connect(user1).setRestrictionRule(
                    ethers.ZeroAddress, 0, 8000, 0, 0, [], [], false
                )
            ).to.be.revertedWithCustomError(transferRestrictions, "OwnableUnauthorizedAccount");
        });

        it("should handle jurisdiction and investor type restrictions", async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 0, 0, 0,
                [840], // Only US allowed
                [1, 2], // Only Retail and Professional
                false
            );

            // Test jurisdiction check
            const jurisdictionAllowed = await transferRestrictions.isJurisdictionAllowed(
                ethers.ZeroAddress,
                840 // US
            );
            expect(jurisdictionAllowed).to.be.true;

            const jurisdictionNotAllowed = await transferRestrictions.isJurisdictionAllowed(
                ethers.ZeroAddress,
                643 // Russia
            );
            expect(jurisdictionNotAllowed).to.be.false;

            // Test investor type check
            const investorTypeAllowed = await transferRestrictions.isInvestorTypeAllowed(
                ethers.ZeroAddress,
                1 // Retail
            );
            expect(investorTypeAllowed).to.be.true;

            const investorTypeNotAllowed = await transferRestrictions.isInvestorTypeAllowed(
                ethers.ZeroAddress,
                3 // Institutional (not in allowed list)
            );
            expect(investorTypeNotAllowed).to.be.false;
        });
    });
});