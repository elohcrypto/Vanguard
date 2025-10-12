import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    TransferRestrictions
} from "../../typechain-types";

describe("Gas Optimization and Batch Operations Tests", function () {
    let transferRestrictions: TransferRestrictions;
    let owner: SignerWithAddress;
    let users: SignerWithAddress[];

    const GAS_LIMITS = {
        SINGLE_TRANSFER_CHECK: 100000,
        BATCH_TRANSFER_CHECK: 80000, // Per check in batch
        SINGLE_UTXO_OPERATION: 200000,
        BATCH_UTXO_OPERATION: 150000 // Per operation in batch
    };

    beforeEach(async function () {
        const signers = await ethers.getSigners();
        owner = signers[0];
        users = signers.slice(1, 11); // 10 test users

        // Deploy contracts
        const TransferRestrictionsFactory = await ethers.getContractFactory("TransferRestrictions");
        transferRestrictions = await TransferRestrictionsFactory.deploy(owner.address);
        await transferRestrictions.waitForDeployment();

        // UTXOCompliance not needed for gas optimization tests
    });

    describe("Transfer Restrictions Gas Analysis", function () {
        beforeEach(async function () {
            // Set up transfer restrictions
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, // No holding period
                8000, // Max 8,000 VSC
                10000, // Daily limit 10,000
                50000, // Monthly limit 50,000
                [], // All jurisdictions
                [], // All investor types
                false // No approval required
            );
        });

        it("should measure gas usage for single transfer validation", async function () {
            const gasEstimate = await transferRestrictions.canTransfer.estimateGas(
                ethers.ZeroAddress,
                users[0].address,
                users[1].address,
                5000
            );

            console.log(`Single Transfer Validation Gas: ${gasEstimate.toString()}`);
            expect(gasEstimate).to.be.lessThan(GAS_LIMITS.SINGLE_TRANSFER_CHECK);
        });

        it("should measure gas usage for batch transfer validations", async function () {
            const batchSize = 5;
            const gasEstimates = [];

            for (let i = 0; i < batchSize; i++) {
                const gasEstimate = await transferRestrictions.canTransfer.estimateGas(
                    ethers.ZeroAddress,
                    users[i].address,
                    users[(i + 1) % users.length].address,
                    1000 + i * 100
                );
                gasEstimates.push(gasEstimate);
            }

            const totalGas = gasEstimates.reduce((sum, gas) => sum + gas, 0n);
            const avgGasPerCheck = totalGas / BigInt(batchSize);

            console.log(`Batch Transfer Validation Total Gas: ${totalGas.toString()}`);
            console.log(`Average Gas per Transfer Check: ${avgGasPerCheck.toString()}`);

            expect(avgGasPerCheck).to.be.lessThan(GAS_LIMITS.BATCH_TRANSFER_CHECK);
        });

        it("should test gas efficiency with different transfer amounts", async function () {
            const amounts = [100, 1000, 5000, 8000];
            const gasResults = [];

            for (const amount of amounts) {
                const gasEstimate = await transferRestrictions.canTransfer.estimateGas(
                    ethers.ZeroAddress,
                    users[0].address,
                    users[1].address,
                    amount
                );
                gasResults.push({ amount, gas: gasEstimate });
                console.log(`Amount ${amount}: ${gasEstimate.toString()} gas`);
            }

            // Gas usage should be relatively consistent regardless of amount
            const gasValues = gasResults.map(r => Number(r.gas));
            const avgGas = gasValues.reduce((sum, gas) => sum + gas, 0) / gasValues.length;
            const maxDeviation = Math.max(...gasValues.map(gas => Math.abs(gas - avgGas)));

            // Deviation should be less than 20% of average
            expect(maxDeviation).to.be.lessThan(avgGas * 0.2);
        });
    });

    describe("Transfer Recording Gas Analysis", function () {
        beforeEach(async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 0, 10000, 50000, [], [], false
            );
        });

        it("should measure gas for single transfer recording", async function () {
            const tx = await transferRestrictions.recordTransfer(
                ethers.ZeroAddress,
                users[0].address,
                users[1].address,
                5000
            );

            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed;

            console.log(`Single Transfer Recording Gas: ${gasUsed.toString()}`);
            expect(gasUsed).to.be.lessThan(150000); // Reasonable limit for recording
        });

        it("should measure gas for multiple transfer recordings", async function () {
            const batchSize = 5;
            const gasUsages = [];

            for (let i = 0; i < batchSize; i++) {
                const tx = await transferRestrictions.recordTransfer(
                    ethers.ZeroAddress,
                    users[i].address,
                    users[(i + 1) % users.length].address,
                    1000 + i * 200
                );

                const receipt = await tx.wait();
                gasUsages.push(receipt!.gasUsed);
                console.log(`Transfer ${i} recording gas: ${receipt!.gasUsed.toString()}`);
            }

            const totalGas = gasUsages.reduce((sum, gas) => sum + gas, 0n);
            const avgGasPerRecord = totalGas / BigInt(batchSize);

            console.log(`Average Gas per Transfer Record: ${avgGasPerRecord.toString()}`);
            expect(avgGasPerRecord).to.be.lessThan(150000); // Should be efficient
        });
    });

    describe("Restriction Rule Management Gas Analysis", function () {
        it("should measure gas for setting restriction rules", async function () {
            const tx = await transferRestrictions.setRestrictionRule(
                users[0].address, // New token
                86400, // 1 day holding period
                8000, // Max transfer
                10000, // Daily limit
                50000, // Monthly limit
                [840, 826, 756], // US, UK, CH
                [1, 2, 3], // Retail, Professional, Institutional
                false
            );

            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed;

            console.log(`Restriction Rule Setting Gas: ${gasUsed.toString()}`);
            expect(gasUsed).to.be.lessThan(250000); // Should be reasonable
        });

        it("should measure gas for getting restriction rules", async function () {
            // Set a rule first
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 8000, 10000, 50000, [840], [1], false
            );

            const gasEstimate = await transferRestrictions.getRestrictionRule.estimateGas(
                ethers.ZeroAddress
            );

            console.log(`Get Restriction Rule Gas: ${gasEstimate.toString()}`);
            expect(gasEstimate).to.be.lessThan(50000); // Should be very efficient for reads
        });
    });

    describe("Transfer Statistics Gas Analysis", function () {
        beforeEach(async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 0, 10000, 50000, [], [], false
            );

            // Record some transfers
            for (let i = 0; i < 3; i++) {
                await transferRestrictions.recordTransfer(
                    ethers.ZeroAddress,
                    users[0].address,
                    users[1].address,
                    1000 + i * 500
                );
            }
        });

        it("should measure gas for getting transfer statistics", async function () {
            const gasEstimate = await transferRestrictions.getTransferStats.estimateGas(
                ethers.ZeroAddress,
                users[0].address
            );

            console.log(`Get Transfer Stats Gas: ${gasEstimate.toString()}`);
            expect(gasEstimate).to.be.lessThan(80000); // Should be efficient
        });

        it("should test gas efficiency with accumulated transfer history", async function () {
            // Add more transfer history
            for (let i = 0; i < 10; i++) {
                await transferRestrictions.recordTransfer(
                    ethers.ZeroAddress,
                    users[0].address,
                    users[1].address,
                    500
                );
            }

            const gasEstimate = await transferRestrictions.getTransferStats.estimateGas(
                ethers.ZeroAddress,
                users[0].address
            );

            console.log(`Transfer Stats Gas (with history): ${gasEstimate.toString()}`);
            expect(gasEstimate).to.be.lessThan(100000); // Should still be reasonable
        });
    });

    describe("Jurisdiction and Investor Type Checks", function () {
        beforeEach(async function () {
            await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 0, 0, 0,
                [840, 826, 756], // US, UK, CH
                [1, 2], // Retail, Professional
                false
            );
        });

        it("should measure gas for jurisdiction checks", async function () {
            const jurisdictions = [840, 826, 756, 643]; // US, UK, CH, RU
            const gasResults = [];

            for (const jurisdiction of jurisdictions) {
                const gasEstimate = await transferRestrictions.isJurisdictionAllowed.estimateGas(
                    ethers.ZeroAddress,
                    jurisdiction
                );
                gasResults.push(gasEstimate);
                console.log(`Jurisdiction ${jurisdiction} check gas: ${gasEstimate.toString()}`);
            }

            const avgGas = gasResults.reduce((sum, gas) => sum + gas, 0n) / BigInt(gasResults.length);
            expect(avgGas).to.be.lessThan(50000); // Should be very efficient
        });

        it("should measure gas for investor type checks", async function () {
            const investorTypes = [1, 2, 3]; // Retail, Professional, Institutional
            const gasResults = [];

            for (const investorType of investorTypes) {
                const gasEstimate = await transferRestrictions.isInvestorTypeAllowed.estimateGas(
                    ethers.ZeroAddress,
                    investorType
                );
                gasResults.push(gasEstimate);
                console.log(`Investor type ${investorType} check gas: ${gasEstimate.toString()}`);
            }

            const avgGas = gasResults.reduce((sum, gas) => sum + gas, 0n) / BigInt(gasResults.length);
            expect(avgGas).to.be.lessThan(50000); // Should be very efficient
        });
    });

    describe("Scalability Tests", function () {
        it("should test performance with multiple tokens", async function () {
            const tokenCount = 5;
            const gasResults = [];

            // Set up rules for multiple tokens
            for (let i = 0; i < tokenCount; i++) {
                const tokenAddress = users[i].address; // Use user addresses as mock token addresses

                const tx = await transferRestrictions.setRestrictionRule(
                    tokenAddress,
                    0, 8000, 10000, 50000, [840], [1], false
                );

                const receipt = await tx.wait();
                gasResults.push(receipt!.gasUsed);
            }

            const avgGas = gasResults.reduce((sum, gas) => sum + gas, 0n) / BigInt(gasResults.length);
            console.log(`Average gas for rule setup across ${tokenCount} tokens: ${avgGas.toString()}`);

            // Gas usage should be consistent across tokens
            const maxGas = gasResults.reduce((max, gas) => gas > max ? gas : max, 0n);
            const minGas = gasResults.reduce((min, gas) => gas < min ? gas : min, maxGas);
            const gasVariation = maxGas - minGas;

            expect(gasVariation).to.be.lessThan(avgGas / 10n); // Less than 10% variation
        });

        it("should provide gas usage recommendations", async function () {
            const recommendations = {
                singleTransferCheck: "< 100,000 gas",
                batchTransferCheck: "< 80,000 gas per check",
                transferRecording: "< 150,000 gas",
                ruleSetup: "< 200,000 gas",
                statisticsRetrieval: "< 80,000 gas",
                jurisdictionCheck: "< 30,000 gas",
                investorTypeCheck: "< 30,000 gas"
            };

            console.log("\\nGas Usage Recommendations:");
            console.log("=============================");
            Object.entries(recommendations).forEach(([operation, limit]) => {
                console.log(`${operation}: ${limit}`);
            });

            // This test always passes - it's for documentation
            expect(true).to.be.true;
        });
    });

    describe("Memory and Storage Optimization", function () {
        it("should handle large restriction rule arrays efficiently", async function () {
            // Test with larger arrays
            const largeJurisdictionArray = [840, 826, 756, 276, 380, 392, 724, 752]; // 8 countries
            const largeInvestorTypeArray = [1, 2, 3, 4, 5]; // 5 investor types

            const tx = await transferRestrictions.setRestrictionRule(
                ethers.ZeroAddress,
                0, 8000, 10000, 50000,
                largeJurisdictionArray,
                largeInvestorTypeArray,
                false
            );

            const receipt = await tx.wait();
            console.log(`Large arrays rule setup gas: ${receipt!.gasUsed.toString()}`);

            // Should still be reasonable even with larger arrays
            expect(receipt!.gasUsed).to.be.lessThan(300000);
        });

        it("should optimize repeated operations", async function () {
            const operations = 5;
            const gasUsages = [];

            // Perform repeated canTransfer operations
            for (let i = 0; i < operations; i++) {
                const gasEstimate = await transferRestrictions.canTransfer.estimateGas(
                    ethers.ZeroAddress,
                    users[0].address,
                    users[1].address,
                    5000
                );
                gasUsages.push(gasEstimate);
            }

            // Gas usage should be consistent (no memory leaks or inefficiencies)
            const avgGas = gasUsages.reduce((sum, gas) => sum + gas, 0n) / BigInt(gasUsages.length);
            const maxDeviation = gasUsages.reduce((max, gas) => {
                const deviation = gas > avgGas ? gas - avgGas : avgGas - gas;
                return deviation > max ? deviation : max;
            }, 0n);

            console.log(`Repeated operations - Average: ${avgGas.toString()}, Max deviation: ${maxDeviation.toString()}`);
            expect(maxDeviation).to.be.lessThan(avgGas / 20n); // Less than 5% deviation
        });
    });
});