import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { InvestorTypeRegistry } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Governance System", function () {
    let investorTypeRegistry: InvestorTypeRegistry;

    let owner: SignerWithAddress;
    let governor1: SignerWithAddress;
    let governor2: SignerWithAddress;
    let governor3: SignerWithAddress;
    let nonGovernor: SignerWithAddress;

    const VSC = (amount: number) => ethers.parseUnits(amount.toString(), 18);
    const GOVERNANCE_DELAY = 2 * 24 * 60 * 60; // 2 days in seconds

    beforeEach(async function () {
        [owner, governor1, governor2, governor3, nonGovernor] = await ethers.getSigners();

        // Deploy InvestorTypeRegistry with governance
        const InvestorTypeRegistryFactory = await ethers.getContractFactory("InvestorTypeRegistry");
        investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
        await investorTypeRegistry.waitForDeployment();

        // Set up governors
        await investorTypeRegistry.setGovernor(governor1.address, true, 100);
        await investorTypeRegistry.setGovernor(governor2.address, true, 75);
        await investorTypeRegistry.setGovernor(governor3.address, true, 50);

        // Set governance parameters (2 day delay, 2 approvals required)
        await investorTypeRegistry.updateGovernanceParameters(GOVERNANCE_DELAY, 2);
    });

    describe("Governance Setup", function () {
        it("Should set up governors correctly", async function () {
            expect(await investorTypeRegistry.isGovernor(governor1.address)).to.be.true;
            expect(await investorTypeRegistry.isGovernor(governor2.address)).to.be.true;
            expect(await investorTypeRegistry.isGovernor(governor3.address)).to.be.true;
            expect(await investorTypeRegistry.isGovernor(nonGovernor.address)).to.be.false;

            expect(await investorTypeRegistry.getGovernorWeight(governor1.address)).to.equal(100);
            expect(await investorTypeRegistry.getGovernorWeight(governor2.address)).to.equal(75);
            expect(await investorTypeRegistry.getGovernorWeight(governor3.address)).to.equal(50);
        });

        it("Should update governance parameters", async function () {
            const newDelay = 3 * 24 * 60 * 60; // 3 days
            const newRequiredApprovals = 3;

            await expect(
                investorTypeRegistry.updateGovernanceParameters(newDelay, newRequiredApprovals)
            ).to.emit(investorTypeRegistry, "GovernanceParametersUpdated")
                .withArgs(newDelay, newRequiredApprovals);

            expect(await investorTypeRegistry.governanceDelay()).to.equal(newDelay);
            expect(await investorTypeRegistry.requiredApprovals()).to.equal(newRequiredApprovals);
        });
    });
    describe("Proposal Creation", function () {
        it("Should allow governors to create proposals", async function () {
            const newConfig = {
                maxTransferAmount: VSC(100000),
                maxHoldingAmount: VSC(1000000),
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 15,
                largeTransferThreshold: VSC(25000),
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            await expect(
                investorTypeRegistry.connect(governor1).createProposal(
                    2, // Accredited
                    newConfig,
                    "Increase Accredited Investor limits"
                )
            ).to.emit(investorTypeRegistry, "ProposalCreated")
                .withArgs(1, governor1.address, 2, "Increase Accredited Investor limits");
        });

        it("Should not allow non-governors to create proposals", async function () {
            const newConfig = {
                maxTransferAmount: VSC(100000),
                maxHoldingAmount: VSC(1000000),
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 15,
                largeTransferThreshold: VSC(25000),
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            await expect(
                investorTypeRegistry.connect(nonGovernor).createProposal(
                    2,
                    newConfig,
                    "Unauthorized proposal"
                )
            ).to.be.revertedWith("Not authorized governor");
        });

        it("Should validate proposal configuration", async function () {
            const invalidConfig = {
                maxTransferAmount: 0, // Invalid - should be > 0
                maxHoldingAmount: VSC(1000000),
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 15,
                largeTransferThreshold: VSC(25000),
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            await expect(
                investorTypeRegistry.connect(governor1).createProposal(
                    2,
                    invalidConfig,
                    "Invalid proposal"
                )
            ).to.be.revertedWith("Invalid max transfer amount");
        });
    });

    describe("Voting Process", function () {
        let proposalId: number;

        beforeEach(async function () {
            // Create a test proposal
            const newConfig = {
                maxTransferAmount: VSC(100000),
                maxHoldingAmount: VSC(1000000),
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 15,
                largeTransferThreshold: VSC(25000),
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            const tx = await investorTypeRegistry.connect(governor1).createProposal(
                2,
                newConfig,
                "Test proposal for voting"
            );

            const receipt = await tx.wait();
            const event = receipt?.logs.find(log => {
                try {
                    const parsed = investorTypeRegistry.interface.parseLog(log);
                    return parsed?.name === 'ProposalCreated';
                } catch (e) {
                    return false;
                }
            });

            if (event) {
                const parsed = investorTypeRegistry.interface.parseLog(event);
                proposalId = Number(parsed?.args.proposalId);
            } else {
                proposalId = 1; // Fallback
            }
        });

        it("Should allow governors to approve proposals", async function () {
            await expect(
                investorTypeRegistry.connect(governor1).approveProposal(proposalId)
            ).to.emit(investorTypeRegistry, "ProposalApproved")
                .withArgs(proposalId, governor1.address);

            expect(await investorTypeRegistry.hasApproved(proposalId, governor1.address)).to.be.true;
        });

        it("Should not allow double voting", async function () {
            await investorTypeRegistry.connect(governor1).approveProposal(proposalId);

            await expect(
                investorTypeRegistry.connect(governor1).approveProposal(proposalId)
            ).to.be.revertedWith("Already approved");
        });

        it("Should not allow non-governors to vote", async function () {
            await expect(
                investorTypeRegistry.connect(nonGovernor).approveProposal(proposalId)
            ).to.be.revertedWith("Not authorized governor");
        });

        it("Should track approval count correctly", async function () {
            await investorTypeRegistry.connect(governor1).approveProposal(proposalId);
            await investorTypeRegistry.connect(governor2).approveProposal(proposalId);

            const proposal = await investorTypeRegistry.getProposal(proposalId);
            expect(proposal.approvalsCount).to.equal(2);
        });
    });

    describe("Proposal Execution", function () {
        let proposalId: number;

        beforeEach(async function () {
            // Create and approve a proposal
            const newConfig = {
                maxTransferAmount: VSC(100000), // Increase from 50K to 100K
                maxHoldingAmount: VSC(1000000), // Increase from 500K to 1M
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 15, // Reduce from 30 to 15 minutes
                largeTransferThreshold: VSC(25000), // Increase from 10K to 25K
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            const tx = await investorTypeRegistry.connect(governor1).createProposal(
                2, // Accredited
                newConfig,
                "Test execution proposal"
            );

            const receipt = await tx.wait();
            const event = receipt?.logs.find(log => {
                try {
                    const parsed = investorTypeRegistry.interface.parseLog(log);
                    return parsed?.name === 'ProposalCreated';
                } catch (e) {
                    return false;
                }
            });

            if (event) {
                const parsed = investorTypeRegistry.interface.parseLog(event);
                proposalId = Number(parsed?.args.proposalId);
            } else {
                proposalId = 1;
            }

            // Get enough approvals
            await investorTypeRegistry.connect(governor1).approveProposal(proposalId);
            await investorTypeRegistry.connect(governor2).approveProposal(proposalId);
        });

        it("Should not execute before delay period", async function () {
            await expect(
                investorTypeRegistry.executeProposal(proposalId)
            ).to.be.revertedWith("Execution delay not met");
        });

        it("Should not execute without enough approvals", async function () {
            // Create new proposal with only 1 approval
            const newConfig = {
                maxTransferAmount: VSC(75000),
                maxHoldingAmount: VSC(750000),
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 20,
                largeTransferThreshold: VSC(15000),
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            const tx = await investorTypeRegistry.connect(governor1).createProposal(
                1, // Retail
                newConfig,
                "Insufficient approvals test"
            );

            const receipt = await tx.wait();
            const event = receipt?.logs.find(log => {
                try {
                    const parsed = investorTypeRegistry.interface.parseLog(log);
                    return parsed?.name === 'ProposalCreated';
                } catch (e) {
                    return false;
                }
            });

            let newProposalId = 2; // Fallback
            if (event) {
                const parsed = investorTypeRegistry.interface.parseLog(event);
                newProposalId = Number(parsed?.args.proposalId);
            }

            // Only 1 approval (need 2)
            await investorTypeRegistry.connect(governor1).approveProposal(newProposalId);

            // Fast forward time
            await time.increase(GOVERNANCE_DELAY + 1);

            await expect(
                investorTypeRegistry.executeProposal(newProposalId)
            ).to.be.revertedWith("Insufficient approvals");
        });

        it("Should execute proposal after delay and approvals", async function () {
            // Fast forward time past delay
            await time.increase(GOVERNANCE_DELAY + 1);

            // Execute proposal
            await expect(
                investorTypeRegistry.executeProposal(proposalId)
            ).to.emit(investorTypeRegistry, "ProposalExecuted")
                .withArgs(proposalId);

            // Verify configuration was updated
            const updatedConfig = await investorTypeRegistry.getInvestorTypeConfig(2); // Accredited
            expect(updatedConfig.maxTransferAmount).to.equal(VSC(100000));
            expect(updatedConfig.maxHoldingAmount).to.equal(VSC(1000000));
            expect(updatedConfig.transferCooldownMinutes).to.equal(15);
        });

        it("Should not execute proposal twice", async function () {
            // Fast forward and execute
            await time.increase(GOVERNANCE_DELAY + 1);
            await investorTypeRegistry.executeProposal(proposalId);

            // Try to execute again
            await expect(
                investorTypeRegistry.executeProposal(proposalId)
            ).to.be.revertedWith("Proposal not executable");
        });
    });

    describe("Proposal Management", function () {
        let proposalId: number;

        beforeEach(async function () {
            const newConfig = {
                maxTransferAmount: VSC(75000),
                maxHoldingAmount: VSC(750000),
                requiredWhitelistTier: 3,
                transferCooldownMinutes: 20,
                largeTransferThreshold: VSC(15000),
                enhancedLogging: true,
                enhancedPrivacy: true
            };

            const tx = await investorTypeRegistry.connect(governor1).createProposal(
                2,
                newConfig,
                "Test cancellation proposal"
            );

            const receipt = await tx.wait();
            const event = receipt?.logs.find(log => {
                try {
                    const parsed = investorTypeRegistry.interface.parseLog(log);
                    return parsed?.name === 'ProposalCreated';
                } catch (e) {
                    return false;
                }
            });

            if (event) {
                const parsed = investorTypeRegistry.interface.parseLog(event);
                proposalId = Number(parsed?.args.proposalId);
            } else {
                proposalId = 1;
            }
        });

        it("Should allow owner to cancel proposals", async function () {
            await expect(
                investorTypeRegistry.cancelProposal(proposalId)
            ).to.emit(investorTypeRegistry, "ProposalCancelled")
                .withArgs(proposalId);

            const proposal = await investorTypeRegistry.getProposal(proposalId);
            expect(proposal.status).to.equal(3); // Cancelled status
        });

        it("Should not allow non-owners to cancel proposals", async function () {
            await expect(
                investorTypeRegistry.connect(governor1).cancelProposal(proposalId)
            ).to.be.revertedWithCustomError(investorTypeRegistry, "OwnableUnauthorizedAccount");
        });

        it("Should not execute cancelled proposals", async function () {
            // Get approvals first
            await investorTypeRegistry.connect(governor1).approveProposal(proposalId);
            await investorTypeRegistry.connect(governor2).approveProposal(proposalId);

            // Cancel the proposal
            await investorTypeRegistry.cancelProposal(proposalId);

            // Fast forward time
            await time.increase(GOVERNANCE_DELAY + 1);

            // Try to execute cancelled proposal
            await expect(
                investorTypeRegistry.executeProposal(proposalId)
            ).to.be.revertedWith("Proposal not executable");
        });

        it("Should get proposal details correctly", async function () {
            const proposal = await investorTypeRegistry.getProposal(proposalId);

            expect(proposal.proposer).to.equal(governor1.address);
            expect(proposal.investorType).to.equal(2);
            expect(proposal.description).to.equal("Test cancellation proposal");
            expect(proposal.status).to.equal(0); // Pending status
            expect(proposal.approvalsCount).to.equal(0);
        });
    });

    describe("Governor Management", function () {
        it("Should allow owner to add new governors", async function () {
            const newGovernor = nonGovernor;

            await expect(
                investorTypeRegistry.setGovernor(newGovernor.address, true, 25)
            ).to.emit(investorTypeRegistry, "GovernorUpdated")
                .withArgs(newGovernor.address, true, 25);

            expect(await investorTypeRegistry.isGovernor(newGovernor.address)).to.be.true;
            expect(await investorTypeRegistry.getGovernorWeight(newGovernor.address)).to.equal(25);
        });

        it("Should allow owner to remove governors", async function () {
            await expect(
                investorTypeRegistry.setGovernor(governor3.address, false, 0)
            ).to.emit(investorTypeRegistry, "GovernorUpdated")
                .withArgs(governor3.address, false, 0);

            expect(await investorTypeRegistry.isGovernor(governor3.address)).to.be.false;
            expect(await investorTypeRegistry.getGovernorWeight(governor3.address)).to.equal(0);
        });

        it("Should not allow non-owners to manage governors", async function () {
            await expect(
                investorTypeRegistry.connect(governor1).setGovernor(nonGovernor.address, true, 25)
            ).to.be.revertedWithCustomError(investorTypeRegistry, "OwnableUnauthorizedAccount");
        });
    });
});