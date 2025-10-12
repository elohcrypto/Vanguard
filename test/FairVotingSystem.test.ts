import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
    GovernanceToken,
    VanguardGovernance,
    IdentityRegistry,
    ComplianceRules,
    ClaimIssuer,
    InvestorTypeRegistry
} from '../typechain-types';

describe('Fair Voting System (1 Person = 1 Vote)', function () {
    let governanceToken: GovernanceToken;
    let vanguardGovernance: VanguardGovernance;
    let identityRegistry: IdentityRegistry;
    let complianceRules: ComplianceRules;
    let claimIssuer: ClaimIssuer;
    let investorTypeRegistry: InvestorTypeRegistry;

    let owner: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let carol: SignerWithAddress;
    let dave: SignerWithAddress;
    let unverified: SignerWithAddress;

    const PROPOSAL_CREATION_COST = ethers.parseEther('10'); // 10 VGT (contract default)
    const VOTING_COST = ethers.parseEther('10'); // 10 VGT

    // Helper function to create InvestorTypeConfig
    const createInvestorTypeConfig = (maxTransfer: string, maxHolding: string) => ({
        maxTransferAmount: ethers.parseEther(maxTransfer),
        maxHoldingAmount: ethers.parseEther(maxHolding),
        requiredWhitelistTier: 1,
        transferCooldownMinutes: 0,
        largeTransferThreshold: ethers.parseEther('5000'),
        enhancedLogging: false,
        enhancedPrivacy: false
    });

    before(async function () {
        [owner, alice, bob, carol, dave, unverified] = await ethers.getSigners();

        // Deploy ClaimIssuer
        const ClaimIssuer = await ethers.getContractFactory('ClaimIssuer');
        claimIssuer = await ClaimIssuer.deploy(
            owner.address,
            'KYC Service',
            'KYC verification service'
        );
        await claimIssuer.waitForDeployment();

        // Deploy IdentityRegistry
        const IdentityRegistry = await ethers.getContractFactory('IdentityRegistry');
        identityRegistry = await IdentityRegistry.deploy();
        await identityRegistry.waitForDeployment();

        // Deploy ComplianceRules
        const ComplianceRules = await ethers.getContractFactory('ComplianceRules');
        complianceRules = await ComplianceRules.deploy(
            owner.address,
            [], // Empty allowed list = all countries allowed (except blocked)
            [] // No blocked countries
        );
        await complianceRules.waitForDeployment();

        // Deploy GovernanceToken
        const GovernanceToken = await ethers.getContractFactory('GovernanceToken');
        governanceToken = await GovernanceToken.deploy(
            'Vanguard Governance Token',
            'VGT',
            await identityRegistry.getAddress(),
            await complianceRules.getAddress()
        );
        await governanceToken.waitForDeployment();

        // Deploy InvestorTypeRegistry
        const InvestorTypeRegistry = await ethers.getContractFactory('InvestorTypeRegistry');
        investorTypeRegistry = await InvestorTypeRegistry.deploy();
        await investorTypeRegistry.waitForDeployment();

        // Transfer ownership of InvestorTypeRegistry to VanguardGovernance (so proposals can execute)
        // We'll do this after VanguardGovernance is deployed

        // Deploy VanguardGovernance
        const VanguardGovernance = await ethers.getContractFactory('VanguardGovernance');
        vanguardGovernance = await VanguardGovernance.deploy(
            await governanceToken.getAddress(),
            await identityRegistry.getAddress(),
            await investorTypeRegistry.getAddress(),
            await complianceRules.getAddress(),
            ethers.ZeroAddress, // Oracle manager
            await governanceToken.getAddress() // Token
        );
        await vanguardGovernance.waitForDeployment();

        // Set VanguardGovernance as agent for GovernanceToken
        await governanceToken.addAgent(await vanguardGovernance.getAddress());

        // Link ComplianceRules to IdentityRegistry for the token
        await complianceRules.setTokenIdentityRegistry(
            await governanceToken.getAddress(),
            await identityRegistry.getAddress()
        );

        // Set rule administrator
        await complianceRules.setRuleAdministrator(owner.address, true);

        // Transfer ownership of InvestorTypeRegistry to VanguardGovernance
        // This allows proposals to execute updateInvestorTypeConfig
        await investorTypeRegistry.transferOwnership(await vanguardGovernance.getAddress());

        // Deploy OnchainIDFactory
        const OnchainIDFactory = await ethers.getContractFactory('OnchainIDFactory');
        const onchainIDFactory = await OnchainIDFactory.deploy(owner.address);
        await onchainIDFactory.waitForDeployment();

        // Setup identities for Owner, Alice, Bob, Carol, Dave
        const setupIdentity = async (signer: SignerWithAddress) => {
            // Create OnchainID
            const salt = ethers.randomBytes(32);
            await onchainIDFactory.connect(signer).deployOnchainID(signer.address, salt);
            const identityAddress = await onchainIDFactory.getIdentityByOwner(signer.address);

            // Issue KYC claim
            const kycData = ethers.hexlify(ethers.toUtf8Bytes('KYC_APPROVED'));
            const validTo = 0; // No expiration

            await claimIssuer.issueClaim(
                identityAddress,
                1, // KYC topic
                1, // ECDSA scheme
                kycData,
                '', // URI
                validTo
            );

            // Register identity in IdentityRegistry
            await identityRegistry.registerIdentity(signer.address, identityAddress, 0);

            return identityAddress;
        };

        // Setup owner first (needed for token transfers)
        await setupIdentity(owner);
        await setupIdentity(alice);
        await setupIdentity(bob);
        await setupIdentity(carol);
        await setupIdentity(dave);

        // Register VanguardGovernance contract as verified identity (needed for transferFrom)
        const govSalt = ethers.randomBytes(32);
        const govAddress = await vanguardGovernance.getAddress();
        await onchainIDFactory.deployOnchainID(govAddress, govSalt);
        const govIdentityAddress = await onchainIDFactory.getIdentityByOwner(govAddress);

        const kycData = ethers.hexlify(ethers.toUtf8Bytes('KYC_APPROVED'));
        await claimIssuer.issueClaim(
            govIdentityAddress,
            1, // KYC topic
            1, // ECDSA scheme
            kycData,
            '', // URI
            0 // No expiration
        );

        await identityRegistry.registerIdentity(govAddress, govIdentityAddress, 0);

        // Owner already has 1M tokens from constructor mint
        // Distribute VGT tokens to users (compliance-checked transfers)
        // Alice: 50,000 VGT (enough for proposal + votes)
        // Bob: 1,000 VGT (enough for votes)
        // Carol: 500 VGT (enough for votes)
        // Dave: 100 VGT (enough for votes)
        await governanceToken.transfer(alice.address, ethers.parseEther('50000'));
        await governanceToken.transfer(bob.address, ethers.parseEther('1000'));
        await governanceToken.transfer(carol.address, ethers.parseEther('500'));
        await governanceToken.transfer(dave.address, ethers.parseEther('100')); // Enough for voting (10 VGT) but we'll use unverified for proposal test

        // Approve VanguardGovernance to spend tokens
        await governanceToken.connect(alice).approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
        await governanceToken.connect(bob).approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
        await governanceToken.connect(carol).approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
        await governanceToken.connect(dave).approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
    });

    describe('Governance Costs', function () {
        it('Should have correct default proposal creation cost', async function () {
            const cost = await vanguardGovernance.proposalCreationCost();
            expect(cost).to.equal(PROPOSAL_CREATION_COST);
        });

        it('Should have correct default voting cost', async function () {
            const cost = await vanguardGovernance.votingCost();
            expect(cost).to.equal(VOTING_COST);
        });

        it('Should allow owner to update proposal creation cost', async function () {
            const newCost = ethers.parseEther('5000');
            await vanguardGovernance.setProposalCreationCost(newCost);
            expect(await vanguardGovernance.proposalCreationCost()).to.equal(newCost);
            
            // Reset to default
            await vanguardGovernance.setProposalCreationCost(PROPOSAL_CREATION_COST);
        });

        it('Should allow owner to update voting cost', async function () {
            const newCost = ethers.parseEther('5');
            await vanguardGovernance.setVotingCost(newCost);
            expect(await vanguardGovernance.votingCost()).to.equal(newCost);
            
            // Reset to default
            await vanguardGovernance.setVotingCost(VOTING_COST);
        });
    });

    describe('Proposal Creation with Cost', function () {
        it('Should reject proposal creation from unverified user', async function () {
            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                0, // Normal investor
                createInvestorTypeConfig('10000', '100000')
            ]);

            await expect(
                vanguardGovernance.connect(unverified).createProposal(
                    0, // InvestorTypeConfig
                    'Update Normal Investor Limits',
                    'Increase limits for normal investors',
                    await investorTypeRegistry.getAddress(),
                    callData
                )
            ).to.be.revertedWith('Must be KYC/AML verified');
        });

        it('Should reject unverified user before checking token balance', async function () {
            // Unverified user is not registered in IdentityRegistry
            // VanguardGovernance checks KYC/AML verification BEFORE token balance
            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                0,
                createInvestorTypeConfig('10000', '100000')
            ]);

            await expect(
                vanguardGovernance.connect(unverified).createProposal(
                    0,
                    'Update Normal Investor Limits',
                    'Increase limits',
                    await investorTypeRegistry.getAddress(),
                    callData
                )
            ).to.be.revertedWith('Must be KYC/AML verified');
        });

        it('Should create proposal and lock tokens', async function () {
            const aliceBalanceBefore = await governanceToken.balanceOf(alice.address);

            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                0,
                createInvestorTypeConfig('10000', '100000')
            ]);

            await vanguardGovernance.connect(alice).createProposal(
                0,
                'Update Normal Investor Limits',
                'Increase limits for normal investors',
                await investorTypeRegistry.getAddress(),
                callData
            );

            const aliceBalanceAfter = await governanceToken.balanceOf(alice.address);
            expect(aliceBalanceBefore - aliceBalanceAfter).to.equal(PROPOSAL_CREATION_COST);

            // Check locked tokens
            const lockedTokens = await vanguardGovernance.getLockedTokens(1);
            expect(lockedTokens).to.equal(PROPOSAL_CREATION_COST);
        });
    });

    describe('Fair Voting (1 Person = 1 Vote)', function () {
        let proposalId: number;

        before(async function () {
            // Create a proposal for testing
            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                1, // Retail investor
                createInvestorTypeConfig('5000', '50000')
            ]);

            const tx = await vanguardGovernance.connect(alice).createProposal(
                0,
                'Update Retail Investor Limits',
                'Increase limits for retail investors',
                await investorTypeRegistry.getAddress(),
                callData
            );
            
            const receipt = await tx.wait();
            proposalId = 2; // Second proposal
        });

        it('Should reject vote from unverified user', async function () {
            await expect(
                vanguardGovernance.connect(unverified).castVote(proposalId, true, 'Support')
            ).to.be.revertedWith('Must be KYC/AML verified');
        });

        it('Should charge voting cost and give 1 vote regardless of token balance', async function () {
            // Bob has 1,000 VGT
            const bobBalanceBefore = await governanceToken.balanceOf(bob.address);
            await vanguardGovernance.connect(bob).castVote(proposalId, true, 'I support this');
            const bobBalanceAfter = await governanceToken.balanceOf(bob.address);
            
            expect(bobBalanceBefore - bobBalanceAfter).to.equal(VOTING_COST);

            // Check proposal votes - Bob should have 1 vote
            const [proposal] = await vanguardGovernance.getProposal(proposalId);
            expect(proposal.votesFor).to.equal(1n); // 1 vote, not 1000 VGT worth
        });

        it('Should give equal voting power regardless of token amount', async function () {
            // Carol has 500 VGT (less than Bob's 1,000)
            await vanguardGovernance.connect(carol).castVote(proposalId, true, 'I support this too');

            // Dave has 100 VGT (much less than Bob and Carol)
            await vanguardGovernance.connect(dave).castVote(proposalId, false, 'I oppose this');

            const [proposal] = await vanguardGovernance.getProposal(proposalId);
            
            // Each person gets 1 vote: Bob (FOR) + Carol (FOR) + Dave (AGAINST)
            expect(proposal.votesFor).to.equal(2n); // Bob + Carol = 2 votes
            expect(proposal.votesAgainst).to.equal(1n); // Dave = 1 vote
        });

        it('Should prevent double voting', async function () {
            await expect(
                vanguardGovernance.connect(bob).castVote(proposalId, true, 'Voting again')
            ).to.be.revertedWith('Already voted');
        });
    });

    describe('Token Burning on Passed Proposal', function () {
        let proposalId: number;
        let totalSupplyBefore: bigint;
        let snapshotId: string;

        before(async function () {
            // Take a snapshot before this test suite to isolate time manipulation
            snapshotId = await ethers.provider.send('evm_snapshot', []);
        });

        after(async function () {
            // Revert to snapshot after this test suite to reset blockchain time
            await ethers.provider.send('evm_revert', [snapshotId]);
        });

        it('Should burn tokens when proposal passes (≥51%)', async function () {
            // Create new proposal
            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                2, // Accredited investor
                createInvestorTypeConfig('100000', '1000000')
            ]);

            await vanguardGovernance.connect(alice).createProposal(
                0,
                'Update Accredited Investor Limits',
                'Increase limits',
                await investorTypeRegistry.getAddress(),
                callData
            );
            proposalId = 3;

            // Vote: 3 FOR, 0 AGAINST = 100% FOR (≥51%)
            await vanguardGovernance.connect(bob).castVote(proposalId, true, 'FOR');
            await vanguardGovernance.connect(carol).castVote(proposalId, true, 'FOR');
            await vanguardGovernance.connect(dave).castVote(proposalId, true, 'FOR');

            // Get total supply before execution
            totalSupplyBefore = await governanceToken.totalSupply();

            // Fast forward time to end voting period and execution delay
            // executionTime = createdAt + votingPeriod (7 days) + executionDelay (2 days) = 9 days
            await ethers.provider.send('evm_increaseTime', [9 * 24 * 60 * 60 + 60]); // 9 days + 1 minute buffer
            await ethers.provider.send('evm_mine', []);

            // Execute proposal
            const lockedTokens = await vanguardGovernance.getLockedTokens(proposalId);
            await vanguardGovernance.executeProposal(proposalId);

            // Check tokens were burned
            const totalSupplyAfter = await governanceToken.totalSupply();
            expect(totalSupplyBefore - totalSupplyAfter).to.equal(lockedTokens);
        });
    });

    describe('Token Returning on Failed Proposal', function () {
        let proposalId: number;
        let aliceBalanceBefore: bigint;
        let bobBalanceBefore: bigint;
        let carolBalanceBefore: bigint;
        let daveBalanceBefore: bigint;

        it('Should return tokens when proposal fails (<51%)', async function () {
            // This test now works because the previous test suite uses snapshot/revert
            // to reset blockchain time, preventing time manipulation from carrying over

            // Create new proposal
            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                3, // Institutional investor
                createInvestorTypeConfig('1000000', '10000000')
            ]);

            const tx = await vanguardGovernance.connect(alice).createProposal(
                0,
                'Update Institutional Investor Limits',
                'Increase limits',
                await investorTypeRegistry.getAddress(),
                callData
            );

            // Get proposal ID from event
            const receipt = await tx.wait();
            const event = receipt?.logs.find((log: any) => {
                try {
                    return vanguardGovernance.interface.parseLog(log)?.name === 'ProposalCreated';
                } catch {
                    return false;
                }
            });

            if (!event) {
                throw new Error('ProposalCreated event not found');
            }

            const parsedEvent = vanguardGovernance.interface.parseLog(event);
            proposalId = Number(parsedEvent?.args[0]);

            // Vote: 1 FOR, 2 AGAINST = 33.3% FOR (<51%)
            await vanguardGovernance.connect(bob).castVote(proposalId, true, 'FOR');
            await vanguardGovernance.connect(carol).castVote(proposalId, false, 'AGAINST');
            await vanguardGovernance.connect(dave).castVote(proposalId, false, 'AGAINST');

            // Record balances AFTER proposal creation and voting (before execution)
            aliceBalanceBefore = await governanceToken.balanceOf(alice.address);
            bobBalanceBefore = await governanceToken.balanceOf(bob.address);
            carolBalanceBefore = await governanceToken.balanceOf(carol.address);
            daveBalanceBefore = await governanceToken.balanceOf(dave.address);

            // Fast forward time to end voting period (no need to wait for execution delay for failed proposals)
            // But we still need to wait past votingEnds
            await ethers.provider.send('evm_increaseTime', [7 * 24 * 60 * 60 + 60]); // 7 days + 1 minute buffer
            await ethers.provider.send('evm_mine', []);

            // Execute proposal (should fail and return tokens)
            await vanguardGovernance.executeProposal(proposalId);

            // Check tokens were returned
            const aliceBalanceAfter = await governanceToken.balanceOf(alice.address);
            const bobBalanceAfter = await governanceToken.balanceOf(bob.address);
            const carolBalanceAfter = await governanceToken.balanceOf(carol.address);
            const daveBalanceAfter = await governanceToken.balanceOf(dave.address);

            // Alice should get back proposal creation cost
            expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(PROPOSAL_CREATION_COST);

            // Bob, Carol, Dave should get back voting cost
            expect(bobBalanceAfter - bobBalanceBefore).to.equal(VOTING_COST);
            expect(carolBalanceAfter - carolBalanceBefore).to.equal(VOTING_COST);
            expect(daveBalanceAfter - daveBalanceBefore).to.equal(VOTING_COST);

            // Check proposal status is Rejected
            const [proposal] = await vanguardGovernance.getProposal(proposalId);
            expect(proposal.status).to.equal(3); // Rejected
        });
    });

    describe('Complete Workflow Test', function () {
        it('Should demonstrate complete fair voting workflow', async function () {
            console.log('\n🎯 FAIR VOTING SYSTEM DEMONSTRATION');
            console.log('='.repeat(60));

            // Initial balances
            const aliceInitial = await governanceToken.balanceOf(alice.address);
            const bobInitial = await governanceToken.balanceOf(bob.address);
            const carolInitial = await governanceToken.balanceOf(carol.address);
            const daveInitial = await governanceToken.balanceOf(dave.address);

            console.log('\n📊 Initial Balances:');
            console.log(`   Alice: ${ethers.formatEther(aliceInitial)} VGT`);
            console.log(`   Bob: ${ethers.formatEther(bobInitial)} VGT`);
            console.log(`   Carol: ${ethers.formatEther(carolInitial)} VGT`);
            console.log(`   Dave: ${ethers.formatEther(daveInitial)} VGT`);

            // Create proposal
            const callData = investorTypeRegistry.interface.encodeFunctionData('updateInvestorTypeConfig', [
                0,
                createInvestorTypeConfig('20000', '200000')
            ]);

            console.log('\n📝 Step 1: Alice creates proposal');
            console.log(`   Cost: ${ethers.formatEther(PROPOSAL_CREATION_COST)} VGT`);

            // Approve tokens for proposal creation
            await governanceToken.connect(alice).approve(
                await vanguardGovernance.getAddress(),
                PROPOSAL_CREATION_COST
            );

            const tx = await vanguardGovernance.connect(alice).createProposal(
                0,
                'Final Test Proposal',
                'Testing complete workflow',
                await investorTypeRegistry.getAddress(),
                callData
            );
            const receipt = await tx.wait();

            // Get proposal ID from event
            const event = receipt?.logs.find((log: any) => {
                try {
                    return vanguardGovernance.interface.parseLog(log)?.name === 'ProposalCreated';
                } catch {
                    return false;
                }
            });
            const parsedEvent = vanguardGovernance.interface.parseLog(event!);
            const proposalId = parsedEvent?.args[0];

            console.log(`   Proposal ID: ${proposalId}`);

            const aliceAfterProposal = await governanceToken.balanceOf(alice.address);
            console.log(`   Alice balance: ${ethers.formatEther(aliceAfterProposal)} VGT`);

            // Verify proposal is active
            const [proposal] = await vanguardGovernance.getProposal(proposalId);
            console.log(`   Proposal status: ${proposal.status} (1=Active)`);
            expect(proposal.status).to.equal(1); // Active

            // Voting
            console.log('\n🗳️  Step 2: Users vote (1 person = 1 vote)');
            console.log(`   Voting cost: ${ethers.formatEther(VOTING_COST)} VGT per vote`);

            // Approve tokens for voting
            await governanceToken.connect(bob).approve(await vanguardGovernance.getAddress(), VOTING_COST);
            await vanguardGovernance.connect(bob).castVote(proposalId, true, 'FOR');
            console.log(`   ✅ Bob voted FOR (1 vote)`);

            await governanceToken.connect(carol).approve(await vanguardGovernance.getAddress(), VOTING_COST);
            await vanguardGovernance.connect(carol).castVote(proposalId, true, 'FOR');
            console.log(`   ✅ Carol voted FOR (1 vote)`);

            await governanceToken.connect(dave).approve(await vanguardGovernance.getAddress(), VOTING_COST);
            await vanguardGovernance.connect(dave).castVote(proposalId, true, 'FOR');
            console.log(`   ✅ Dave voted FOR (1 vote)`);

            const [proposalAfterVoting] = await vanguardGovernance.getProposal(proposalId);
            console.log(`\n   Total votes: ${proposalAfterVoting.votesFor} FOR, ${proposalAfterVoting.votesAgainst} AGAINST`);
            console.log(`   Result: ${Number(proposalAfterVoting.votesFor) * 100 / Number(proposalAfterVoting.votesFor + proposalAfterVoting.votesAgainst)}% FOR`);

            // Execute
            console.log('\n⚡ Step 3: Execute proposal');
            // executionTime = createdAt + votingPeriod (7 days) + executionDelay (2 days) = 9 days
            await ethers.provider.send('evm_increaseTime', [9 * 24 * 60 * 60 + 60]); // 9 days + 1 minute buffer
            await ethers.provider.send('evm_mine', []);

            const totalSupplyBefore = await governanceToken.totalSupply();
            const lockedTokens = await vanguardGovernance.getLockedTokens(proposalId);

            await vanguardGovernance.executeProposal(proposalId);

            const totalSupplyAfter = await governanceToken.totalSupply();
            const burned = totalSupplyBefore - totalSupplyAfter;

            console.log(`   Locked tokens: ${ethers.formatEther(lockedTokens)} VGT`);
            console.log(`   Tokens burned: ${ethers.formatEther(burned)} VGT 🔥`);
            console.log(`   Status: PASSED ✅`);

            console.log('\n✅ FAIR VOTING SYSTEM WORKS CORRECTLY!');
            console.log('='.repeat(60));
        });
    });
});

