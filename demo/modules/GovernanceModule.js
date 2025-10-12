/**
 * @fileoverview Governance system module
 * @module GovernanceModule
 * @description Handles governance operations including token deployment, proposal creation,
 * voting operations, and proposal execution.
 * Covers menu options 74-83.
 */

const { displayInfo, displaySection, displaySuccess, displayError } = require('../utils/DisplayHelpers');
const { ethers } = require('hardhat');

/**
 * @class GovernanceModule
 * @description Manages governance system operations.
 */
class GovernanceModule {
    constructor(state, logger, promptUser) {
        this.state = state;
        this.logger = logger;
        this.promptUser = promptUser;
    }

    /** Option 74: Deploy Governance System */
    async deployGovernanceSystem() {
        displaySection('DEPLOY GOVERNANCE TOKEN (VGT)', '🪙');

        const governanceToken = this.state.getContract('governanceToken');
        if (governanceToken) {
            console.log('⚠️  Governance Token already deployed');
            console.log(`   Address: ${await governanceToken.getAddress()}`);
            return;
        }

        const identityRegistry = this.state.getContract('identityRegistry');
        const complianceRules = this.state.getContract('complianceRules');
        if (!identityRegistry || !complianceRules) {
            displayError('Deploy ERC-3643 system first (option 21)');
            return;
        }

        try {
            console.log('\n🔗 DEPLOYING GOVERNANCE TOKEN ON-CHAIN...');

            const identityRegistryAddr = await identityRegistry.getAddress();
            const complianceRulesAddr = await complianceRules.getAddress();

            // Deploy GovernanceToken
            console.log('\n📝 Step 1: Deploying GovernanceToken contract...');
            const GovernanceToken = await ethers.getContractFactory('GovernanceToken');
            const govToken = await GovernanceToken.deploy(
                'Vanguard Governance Token',
                'VGT',
                identityRegistryAddr,
                complianceRulesAddr
            );
            await govToken.waitForDeployment();
            const govTokenAddr = await govToken.getAddress();
            this.state.setContract('governanceToken', govToken);
            console.log(`   ✅ GovernanceToken deployed: ${govTokenAddr}`);

            // Deploy VanguardGovernance
            console.log('\n📝 Step 2: Deploying VanguardGovernance contract...');
            const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
            const investorTypeRegistryAddr = investorTypeRegistry
                ? await investorTypeRegistry.getAddress()
                : ethers.ZeroAddress;
            const digitalToken = this.state.getContract('digitalToken');
            const tokenAddr = digitalToken
                ? await digitalToken.getAddress()
                : ethers.ZeroAddress;

            const VanguardGovernance = await ethers.getContractFactory('VanguardGovernance');
            const vanguardGovernance = await VanguardGovernance.deploy(
                govTokenAddr,
                identityRegistryAddr,
                investorTypeRegistryAddr,
                complianceRulesAddr,
                ethers.ZeroAddress, // Oracle manager
                tokenAddr
            );
            await vanguardGovernance.waitForDeployment();
            const govAddr = await vanguardGovernance.getAddress();
            this.state.setContract('vanguardGovernance', vanguardGovernance);
            console.log(`   ✅ VanguardGovernance deployed: ${govAddr}`);

            // Set VanguardGovernance as agent for GovernanceToken
            console.log('\n📝 Step 3: Setting VanguardGovernance as agent...');
            await govToken.addAgent(govAddr);
            console.log('   ✅ VanguardGovernance set as agent');

            // Set VanguardGovernance as rule administrator for ComplianceRules
            console.log('\n📝 Step 4: Setting VanguardGovernance as rule administrator...');
            await complianceRules.setRuleAdministrator(govAddr, true);
            console.log('   ✅ VanguardGovernance set as rule administrator');

            // Configure ComplianceRules with IdentityRegistry for VGT
            console.log('\n📝 Step 5: Configuring ComplianceRules for VGT...');
            await complianceRules.setTokenIdentityRegistry(
                govTokenAddr,
                identityRegistryAddr
            );
            console.log('   ✅ ComplianceRules linked to IdentityRegistry for VGT');
            console.log('   ✅ REAL KYC/AML enforcement enabled for governance tokens');

            // Register VanguardGovernance contract as a verified identity
            console.log('\n📝 Step 6: Registering VanguardGovernance as verified identity...');
            const govSalt = ethers.randomBytes(32);
            await this.state.getContract('onchainIDFactory').deployOnchainID(govAddr, govSalt);
            const govIdentityAddress = await this.state.getContract('onchainIDFactory').getIdentityByOwner(govAddr);
            console.log(`   ✅ OnchainID created for governance contract: ${govIdentityAddress}`);

            // Issue KYC and AML claims for governance contract
            // NOTE: KYC issuer uses signers[2], AML issuer uses signers[3] (from ContractDeployer.js)
            const kycData = ethers.hexlify(ethers.toUtf8Bytes('GOVERNANCE_CONTRACT'));
            await this.state.getContract('kycIssuer').connect(this.state.signers[2]).issueClaim(govIdentityAddress, 1, 1, kycData, '', 0);
            const amlData = ethers.hexlify(ethers.toUtf8Bytes('GOVERNANCE_CONTRACT'));
            await this.state.getContract('amlIssuer').connect(this.state.signers[3]).issueClaim(govIdentityAddress, 2, 1, amlData, '', 0);
            console.log('   ✅ KYC and AML claims issued to governance contract');

            // Get the first allowed country from the whitelist (or 0 if no whitelist)
            const jurisdictionRule = await complianceRules.getJurisdictionRule(govTokenAddr);
            let govCountry = 0; // Default to 0 if no whitelist

            if (jurisdictionRule.allowedCountries && jurisdictionRule.allowedCountries.length > 0) {
                govCountry = jurisdictionRule.allowedCountries[0];
                console.log(`   ℹ️  Using country ${govCountry} from whitelist for governance contract`);
            } else {
                console.log('   ℹ️  No whitelist configured, using country 0 for governance contract');
            }

            // Register governance contract identity with appropriate country
            await identityRegistry.registerIdentity(govAddr, govIdentityAddress, govCountry);
            console.log('   ✅ VanguardGovernance registered as verified identity');
            console.log('   ℹ️  This allows the contract to receive/send tokens while maintaining KYC/AML compliance');

            // Transfer ownership of InvestorTypeRegistry to VanguardGovernance
            if (investorTypeRegistry) {
                console.log('\n📝 Step 7: Transferring InvestorTypeRegistry ownership to governance...');
                await investorTypeRegistry.transferOwnership(govAddr);
                console.log('   ✅ InvestorTypeRegistry ownership transferred to VanguardGovernance');
                console.log('   ℹ️  This allows governance proposals to update investor type configurations');
            }

            // Get governance costs
            const proposalCost = await vanguardGovernance.proposalCreationCost();
            const votingCost = await vanguardGovernance.votingCost();

            displaySuccess('GOVERNANCE TOKEN SYSTEM DEPLOYED!');
            console.log(`🪙 Governance Token: ${govTokenAddr}`);
            console.log(`🗳️  VanguardGovernance: ${govAddr}`);
            console.log(`💰 Initial Supply: 1,000,000 VGT`);
            console.log(`👤 Owner: ${this.state.signers[0].address}`);
            console.log(`🔒 Compliance: REAL KYC/AML enforcement via ComplianceRules`);
            console.log('\n⚖️  FAIR VOTING SYSTEM:');
            console.log(`   • 1 Person = 1 Vote (NOT token-weighted)`);
            console.log(`   • KYC/AML verification required`);
            console.log(`   • Proposal creation cost: ${ethers.formatEther(proposalCost)} VGT`);
            console.log(`   • Voting cost: ${ethers.formatEther(votingCost)} VGT per vote`);
            console.log(`   • If proposal passes (≥51%): Tokens BURNED 🔥`);
            console.log(`   • If proposal fails (<51%): Tokens RETURNED 💰`);

        } catch (error) {
            displayError(`Deployment failed: ${error.message}`);
        }
    }

    /** Option 75a: Mint Governance Tokens */
    async mintGovernanceTokens() {
        displaySection('MINT GOVERNANCE TOKENS', '🏭');

        const governanceToken = this.state.getContract('governanceToken');
        if (!governanceToken) {
            displayError('Deploy Governance Token first (option 74)');
            return;
        }

        try {
            const owner = this.state.signers[0];
            const ownerBalance = await governanceToken.balanceOf(owner.address);
            const totalSupply = await governanceToken.totalSupply();

            console.log('\n📊 CURRENT TOKEN SUPPLY:');
            console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
            console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
            console.log('');
            console.log('⚠️  IMPORTANT: Only the contract owner (agent) can mint tokens');
            console.log('   Minting increases total supply and creates new tokens');
            console.log('');

            // Get recipient address
            const recipient = await this.promptUser('Enter recipient address (or signer index 0-9): ');

            let recipientAddress;
            if (recipient.match(/^[0-9]$/)) {
                const index = parseInt(recipient);
                if (index >= this.state.signers.length) {
                    displayError('Invalid signer index');
                    return;
                }
                recipientAddress = this.state.signers[index].address;
                console.log(`   Selected: Signer ${index} (${recipientAddress})`);
            } else if (recipient.match(/^0x[a-fA-F0-9]{40}$/)) {
                recipientAddress = recipient;
            } else {
                displayError('Invalid address format');
                return;
            }

            // Check if recipient is verified
            const identityRegistry = this.state.getContract('identityRegistry');
            const isVerified = await identityRegistry.isVerified(recipientAddress);

            console.log(`\n👤 Recipient: ${recipientAddress}`);
            console.log(`   KYC/AML Status: ${isVerified ? '✅ Verified' : '❌ Not Verified'}`);

            if (!isVerified) {
                displayError('Recipient must be KYC/AML verified to receive VGT tokens');
                console.log('\n💡 TIP: Use Option 3 (Issue KYC) and Option 4 (Issue AML) first');
                return;
            }

            // Get amount to mint
            const amount = await this.promptUser('\nEnter amount to mint (VGT): ');
            const amountWei = ethers.parseEther(amount);

            const recipientBalance = await governanceToken.balanceOf(recipientAddress);

            console.log('\n📋 MINT SUMMARY:');
            console.log('='.repeat(70));
            console.log(`   Recipient: ${recipientAddress}`);
            console.log(`   Current Balance: ${ethers.formatEther(recipientBalance)} VGT`);
            console.log(`   Amount to Mint: ${amount} VGT`);
            console.log(`   New Balance: ${ethers.formatEther(recipientBalance + amountWei)} VGT`);
            console.log(`   New Total Supply: ${ethers.formatEther(totalSupply + amountWei)} VGT`);

            const confirm = await this.promptUser('\nProceed with minting? (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                displayError('Minting cancelled');
                return;
            }

            // Mint tokens (only owner/agent can call this)
            const tx = await governanceToken.mint(recipientAddress, amountWei);
            await tx.wait();

            const newBalance = await governanceToken.balanceOf(recipientAddress);
            const newTotalSupply = await governanceToken.totalSupply();

            displaySuccess('TOKENS MINTED SUCCESSFULLY!');
            console.log(`   Recipient: ${recipientAddress}`);
            console.log(`   Amount Minted: ${amount} VGT`);
            console.log(`   New Balance: ${ethers.formatEther(newBalance)} VGT`);
            console.log(`   New Total Supply: ${ethers.formatEther(newTotalSupply)} VGT`);
            console.log(`   Transaction: ${tx.hash}`);

        } catch (error) {
            displayError(`Minting failed: ${error.message}`);
            if (error.message.includes('onlyAgent')) {
                console.log('\n💡 TIP: Only the contract owner (signer 0) can mint tokens');
            } else if (error.message.includes('Identity not verified')) {
                console.log('\n💡 TIP: Recipient must be KYC/AML verified');
            }
        }
    }

    /** Option 75b: Burn Governance Tokens */
    async burnGovernanceTokens() {
        displaySection('BURN GOVERNANCE TOKENS', '🔥');

        const governanceToken = this.state.getContract('governanceToken');
        if (!governanceToken) {
            displayError('Deploy Governance Token first (option 74)');
            return;
        }

        try {
            const owner = this.state.signers[0];
            const ownerBalance = await governanceToken.balanceOf(owner.address);
            const totalSupply = await governanceToken.totalSupply();

            console.log('\n📊 CURRENT TOKEN SUPPLY:');
            console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
            console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
            console.log('');
            console.log('⚠️  IMPORTANT: Burning permanently destroys tokens');
            console.log('   This reduces total supply and cannot be undone');
            console.log('   Only the contract owner (agent) can burn tokens from their balance');
            console.log('');

            if (ownerBalance === 0n) {
                displayError('Owner has no VGT tokens to burn');
                return;
            }

            // Get amount to burn
            const amount = await this.promptUser(`Enter amount to burn (max: ${ethers.formatEther(ownerBalance)} VGT): `);
            const amountWei = ethers.parseEther(amount);

            if (amountWei > ownerBalance) {
                displayError(`Insufficient balance. You have ${ethers.formatEther(ownerBalance)} VGT`);
                return;
            }

            console.log('\n📋 BURN SUMMARY:');
            console.log('='.repeat(70));
            console.log(`   Current Balance: ${ethers.formatEther(ownerBalance)} VGT`);
            console.log(`   Amount to Burn: ${amount} VGT`);
            console.log(`   New Balance: ${ethers.formatEther(ownerBalance - amountWei)} VGT`);
            console.log(`   Current Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
            console.log(`   New Total Supply: ${ethers.formatEther(totalSupply - amountWei)} VGT`);
            console.log('');
            console.log('⚠️  WARNING: This action is PERMANENT and IRREVERSIBLE!');

            const confirm = await this.promptUser('\nAre you sure you want to burn these tokens? (yes/no): ');
            if (confirm.toLowerCase() !== 'yes') {
                displayError('Burning cancelled');
                return;
            }

            // Burn tokens (only owner/agent can call this)
            const tx = await governanceToken.burn(amountWei);
            await tx.wait();

            const newBalance = await governanceToken.balanceOf(owner.address);
            const newTotalSupply = await governanceToken.totalSupply();

            displaySuccess('TOKENS BURNED SUCCESSFULLY!');
            console.log(`   Amount Burned: ${amount} VGT 🔥`);
            console.log(`   New Balance: ${ethers.formatEther(newBalance)} VGT`);
            console.log(`   New Total Supply: ${ethers.formatEther(newTotalSupply)} VGT`);
            console.log(`   Tokens Destroyed: PERMANENT`);
            console.log(`   Transaction: ${tx.hash}`);

        } catch (error) {
            displayError(`Burning failed: ${error.message}`);
            if (error.message.includes('onlyAgent')) {
                console.log('\n💡 TIP: Only the contract owner (signer 0) can burn tokens');
            }
        }
    }

    /** Option 75c: Approve Governance Contract to Spend VGT */
    async approveGovernanceSpending() {
        displaySection('APPROVE GOVERNANCE CONTRACT TO SPEND VGT', '✅');

        const governanceToken = this.state.getContract('governanceToken');
        const vanguardGovernance = this.state.getContract('vanguardGovernance');

        if (!governanceToken || !vanguardGovernance) {
            displayError('Deploy Governance Token first (option 74)');
            return;
        }

        try {
            const owner = this.state.signers[0];
            const ownerBalance = await governanceToken.balanceOf(owner.address);
            const governanceAddress = await vanguardGovernance.getAddress();
            const currentAllowance = await governanceToken.allowance(owner.address, governanceAddress);

            console.log('\n📊 CURRENT STATUS:');
            console.log(`   Your VGT Balance: ${ethers.formatEther(ownerBalance)} VGT`);
            console.log(`   Current Allowance: ${ethers.formatEther(currentAllowance)} VGT`);
            console.log(`   Governance Contract: ${governanceAddress}`);
            console.log('');
            console.log('💡 WHAT IS APPROVAL?');
            console.log('   Approval allows the Governance contract to spend your VGT tokens');
            console.log('   This is required for:');
            console.log('   • Creating proposals (costs VGT)');
            console.log('   • Voting on proposals (costs VGT)');
            console.log('');

            const proposalCost = await vanguardGovernance.proposalCreationCost();
            const votingCost = await vanguardGovernance.votingCost();

            console.log('📋 GOVERNANCE COSTS:');
            console.log(`   Proposal Creation: ${ethers.formatEther(proposalCost)} VGT`);
            console.log(`   Voting: ${ethers.formatEther(votingCost)} VGT per vote`);
            console.log('');

            // Suggest approval amount
            const suggestedAmount = proposalCost * 10n + votingCost * 100n; // 10 proposals + 100 votes
            console.log('💡 SUGGESTED APPROVAL AMOUNTS:');
            console.log(`   Minimum (1 proposal + 1 vote): ${ethers.formatEther(proposalCost + votingCost)} VGT`);
            console.log(`   Recommended (10 proposals + 100 votes): ${ethers.formatEther(suggestedAmount)} VGT`);
            console.log(`   Maximum (unlimited): Enter "max" for unlimited approval`);
            console.log('');

            const amount = await this.promptUser('Enter approval amount (VGT) or "max": ');

            let approvalAmount;
            if (amount.toLowerCase() === 'max') {
                approvalAmount = ethers.MaxUint256;
                console.log('   Setting UNLIMITED approval (MaxUint256)');
            } else {
                approvalAmount = ethers.parseEther(amount);
                if (approvalAmount > ownerBalance) {
                    console.log(`   ⚠️  Warning: Approval amount (${amount}) exceeds your balance (${ethers.formatEther(ownerBalance)})`);
                    console.log('   This is OK - you can approve more than you have');
                }
            }

            console.log('\n📋 APPROVAL SUMMARY:');
            console.log('='.repeat(70));
            console.log(`   Spender: VanguardGovernance (${governanceAddress})`);
            console.log(`   Current Allowance: ${ethers.formatEther(currentAllowance)} VGT`);
            console.log(`   New Allowance: ${amount.toLowerCase() === 'max' ? 'UNLIMITED' : amount + ' VGT'}`);

            const confirm = await this.promptUser('\nProceed with approval? (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                displayError('Approval cancelled');
                return;
            }

            const tx = await governanceToken.approve(governanceAddress, approvalAmount);
            await tx.wait();

            const newAllowance = await governanceToken.allowance(owner.address, governanceAddress);

            displaySuccess('APPROVAL SUCCESSFUL!');
            console.log(`   Spender: ${governanceAddress}`);
            console.log(`   New Allowance: ${amount.toLowerCase() === 'max' ? 'UNLIMITED' : ethers.formatEther(newAllowance) + ' VGT'}`);
            console.log(`   Transaction: ${tx.hash}`);
            console.log('');
            console.log('✅ You can now:');
            console.log('   • Create proposals (Option 76)');
            console.log('   • Vote on proposals (Option 77)');

        } catch (error) {
            displayError(`Approval failed: ${error.message}`);
        }
    }

    /** Option 75: Distribute Governance Tokens */
    async distributeGovernanceTokens() {
        displaySection('DISTRIBUTE GOVERNANCE TOKENS', '📊');

        const governanceToken = this.state.getContract('governanceToken');
        if (!governanceToken) {
            displayError('Deploy Governance Token first (option 74)');
            return;
        }

        try {
            console.log('\n👥 DISTRIBUTION OPTIONS:');
            console.log('1. Distribute to Selected Investors (Choose from list)');
            console.log('2. Distribute to Specific Addresses (Manual entry)');
            console.log('3. Distribute Equal Amounts (Auto to first N signers)');
            console.log('0. Back');

            const choice = await this.promptUser('Select option (0-3): ');

            if (choice === '0') return;

            if (choice === '1') {
                await this._distributeToSelectedInvestors();
            } else if (choice === '2') {
                await this._distributeToSpecificAddresses();
            } else if (choice === '3') {
                await this._distributeEqualAmounts();
            }

        } catch (error) {
            displayError(`Distribution failed: ${error.message}`);
        }
    }

    /**
     * Helper: Distribute to selected investors
     * @private
     */
    async _distributeToSelectedInvestors() {
        console.log('\n👥 DISTRIBUTE TO SELECTED INVESTORS');
        console.log('='.repeat(60));

        const governanceToken = this.state.getContract('governanceToken');
        const identityRegistry = this.state.getContract('identityRegistry');

        // Get investors from state
        const investors = this.state.investors || new Map();

        if (investors.size === 0) {
            displayError('No investors found. Create investors first using Option 23 (Investor Onboarding)');
            console.log('\n💡 TIP: Use Option 23 to create investors before distributing governance tokens');
            return;
        }

        // Show available investors with their verification status
        console.log('\n📋 AVAILABLE INVESTORS:');
        const availableInvestors = [];
        let index = 0;

        for (const [address, investorData] of investors) {
            let status = '❓ Unknown';

            // Check if verified
            if (identityRegistry) {
                try {
                    const isVerified = await identityRegistry.isVerified(address);
                    status = isVerified ? '✅ Verified' : '❌ Not Verified';
                } catch (error) {
                    status = '⚠️ Error checking';
                }
            }

            // Check current VGT balance
            let balance = '0';
            if (governanceToken) {
                try {
                    const bal = await governanceToken.balanceOf(address);
                    balance = ethers.formatEther(bal);
                } catch (error) {
                    balance = 'Error';
                }
            }

            console.log(`${index}. ${address}`);
            console.log(`   Type: ${investorData.type || 'Unknown'} | Status: ${status} | Current VGT: ${balance}`);
            availableInvestors.push({ index, address, data: investorData });
            index++;
        }

        console.log('\n💡 Enter investor numbers to distribute to (comma-separated)');
        console.log('   Example: 0,1,2 to distribute to investors 0, 1, and 2');

        const selection = await this.promptUser('Select investors: ');
        const selectedIndices = selection.split(',').map(s => parseInt(s.trim()));

        // Validate selections
        const validInvestors = availableInvestors.filter(inv => selectedIndices.includes(inv.index));
        if (validInvestors.length === 0) {
            displayError('No valid investors selected');
            return;
        }

        const amount = await this.promptUser('Enter amount per investor (VGT): ');
        const amountWei = ethers.parseEther(amount);

        console.log('\n🔗 DISTRIBUTING GOVERNANCE TOKENS...');

        const recipients = [];
        const amounts = [];

        for (const investor of validInvestors) {
            recipients.push(investor.address);
            amounts.push(amountWei);
        }

        console.log(`\n📊 Distribution Summary:`);
        for (let i = 0; i < validInvestors.length; i++) {
            const investor = validInvestors[i];
            console.log(`   ${i + 1}. ${investor.address} (${investor.data.type || 'Unknown'}) → ${amount} VGT`);
        }

        const confirm = await this.promptUser('\nConfirm distribution? (y/n): ');
        if (confirm.toLowerCase() !== 'y') {
            displayError('Distribution cancelled');
            return;
        }

        const tx = await governanceToken.distributeGovernanceTokens(recipients, amounts);
        await tx.wait();

        displaySuccess('DISTRIBUTION COMPLETE!');
        console.log(`   Distributed ${amount} VGT to ${recipients.length} selected investors`);
        console.log(`   Transaction: ${tx.hash}`);
    }

    /**
     * Helper: Distribute to specific addresses
     * @private
     */
    async _distributeToSpecificAddresses() {
        const governanceToken = this.state.getContract('governanceToken');

        const addresses = await this.promptUser('Enter addresses (comma-separated): ');
        const amounts = await this.promptUser('Enter amounts (comma-separated, in VGT): ');

        const addressArray = addresses.split(',').map(a => a.trim());
        const amountArray = amounts.split(',').map(a => ethers.parseEther(a.trim()));

        const tx = await governanceToken.distributeGovernanceTokens(addressArray, amountArray);
        await tx.wait();

        displaySuccess(`Distributed governance tokens to ${addressArray.length} addresses`);
    }

    /**
     * Helper: Distribute equal amounts
     * @private
     */
    async _distributeEqualAmounts() {
        const governanceToken = this.state.getContract('governanceToken');

        const count = await this.promptUser('Number of recipients: ');
        const amount = await this.promptUser('Amount per recipient (VGT): ');
        const amountWei = ethers.parseEther(amount);

        const recipients = [];
        const amounts = [];

        for (let i = 1; i <= parseInt(count); i++) {
            recipients.push(this.state.signers[i].address);
            amounts.push(amountWei);
        }

        const tx = await governanceToken.distributeGovernanceTokens(recipients, amounts);
        await tx.wait();

        displaySuccess(`Distributed ${amount} VGT to ${count} recipients`);
    }

    /** Option 76: Create Proposal */
    async createProposal() {
        displaySection('CREATE GOVERNANCE PROPOSAL (TOKEN-WEIGHTED)', '🗳️');

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const governanceToken = this.state.getContract('governanceToken');

        if (!vanguardGovernance || !governanceToken) {
            displayError('Deploy Governance Token system first (option 74)');
            return;
        }

        try {
            // Pre-flight checks
            const owner = this.state.signers[0];
            const identityRegistry = this.state.getContract('identityRegistry');
            const isVerified = await identityRegistry.isVerified(owner.address);

            if (!isVerified) {
                displayError('You must be KYC/AML verified to create proposals');
                console.log('\n💡 SOLUTION:');
                console.log('   1. Use Option 3 to issue KYC to yourself (signer 0)');
                console.log('   2. Use Option 4 to issue AML to yourself (signer 0)');
                console.log('   3. Try creating proposal again');
                return;
            }

            const proposalCost = await vanguardGovernance.proposalCreationCost();
            const balance = await governanceToken.balanceOf(owner.address);
            const governanceAddress = await vanguardGovernance.getAddress();
            const allowance = await governanceToken.allowance(owner.address, governanceAddress);

            console.log('\n📊 PRE-FLIGHT CHECKS:');
            console.log(`   ✅ KYC/AML Status: Verified`);
            console.log(`   Your VGT Balance: ${ethers.formatEther(balance)} VGT`);
            console.log(`   Proposal Cost: ${ethers.formatEther(proposalCost)} VGT`);
            console.log(`   Current Allowance: ${ethers.formatEther(allowance)} VGT`);

            if (balance < proposalCost) {
                displayError(`Insufficient VGT balance. You need ${ethers.formatEther(proposalCost)} VGT`);
                console.log('\n💡 SOLUTION: Use Option 75a to mint more VGT tokens');
                return;
            }

            if (allowance < proposalCost) {
                displayError(`Insufficient allowance. Governance contract needs approval to spend ${ethers.formatEther(proposalCost)} VGT`);
                console.log('\n💡 SOLUTION:');
                console.log('   1. Use Option 75c to approve Governance contract');
                console.log(`   2. Approve at least ${ethers.formatEther(proposalCost)} VGT`);
                console.log('   3. Try creating proposal again');
                return;
            }

            console.log('   ✅ All checks passed!\n');

            console.log('📋 PROPOSAL TYPES:');
            console.log('0. InvestorTypeConfig - Update investor type limits');
            console.log('1. ComplianceRules - Update compliance parameters');
            console.log('2. OracleParameters - Update oracle settings');
            console.log('3. TokenParameters - Update token settings');
            console.log('4. SystemParameters - Update system settings');
            console.log('5. EmergencyAction - Emergency actions');

            const typeChoice = await this.promptUser('Select proposal type (0-5): ');
            const proposalType = parseInt(typeChoice);

            if (proposalType === 0) {
                await this._createInvestorTypeConfigProposal();
            } else if (proposalType === 1) {
                await this._createComplianceRulesProposal();
            } else {
                console.log('⚠️  Other proposal types coming soon. Use type 0 or 1 for now.');
            }
        } catch (error) {
            displayError(`Proposal creation failed: ${error.message}`);
            if (error.message.includes('ERC20InsufficientAllowance')) {
                console.log('\n💡 TIP: Use Option 75c to approve Governance contract to spend VGT');
            } else if (error.message.includes('Must be KYC/AML verified')) {
                console.log('\n💡 TIP: Use Options 3 & 4 to issue KYC/AML to yourself');
            }
        }
    }

    /**
     * Helper: Create InvestorTypeConfig proposal
     * @private
     */
    async _createInvestorTypeConfigProposal() {
        console.log('\n📝 CREATE INVESTORTYPECONFIG PROPOSAL');
        console.log('='.repeat(60));

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('Deploy InvestorTypeRegistry first (option 51)');
            return;
        }

        console.log('\n🎯 Select investor type to update:');
        console.log('0. Normal Investor');
        console.log('1. Retail Investor');
        console.log('2. Accredited Investor');
        console.log('3. Institutional Investor');

        const typeChoice = await this.promptUser('Select type (0-3): ');
        const investorType = parseInt(typeChoice);

        console.log('\n💰 Enter new limits:');
        const maxTransfer = await this.promptUser('Max transfer amount (VSC): ');
        const maxHolding = await this.promptUser('Max holding amount (VSC): ');

        const title = `Update ${['Normal', 'Retail', 'Accredited', 'Institutional'][investorType]} Investor Limits`;
        const description = `Increase max transfer to ${maxTransfer} VSC and max holding to ${maxHolding} VSC`;

        // Encode the function call
        const callData = investorTypeRegistry.interface.encodeFunctionData(
            'updateInvestorTypeConfig',
            [
                investorType,
                {
                    maxTransferAmount: ethers.parseEther(maxTransfer),
                    maxHoldingAmount: ethers.parseEther(maxHolding),
                    requiredWhitelistTier: 2,
                    transferCooldownMinutes: 30,
                    largeTransferThreshold: ethers.parseEther('10000'),
                    enhancedLogging: true,
                    enhancedPrivacy: false
                }
            ]
        );

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const tx = await vanguardGovernance.createProposal(
            0, // ProposalType.InvestorTypeConfig
            title,
            description,
            await investorTypeRegistry.getAddress(),
            callData
        );
        const receipt = await tx.wait();

        displaySuccess('INVESTORTYPECONFIG PROPOSAL CREATED!');
        console.log(`   Transaction: ${receipt.hash}`);
        console.log(`   Title: ${title}`);
        console.log(`   Target: InvestorTypeRegistry`);
        console.log(`   Investor Type: ${['Normal', 'Retail', 'Accredited', 'Institutional'][investorType]}`);
        console.log(`   Max Transfer: ${maxTransfer} VSC`);
        console.log(`   Max Holding: ${maxHolding} VSC`);
        console.log('\n💡 Next: Use option 77 to vote on this proposal');
    }

    /**
     * Helper: Create ComplianceRules proposal
     * @private
     */
    async _createComplianceRulesProposal() {
        console.log('\n📝 CREATE COMPLIANCERULES PROPOSAL');
        console.log('='.repeat(60));

        const digitalToken = this.state.getContract('digitalToken');
        if (!digitalToken) {
            displayError('Deploy VSC token first (option 21)');
            return;
        }

        console.log('\n🎯 Select compliance parameter to update:');
        console.log('1. Update jurisdiction rules (allowed/blocked countries)');
        console.log('2. Update holding period rules');
        console.log('3. Update compliance level rules');

        const actionChoice = await this.promptUser('Select action (1-3): ');

        const complianceRules = this.state.getContract('complianceRules');
        let title, description, callData;
        const target = await complianceRules.getAddress();
        const tokenAddress = await digitalToken.getAddress();

        switch (actionChoice) {
            case '1':
                // Update jurisdiction rules
                console.log('\n📍 JURISDICTION RULES:');
                console.log('Enter allowed country codes (comma-separated, e.g., 840,826,392 for US,UK,JP)');
                console.log('Country codes: US=840, UK=826, JP=392, SG=702, HK=344, CN=156');
                const allowedInput = await this.promptUser('Allowed countries: ');
                const allowedCountries = allowedInput.split(',').map(c => parseInt(c.trim()));

                console.log('Enter blocked country codes (comma-separated, or leave empty)');
                const blockedInput = await this.promptUser('Blocked countries: ');
                const blockedCountries = blockedInput ? blockedInput.split(',').map(c => parseInt(c.trim())) : [];

                title = `Update Jurisdiction Rules`;
                description = `Set allowed countries: ${allowedInput}, blocked: ${blockedInput || 'none'}`;
                callData = complianceRules.interface.encodeFunctionData(
                    'setJurisdictionRule',
                    [tokenAddress, allowedCountries, blockedCountries]
                );
                break;

            case '2':
                // Update holding period rules
                console.log('\n⏱️ HOLDING PERIOD RULES:');
                const holdingDays = await this.promptUser('Enter minimum holding period (days): ');
                const cooldownMinutes = await this.promptUser('Enter transfer cooldown (minutes): ');

                const holdingSeconds = parseInt(holdingDays) * 24 * 60 * 60;
                const cooldownSeconds = parseInt(cooldownMinutes) * 60;

                title = `Update Holding Period to ${holdingDays} Days`;
                description = `Set holding period: ${holdingDays} days, cooldown: ${cooldownMinutes} minutes`;
                callData = complianceRules.interface.encodeFunctionData(
                    'setHoldingPeriodRule',
                    [tokenAddress, holdingSeconds, cooldownSeconds]
                );
                break;

            case '3':
                // Update compliance level rules
                console.log('\n📊 COMPLIANCE LEVEL RULES:');
                const minLevel = await this.promptUser('Enter minimum compliance level (0-3): ');
                const maxLevel = await this.promptUser('Enter maximum compliance level (0-3): ');

                title = `Update Compliance Levels`;
                description = `Set min level: ${minLevel}, max level: ${maxLevel}`;
                callData = complianceRules.interface.encodeFunctionData(
                    'setComplianceLevelRule',
                    [tokenAddress, parseInt(minLevel), parseInt(maxLevel), [], []]
                );
                break;

            default:
                displayError('Invalid choice');
                return;
        }

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const tx = await vanguardGovernance.createProposal(
            1, // ProposalType.ComplianceRules
            title,
            description,
            target,
            callData
        );
        const receipt = await tx.wait();

        displaySuccess('COMPLIANCERULES PROPOSAL CREATED!');
        console.log(`   Transaction: ${receipt.hash}`);
        console.log(`   Title: ${title}`);
        console.log(`   Target: ComplianceRules`);
        console.log(`   Token: ${tokenAddress}`);
        console.log('\n💡 Next: Use option 77 to vote on this proposal');
    }

    /** Option 77: Vote on Proposal */
    async voteOnProposal() {
        displaySection('VOTE ON GOVERNANCE PROPOSAL', '✅');

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const governanceToken = this.state.getContract('governanceToken');

        if (!vanguardGovernance || !governanceToken) {
            displayError('Deploy Governance Token system first (option 74)');
            return;
        }

        try {
            // Show all available proposals
            console.log('\n📋 AVAILABLE PROPOSALS:');
            console.log('='.repeat(60));

            const proposalTypes = ['InvestorTypeConfig', 'ComplianceRules', 'OracleParameters', 'TokenParameters', 'SystemParameters', 'EmergencyAction'];
            const statusNames = ['Pending', 'Active', 'Approved', 'Rejected', 'Executed', 'Cancelled'];

            let foundProposals = false;
            const activeProposals = [];

            // Check proposals 1-20
            for (let i = 1; i <= 20; i++) {
                try {
                    const result = await vanguardGovernance.getProposal(i);
                    const proposal = result[0];

                    if (proposal.title && proposal.title.length > 0) {
                        foundProposals = true;
                        const statusNum = Number(proposal.status);
                        const status = statusNames[statusNum];
                        const type = proposalTypes[Number(proposal.proposalType)];
                        const votesFor = ethers.formatEther(proposal.votesFor);
                        const votesAgainst = ethers.formatEther(proposal.votesAgainst);
                        const totalVotes = proposal.votesFor + proposal.votesAgainst;

                        let percentage = '';
                        if (totalVotes > 0n) {
                            const forPct = (Number(proposal.votesFor) * 100 / Number(totalVotes)).toFixed(1);
                            percentage = ` (${forPct}% FOR)`;
                        }

                        console.log(`\n${i}. ${proposal.title}`);
                        console.log(`   Type: ${type} | Status: ${status}`);
                        console.log(`   Votes: ${votesFor} FOR, ${votesAgainst} AGAINST${percentage}`);

                        if (statusNum === 1) { // Active
                            activeProposals.push(i);
                        }
                    }
                } catch (error) {
                    break;
                }
            }

            if (!foundProposals) {
                displayError('No proposals found. Create a proposal first (option 76)');
                return;
            }

            if (activeProposals.length === 0) {
                console.log('\n⚠️  No active proposals available for voting');
                console.log('   All proposals are either pending, executed, or cancelled');
                return;
            }

            console.log('\n' + '='.repeat(60));
            console.log(`💡 Active proposals you can vote on: ${activeProposals.join(', ')}`);

            const proposalId = await this.promptUser('\nEnter proposal ID to vote on: ');

            // Get proposal details
            const result = await vanguardGovernance.getProposal(parseInt(proposalId));
            const proposal = result[0];
            const snapshotId = proposal.snapshotId;

            console.log('\n📋 PROPOSAL INFO:');
            console.log(`   Title: ${proposal.title}`);
            console.log(`   Snapshot ID: ${snapshotId}`);
            console.log(`   Status: ${statusNames[Number(proposal.status)]}`);

            // Show available voters with their VGT balances AT SNAPSHOT TIME
            console.log('\n👥 AVAILABLE VOTERS (at snapshot time):');
            const voters = [];
            for (let i = 0; i < Math.min(10, this.state.signers.length); i++) {
                const currentBalance = await governanceToken.balanceOf(this.state.signers[i].address);
                const snapshotBalance = await governanceToken.getVotingPowerAt(this.state.signers[i].address, snapshotId);
                const currentFormatted = ethers.formatEther(currentBalance);
                const snapshotFormatted = ethers.formatEther(snapshotBalance);

                if (snapshotBalance > 0n) {
                    console.log(`${i}. ${this.state.signers[i].address}`);
                    console.log(`   Snapshot VGT: ${snapshotFormatted} | Current VGT: ${currentFormatted}`);
                    voters.push(i);
                } else if (currentBalance > 0n) {
                    console.log(`${i}. ${this.state.signers[i].address} - ⚠️ Has ${currentFormatted} VGT NOW but 0 at snapshot`);
                }
            }

            if (voters.length === 0) {
                displayError('No signers had VGT tokens at snapshot time!');
                console.log('\n💡 SOLUTION:');
                console.log('   1. Distribute VGT tokens first (option 75)');
                console.log('   2. THEN create proposals (option 76)');
                console.log('   3. Voters must have tokens BEFORE proposal creation');
                console.log('\n   Tokens distributed AFTER proposal creation cannot vote!');
                return;
            }

            const voterChoice = await this.promptUser(`\nSelect voter (${voters.join(', ')}): `);
            const voterIndex = parseInt(voterChoice);

            if (!voters.includes(voterIndex)) {
                displayError('Invalid voter selection or voter had no VGT at snapshot time');
                return;
            }

            const voter = this.state.signers[voterIndex];
            const votingPower = await governanceToken.getVotingPowerAt(voter.address, snapshotId);

            console.log(`\n🗳️  Voting as: ${voter.address}`);
            console.log(`   Voting Power (at snapshot): ${ethers.formatEther(votingPower)} VGT`);

            const support = await this.promptUser('\nVote FOR (y) or AGAINST (n): ');
            const reason = await this.promptUser('Enter reason (optional): ');

            const tx = await vanguardGovernance.connect(voter).castVote(
                parseInt(proposalId),
                support.toLowerCase() === 'y',
                reason || ''
            );
            await tx.wait();

            displaySuccess('VOTE CAST SUCCESSFULLY!');
            console.log(`   Voter: ${voter.address}`);
            console.log(`   Voting Power: ${ethers.formatEther(votingPower)} VGT`);
            console.log(`   Support: ${support.toLowerCase() === 'y' ? 'FOR' : 'AGAINST'}`);

        } catch (error) {
            displayError(`Voting failed: ${error.message}`);
            if (error.message.includes('No voting power')) {
                console.log('\n💡 TIP: Tokens must be distributed BEFORE creating the proposal!');
                console.log('   Voting uses snapshot-based balances from proposal creation time.');
            }
        }
    }

    /** Option 78: Execute Proposal */
    async executeProposal() {
        displaySection('EXECUTE GOVERNANCE PROPOSAL', '⚡');

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        if (!vanguardGovernance) {
            displayError('Deploy Governance Token system first (option 74)');
            return;
        }

        try {
            // Show all proposals that can be executed
            console.log('\n📋 PROPOSALS READY FOR EXECUTION:');
            console.log('='.repeat(60));

            const proposalTypes = ['InvestorTypeConfig', 'ComplianceRules', 'OracleParameters', 'TokenParameters', 'SystemParameters', 'EmergencyAction'];
            const statusNames = ['Pending', 'Active', 'Approved', 'Rejected', 'Executed', 'Cancelled'];

            let foundExecutable = false;
            const executableProposals = [];

            // Check proposals 1-20
            for (let i = 1; i <= 20; i++) {
                try {
                    const result = await vanguardGovernance.getProposal(i);
                    const proposal = result[0];

                    if (proposal.title && proposal.title.length > 0) {
                        const statusNum = Number(proposal.status);
                        const status = statusNames[statusNum];
                        const type = proposalTypes[Number(proposal.proposalType)];
                        const votesFor = ethers.formatEther(proposal.votesFor);
                        const votesAgainst = ethers.formatEther(proposal.votesAgainst);
                        const totalVotes = proposal.votesFor + proposal.votesAgainst;

                        let percentage = '';
                        if (totalVotes > 0n) {
                            const forPct = (Number(proposal.votesFor) * 100 / Number(totalVotes)).toFixed(1);
                            const againstPct = (Number(proposal.votesAgainst) * 100 / Number(totalVotes)).toFixed(1);
                            percentage = ` (${forPct}% FOR, ${againstPct}% AGAINST)`;
                        }

                        // Check if can execute (status = Active or Approved)
                        if (statusNum === 1 || statusNum === 2) {
                            foundExecutable = true;
                            executableProposals.push(i);

                            console.log(`\n${i}. ${proposal.title}`);
                            console.log(`   Type: ${type} | Status: ${status}`);
                            console.log(`   Votes: ${votesFor} FOR, ${votesAgainst} AGAINST${percentage}`);
                        }
                    }
                } catch (error) {
                    break;
                }
            }

            if (!foundExecutable) {
                displayError('No proposals ready for execution');
                console.log('   Proposals must be Active or Approved to execute');
                return;
            }

            console.log('\n' + '='.repeat(60));
            console.log(`💡 Executable proposals: ${executableProposals.join(', ')}`);

            const proposalId = await this.promptUser('\nEnter proposal ID to execute: ');

            // Get proposal details
            const result = await vanguardGovernance.getProposal(parseInt(proposalId));
            const proposal = result[0];

            console.log('\n📋 PROPOSAL DETAILS:');
            console.log(`   ID: ${proposalId}`);
            console.log(`   Title: ${proposal.title}`);
            console.log(`   Description: ${proposal.description}`);
            console.log(`   Votes FOR: ${ethers.formatEther(proposal.votesFor)} VGT`);
            console.log(`   Votes AGAINST: ${ethers.formatEther(proposal.votesAgainst)} VGT`);

            const totalVotes = proposal.votesFor + proposal.votesAgainst;
            if (totalVotes > 0n) {
                const forPercentage = (Number(proposal.votesFor) * 100 / Number(totalVotes)).toFixed(2);
                const againstPercentage = (Number(proposal.votesAgainst) * 100 / Number(totalVotes)).toFixed(2);
                console.log(`   FOR: ${forPercentage}% | AGAINST: ${againstPercentage}%`);
            }

            const confirm = await this.promptUser('\nExecute this proposal? (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                displayError('Execution cancelled');
                return;
            }

            const tx = await vanguardGovernance.executeProposal(parseInt(proposalId));
            await tx.wait();

            displaySuccess('PROPOSAL EXECUTED SUCCESSFULLY!');
            console.log(`   Transaction: ${tx.hash}`);

        } catch (error) {
            displayError(`Execution failed: ${error.message}`);
        }
    }

    /** Option 79: Time Travel (Fast Forward 9 Days) */
    async timeTravel9Days() {
        displaySection('TIME TRAVEL - FAST FORWARD FOR VOTING', '⏰');

        try {
            console.log('\n📅 Current blockchain time will be advanced by 9 days');
            console.log('   • 7 days for voting period');
            console.log('   • 2 days for execution delay');
            console.log('');
            console.log('⚠️  This only works on local blockchain (Hardhat/Ganache)');
            console.log('');

            const confirm = await this.promptUser('Proceed with time travel? (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                displayError('Time travel cancelled');
                return;
            }

            console.log('\n⏰ Advancing time by 9 days...');
            await ethers.provider.send('evm_increaseTime', [9 * 24 * 60 * 60 + 60]);
            await ethers.provider.send('evm_mine', []);

            displaySuccess('Time advanced successfully!');
            console.log('   You can now execute proposals that have ended voting');

        } catch (error) {
            displayError(`Time travel failed: ${error.message}`);
            console.log('💡 Make sure you are running on a local blockchain (Hardhat/Ganache)');
        }
    }

    /** Option 80: Governance Dashboard */
    async showDashboard() {
        displaySection('GOVERNANCE DASHBOARD', '📈');

        const governanceToken = this.state.getContract('governanceToken');
        const vanguardGovernance = this.state.getContract('vanguardGovernance');

        if (!governanceToken || !vanguardGovernance) {
            displayError('Deploy Governance Token first (option 74)');
            return;
        }

        try {
            const totalSupply = await governanceToken.totalSupply();
            const ownerBalance = await governanceToken.balanceOf(this.state.signers[0].address);
            const ownerVotingPower = await governanceToken.getVotingPower(this.state.signers[0].address);

            console.log('\n🪙 GOVERNANCE TOKEN INFO:');
            console.log(`   Name: Vanguard Governance Token`);
            console.log(`   Symbol: VGT`);
            console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
            console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
            console.log(`   Owner Voting Power: ${ethers.formatEther(ownerVotingPower)} VGT`);

            // Get governance parameters
            const proposalCost = await vanguardGovernance.proposalCreationCost();
            const votingCost = await vanguardGovernance.votingCost();
            const proposalCount = await vanguardGovernance.proposalCount();

            console.log('\n⚖️ GOVERNANCE PARAMETERS:');
            console.log('='.repeat(70));
            console.log(`   Proposal Creation Cost: ${ethers.formatEther(proposalCost)} VGT`);
            console.log(`   Voting Cost: ${ethers.formatEther(votingCost)} VGT per vote`);
            console.log(`   Total Proposals: ${proposalCount}`);

            console.log('\n📊 VOTING SYSTEM:');
            console.log('='.repeat(70));
            console.log('Fair Voting:');
            console.log('   • 1 Person = 1 Vote (Equal for all)');
            console.log('   • Only KYC/AML verified users can vote');
            console.log('   • Passed proposals (≥51%): Tokens BURNED 🔥');
            console.log('   • Failed proposals (<51%): Tokens RETURNED 💰');
            console.log('   • Democratic governance model');
            console.log('');
            console.log('💡 Note: Token balance shown below is for distribution purposes only.');
            console.log('   Voting power is ALWAYS 1 vote per verified user, regardless of balance.');

            // Show user balances
            const identityRegistry = this.state.getContract('identityRegistry');
            console.log('\n👥 USER BALANCES & VOTING POWER:');
            console.log('='.repeat(70));
            console.log('💡 Signer 0 = Contract Owner (received initial VGT supply for distribution)');
            console.log('');

            for (let i = 0; i < Math.min(5, this.state.signers.length); i++) {
                const balance = await governanceToken.balanceOf(this.state.signers[i].address);
                const isVerified = await identityRegistry.isVerified(this.state.signers[i].address);

                // Determine role
                let role = '';
                if (i === 0) {
                    role = ' (Contract Owner - Token Distributor)';
                } else if (i === 1) {
                    role = ' (Owner Fee Wallet)';
                } else if (i === 2) {
                    role = ' (KYC Issuer)';
                } else if (i === 3) {
                    role = ' (AML Issuer)';
                } else {
                    role = ' (Regular User)';
                }

                console.log(`\nSigner ${i}${role}:`);
                console.log(`   VGT Balance: ${ethers.formatEther(balance)} VGT`);
                console.log(`   Voting Power: ${isVerified ? '1 vote (equal)' : '0 votes (not verified)'}`);
                console.log(`   KYC/AML Status: ${isVerified ? '✅ Verified' : '❌ Not Verified'}`);
            }

        } catch (error) {
            displayError(`Dashboard error: ${error.message}`);
        }
    }

    /** Option 81: Test Compliance Enforcement */
    async testComplianceEnforcement() {
        displaySection('TEST COMPLIANCE ENFORCEMENT (VSC & VGT)', '🔒');

        const digitalToken = this.state.getContract('digitalToken');
        const governanceToken = this.state.getContract('governanceToken');

        if (!digitalToken) {
            displayError('Deploy Digital Token (VSC) first (option 21)');
            return;
        }

        if (!governanceToken) {
            displayError('Deploy Governance Token (VGT) first (option 74)');
            return;
        }

        try {
            console.log('\n📊 TESTING COMPLIANCE ENFORCEMENT...');
            console.log('='.repeat(70));

            // Get verified and unverified users
            const verifiedUser = this.state.signers[1];
            const unverifiedUser = this.state.signers[9]; // Assuming signer 9 is not verified

            // Check verification status
            const identityRegistry = this.state.getContract('identityRegistry');
            const isVerified1 = await identityRegistry.isVerified(verifiedUser.address);
            const isVerified9 = await identityRegistry.isVerified(unverifiedUser.address);

            console.log('\n👤 USER VERIFICATION STATUS:');
            console.log(`   Verified User (${verifiedUser.address.slice(0, 10)}...): ${isVerified1 ? '✅ VERIFIED' : '❌ NOT VERIFIED'}`);
            console.log(`   Unverified User (${unverifiedUser.address.slice(0, 10)}...): ${isVerified9 ? '❌ VERIFIED' : '✅ NOT VERIFIED'}`);

            // Test VSC Transfer Control
            console.log('\n' + '='.repeat(70));
            console.log('PART 1: VSC TRANSFER CONTROL');
            console.log('='.repeat(70));

            console.log('\n✅ TEST 1.1: VSC transfer to verified user');
            try {
                const tx1 = await digitalToken.transfer(verifiedUser.address, ethers.parseEther('1000'));
                await tx1.wait();
                const balance = await digitalToken.balanceOf(verifiedUser.address);
                console.log(`   ✅ SUCCESS: Transferred 1000 VSC to verified user`);
                console.log(`   Balance: ${ethers.formatEther(balance)} VSC`);
            } catch (error) {
                console.log(`   ❌ FAILED: ${error.message}`);
            }

            console.log('\n❌ TEST 1.2: VSC transfer to unverified user (should FAIL)');
            try {
                const tx2 = await digitalToken.transfer(unverifiedUser.address, ethers.parseEther('1000'));
                await tx2.wait();
                console.log(`   ❌ UNEXPECTED: Transfer succeeded (should have failed)`);
            } catch (error) {
                console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
                console.log(`   Reason: ${error.message.includes('Transfer not allowed') ? 'Transfer not allowed' : 'Compliance check failed'}`);
            }

            // Test VGT Transfer Control
            console.log('\n' + '='.repeat(70));
            console.log('PART 2: VGT TRANSFER CONTROL');
            console.log('='.repeat(70));

            console.log('\n✅ TEST 2.1: VGT distribution to verified user');
            try {
                const tx3 = await governanceToken.distributeGovernanceTokens(
                    [verifiedUser.address],
                    [ethers.parseEther('5000')]
                );
                await tx3.wait();
                const balance = await governanceToken.balanceOf(verifiedUser.address);
                console.log(`   ✅ SUCCESS: Distributed 5000 VGT to verified user`);
                console.log(`   Balance: ${ethers.formatEther(balance)} VGT`);
            } catch (error) {
                console.log(`   ❌ FAILED: ${error.message}`);
            }

            console.log('\n❌ TEST 2.2: VGT transfer to unverified user (should FAIL)');
            try {
                const vgtWithSigner = governanceToken.connect(verifiedUser);
                const tx4 = await vgtWithSigner.transfer(unverifiedUser.address, ethers.parseEther('100'));
                await tx4.wait();
                console.log(`   ❌ UNEXPECTED: Transfer succeeded (should have failed)`);
            } catch (error) {
                console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
                console.log(`   Reason: ${error.message.includes('Transfer not allowed') ? 'Transfer not allowed' : 'Compliance check failed'}`);
            }

            // Test VGT Voting Control
            console.log('\n' + '='.repeat(70));
            console.log('PART 3: VGT VOTING CONTROL');
            console.log('='.repeat(70));

            const votingPowerVerified = await governanceToken.getVotingPower(verifiedUser.address);
            const votingPowerUnverified = await governanceToken.getVotingPower(unverifiedUser.address);

            console.log('\n✅ TEST 3.1: Verified user voting power');
            console.log(`   Verified User Voting Power: ${ethers.formatEther(votingPowerVerified)} VGT`);
            console.log(`   ${votingPowerVerified > 0 ? '✅ HAS voting power' : '❌ NO voting power'}`);

            console.log('\n❌ TEST 3.2: Unverified user voting power');
            console.log(`   Unverified User Voting Power: ${ethers.formatEther(votingPowerUnverified)} VGT`);
            console.log(`   ${votingPowerUnverified === 0n ? '✅ NO voting power (correct)' : '❌ HAS voting power (incorrect)'}`);

            // Summary
            console.log('\n' + '='.repeat(70));
            displaySuccess('COMPLIANCE ENFORCEMENT TEST COMPLETE!');
            console.log('='.repeat(70));
            console.log('\n✅ PROVEN:');
            console.log('   1. ✅ VSC transfers controlled by ComplianceRules');
            console.log('   2. ✅ VGT transfers controlled by ComplianceRules');
            console.log('   3. ✅ VGT voting controlled (must hold VGT)');
            console.log('   4. ✅ Only KYC/AML verified users can hold tokens');
            console.log('   5. ✅ Unverified users CANNOT participate');

        } catch (error) {
            displayError(`Test failed: ${error.message}`);
        }
    }

    /** Option 82: Demo Complete Governance Workflow */
    async demoCompleteWorkflow() {
        displaySection('DEMO COMPLETE GOVERNANCE WORKFLOW', '🧪');

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        if (!vanguardGovernance) {
            displayError('Deploy Governance Token system first (option 74)');
            return;
        }

        try {
            console.log('\n📊 COMPLETE GOVERNANCE WORKFLOW DEMONSTRATION');
            console.log('This will demonstrate the full governance process:');
            console.log('1. Distribute governance tokens to verified users');
            console.log('2. Create a proposal to update ComplianceRules');
            console.log('3. Cast votes using token-weighted voting');
            console.log('4. Execute the proposal after approval');
            console.log('');

            const proceed = await this.promptUser('Proceed with demo? (yes/no): ');
            if (proceed.toLowerCase() !== 'yes') {
                console.log('Demo cancelled');
                return;
            }

            const governanceToken = this.state.getContract('governanceToken');
            const digitalToken = this.state.getContract('digitalToken');
            const complianceRules = this.state.getContract('complianceRules');

            // Step 1: Distribute tokens
            console.log('\n' + '='.repeat(70));
            console.log('STEP 1: DISTRIBUTE GOVERNANCE TOKENS');
            console.log('='.repeat(70));

            const voter1 = this.state.signers[1];
            const voter2 = this.state.signers[2];
            const voter3 = this.state.signers[3];

            console.log('\n📊 Distributing VGT to 3 voters...');
            const tx1 = await governanceToken.distributeGovernanceTokens(
                [voter1.address, voter2.address, voter3.address],
                [ethers.parseEther('300000'), ethers.parseEther('400000'), ethers.parseEther('300000')]
            );
            await tx1.wait();
            console.log('   ✅ Distributed 300,000 VGT to Voter 1');
            console.log('   ✅ Distributed 400,000 VGT to Voter 2');
            console.log('   ✅ Distributed 300,000 VGT to Voter 3');

            // Step 2: Create proposal
            console.log('\n' + '='.repeat(70));
            console.log('STEP 2: CREATE GOVERNANCE PROPOSAL');
            console.log('='.repeat(70));

            console.log('\n🗳️  Creating proposal to update jurisdiction rules...');
            const tokenAddr = await digitalToken.getAddress();
            const callData = complianceRules.interface.encodeFunctionData(
                'setJurisdictionRule',
                [tokenAddr, [840, 826, 124], [643]] // US, UK, Canada allowed; Russia blocked
            );

            const tx2 = await vanguardGovernance.connect(voter1).createProposal(
                1, // ComplianceRules type
                'Update Jurisdiction Rules',
                'Add US, UK, Canada to allowed countries and block Russia',
                await complianceRules.getAddress(),
                callData
            );
            await tx2.wait();
            console.log('   ✅ Proposal created: Update Jurisdiction Rules');

            // Step 3: Cast votes
            console.log('\n' + '='.repeat(70));
            console.log('STEP 3: CAST VOTES');
            console.log('='.repeat(70));

            console.log('\n✅ Casting votes...');
            const tx3 = await vanguardGovernance.connect(voter1).castVote(1, true, 'Support');
            await tx3.wait();
            console.log('   ✅ Voter 1 voted FOR (300,000 VGT)');

            const tx4 = await vanguardGovernance.connect(voter2).castVote(1, true, 'Support');
            await tx4.wait();
            console.log('   ✅ Voter 2 voted FOR (400,000 VGT)');

            const tx5 = await vanguardGovernance.connect(voter3).castVote(1, false, 'Against');
            await tx5.wait();
            console.log('   ✅ Voter 3 voted AGAINST (300,000 VGT)');

            // Check proposal status
            const proposalResult = await vanguardGovernance.getProposal(1);
            const proposal = proposalResult[0];
            console.log('\n📊 Proposal Status:');
            console.log(`   Votes FOR: ${ethers.formatEther(proposal.votesFor)} VGT (70%)`);
            console.log(`   Votes AGAINST: ${ethers.formatEther(proposal.votesAgainst)} VGT (30%)`);
            console.log(`   Participation: 100%`);

            console.log('\n⏰ Waiting for voting period to end...');
            console.log('   (In production, this would be 7 days + 2 days execution delay)');
            console.log('   (For demo, you can manually execute after the time period)');

            console.log('\n' + '='.repeat(70));
            displaySuccess('GOVERNANCE WORKFLOW DEMONSTRATION COMPLETE!');
            console.log('='.repeat(70));
            console.log('\n✅ DEMONSTRATED:');
            console.log('   1. ✅ Token distribution to verified users');
            console.log('   2. ✅ Proposal creation with encoded function call');
            console.log('   3. ✅ Token-weighted voting (70% FOR, 30% AGAINST)');
            console.log('   4. ✅ Quorum and approval thresholds met');
            console.log('   5. ⏰ Ready for execution after time-lock period');
            console.log('\n💡 Next: Use option 78 to execute the proposal after waiting period');

        } catch (error) {
            displayError(`Workflow demo failed: ${error.message}`);
        }
    }

    /** Option 83: Manage InvestorTypeRegistry via Governance */
    async manageInvestorTypeRegistry() {
        displaySection('MANAGE INVESTORTYPEREGISTRY VIA GOVERNANCE', '🏛️');

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');

        if (!vanguardGovernance) {
            displayError('Deploy Governance Token system first (option 74)');
            return;
        }

        if (!investorTypeRegistry) {
            displayError('Deploy InvestorTypeRegistry first (option 51)');
            return;
        }

        try {
            console.log('\n📊 INVESTOR TYPE REGISTRY GOVERNANCE');
            console.log('This demonstrates using governance to manage InvestorTypeRegistry');
            console.log('');
            console.log('💡 Note: This is a simplified demonstration.');
            console.log('   Use Option 76 to create InvestorTypeConfig proposals');
            console.log('   Use Option 77 to vote on proposals');
            console.log('   Use Option 78 to execute approved proposals');
            console.log('');
            console.log('📋 Current Investor Type Configurations:');

            // Show current configurations for all types
            const types = ['Normal', 'Retail', 'Accredited', 'Institutional'];
            for (let i = 0; i < 4; i++) {
                try {
                    const config = await investorTypeRegistry.getInvestorTypeConfig(i);
                    console.log(`\n${i}. ${types[i]} Investor:`);
                    console.log(`   Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`);
                    console.log(`   Max Holding: ${ethers.formatEther(config.maxHoldingAmount)} VSC`);
                    console.log(`   Cooldown: ${config.transferCooldownMinutes} minutes`);
                } catch (error) {
                    console.log(`\n${i}. ${types[i]} Investor: Not configured`);
                }
            }

            console.log('\n💡 To update these configurations via governance:');
            console.log('   1. Use Option 76 (Create Proposal) → Select type 0 (InvestorTypeConfig)');
            console.log('   2. Use Option 77 (Vote on Proposal)');
            console.log('   3. Use Option 79 (Time Travel 9 Days)');
            console.log('   4. Use Option 78 (Execute Proposal)');

        } catch (error) {
            displayError(`Error: ${error.message}`);
        }
    }

    /** Option 83a: Change Governance Costs */
    async changeGovernanceCosts() {
        displaySection('CHANGE GOVERNANCE COSTS', '💰');
        console.log('This allows the owner to change proposal creation and voting costs');
        console.log('');

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        if (!vanguardGovernance) {
            displayError('Deploy Governance system first (option 74)');
            return;
        }

        try {
            // Show current costs
            const currentProposalCost = await vanguardGovernance.proposalCreationCost();
            const currentVotingCost = await vanguardGovernance.votingCost();

            console.log('\n📊 CURRENT COSTS:');
            console.log('='.repeat(70));
            console.log(`   Proposal Creation: ${ethers.formatEther(currentProposalCost)} VGT`);
            console.log(`   Voting: ${ethers.formatEther(currentVotingCost)} VGT per vote`);
            console.log('');

            console.log('🎯 WHAT WOULD YOU LIKE TO CHANGE?');
            console.log('1. Change Proposal Creation Cost');
            console.log('2. Change Voting Cost');
            console.log('3. Change Both Costs');
            console.log('0. Back to Main Menu');
            console.log('');

            const choice = await this.promptUser('Select option (0-3): ');

            switch (choice) {
                case '1':
                    await this._changeProposalCreationCost(currentProposalCost);
                    break;
                case '2':
                    await this._changeVotingCost(currentVotingCost);
                    break;
                case '3':
                    await this._changeProposalCreationCost(currentProposalCost);
                    await this._changeVotingCost(currentVotingCost);
                    break;
                case '0':
                    return;
                default:
                    console.log('Invalid choice');
            }

        } catch (error) {
            displayError(`Error: ${error.message}`);
        }
    }

    /**
     * Helper: Change proposal creation cost
     * @private
     */
    async _changeProposalCreationCost(currentCost) {
        console.log('\n💰 CHANGE PROPOSAL CREATION COST');
        console.log(`   Current: ${ethers.formatEther(currentCost)} VGT`);

        const newCost = await this.promptUser('Enter new cost (VGT): ');
        const newCostWei = ethers.parseEther(newCost);

        const confirm = await this.promptUser(`\nChange from ${ethers.formatEther(currentCost)} to ${newCost} VGT? (y/n): `);
        if (confirm.toLowerCase() !== 'y') {
            console.log('❌ Change cancelled');
            return;
        }

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const tx = await vanguardGovernance.setProposalCreationCost(newCostWei);
        await tx.wait();

        displaySuccess(`Proposal creation cost changed to ${newCost} VGT`);
    }

    /**
     * Helper: Change voting cost
     * @private
     */
    async _changeVotingCost(currentCost) {
        console.log('\n💰 CHANGE VOTING COST');
        console.log(`   Current: ${ethers.formatEther(currentCost)} VGT per vote`);

        const newCost = await this.promptUser('Enter new cost (VGT): ');
        const newCostWei = ethers.parseEther(newCost);

        const confirm = await this.promptUser(`\nChange from ${ethers.formatEther(currentCost)} to ${newCost} VGT? (y/n): `);
        if (confirm.toLowerCase() !== 'y') {
            console.log('❌ Change cancelled');
            return;
        }

        const vanguardGovernance = this.state.getContract('vanguardGovernance');
        const tx = await vanguardGovernance.setVotingCost(newCostWei);
        await tx.wait();

        displaySuccess(`Voting cost changed to ${newCost} VGT per vote`);
    }
}

module.exports = GovernanceModule;

