/**
 * @fileoverview Investor type management module
 * @module InvestorTypeModule
 * @description Handles investor type system operations including deployment,
 * type configuration, and investor management.
 * Covers menu options 51-60.
 */

const { displayInfo, displaySection, displaySuccess, displayError } = require('../utils/DisplayHelpers');
const { ethers } = require('hardhat');

/**
 * @class InvestorTypeModule
 * @description Manages investor type operations.
 */
class InvestorTypeModule {
    constructor(state, logger, promptUser) {
        this.state = state;
        this.logger = logger;
        this.promptUser = promptUser;
    }

    /** Option 51: Deploy Investor Type System */
    async deployInvestorTypeSystem() {
        displaySection('DEPLOY INVESTOR TYPE SYSTEM', '🏗️');

        try {
            // Deploy InvestorTypeRegistry
            console.log('📦 Deploying InvestorTypeRegistry...');
            const InvestorTypeRegistryFactory = await ethers.getContractFactory('InvestorTypeRegistry');
            const investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
            await investorTypeRegistry.waitForDeployment();
            const registryAddress = await investorTypeRegistry.getAddress();
            this.state.setContract('investorTypeRegistry', investorTypeRegistry);
            console.log(`✅ InvestorTypeRegistry deployed: ${registryAddress}`);

            // Deploy InvestorTypeCompliance
            console.log('📦 Deploying InvestorTypeCompliance...');
            const InvestorTypeComplianceFactory = await ethers.getContractFactory('InvestorTypeCompliance');
            const investorTypeCompliance = await InvestorTypeComplianceFactory.deploy(registryAddress);
            await investorTypeCompliance.waitForDeployment();
            const complianceAddress = await investorTypeCompliance.getAddress();
            this.state.setContract('investorTypeCompliance', investorTypeCompliance);
            console.log(`✅ InvestorTypeCompliance deployed: ${complianceAddress}`);

            // Set up compliance officer
            console.log('👮 Setting up compliance officers...');
            try {
                await investorTypeRegistry.setComplianceOfficer(this.state.signers[1].address, true);
                await investorTypeCompliance.setComplianceOfficer(this.state.signers[1].address, true);
                console.log(`✅ Compliance officer configured: ${this.state.signers[1].address}`);
            } catch (error) {
                console.log('⚠️ Compliance officer setup failed:', error.message);
            }

            // Check if VanguardGovernance is already deployed
            // Try both 'governance' and 'vanguardGovernance' (Option 74 uses 'vanguardGovernance')
            const governance = this.state.getContract('governance') || this.state.getContract('vanguardGovernance');

            if (governance) {
                console.log('🗳️ Integrating with existing VanguardGovernance...');
                try {
                    // Set VanguardGovernance as authorized to update investor type rules
                    const governanceAddress = await governance.getAddress();
                    await investorTypeRegistry.setGovernance(governanceAddress);
                    await investorTypeCompliance.setGovernance(governanceAddress);
                    console.log(`✅ VanguardGovernance integrated: ${governanceAddress}`);
                    console.log('   💡 Investor type updates now require governance proposals');
                } catch (error) {
                    console.log('⚠️ Governance integration failed:', error.message);
                    console.log('   💡 You can manually integrate later if needed');
                }
            } else {
                console.log('🗳️ VanguardGovernance not detected');
                console.log('   💡 Deploy governance system first (Option 74) for democratic control');
                console.log('   💡 Or continue with owner-based control for testing');
            }

            // Display basic system info
            console.log('\n📊 Basic System Information:');
            console.log('   📋 InvestorTypeRegistry: Deployed');
            console.log('   🔒 InvestorTypeCompliance: Deployed');
            console.log('   💡 Use option 52 to view detailed configurations');

            displaySuccess('INVESTOR TYPE SYSTEM DEPLOYED SUCCESSFULLY!');
            console.log('📊 System Status:');
            console.log(`   📋 InvestorTypeRegistry: ${registryAddress}`);
            console.log(`   🔒 InvestorTypeCompliance: ${complianceAddress}`);
            console.log(`   👮 Compliance Officers: 1`);

            // Show governance status
            if (governance) {
                const governanceAddress = await governance.getAddress();
                console.log(`   🗳️ Governance: Integrated with VanguardGovernance`);
                console.log(`   📍 Governance Address: ${governanceAddress}`);
                console.log(`   ⚖️ Updates require governance proposals`);
            } else {
                console.log(`   🗳️ Governance: Not integrated (owner-based control)`);
                console.log(`   💡 Deploy Option 74 for democratic governance`);
            }

        } catch (error) {
            displayError(`Investor Type System deployment failed: ${error.message}`);
        }
    }

    /** Option 52: Show Investor Type Configurations */
    async showInvestorTypeConfigurations() {
        displaySection('SHOW INVESTOR TYPE CONFIGURATIONS', '📊');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            console.log('\n📋 CURRENT INVESTOR TYPE CONFIGURATIONS:');
            const investorTypes = [0, 1, 2, 3]; // Normal, Retail, Accredited, Institutional
            const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];
            const typeEmojis = ['👤', '🛒', '💼', '🏛️'];

            for (let i = 0; i < investorTypes.length; i++) {
                const config = await investorTypeRegistry.getInvestorTypeConfig(investorTypes[i]);
                console.log(`\n${typeEmojis[i]} ${typeNames[i]} Investor (Type ${investorTypes[i]}):`);
                console.log(`   💰 Max Transfer Amount: ${ethers.formatEther(config.maxTransferAmount)} VSC`);
                console.log(`   🏦 Max Holding Amount: ${ethers.formatEther(config.maxHoldingAmount)} VSC`);
                console.log(`   🏆 Required Whitelist Tier: ${config.requiredWhitelistTier}`);
                console.log(`   ⏰ Transfer Cooldown: ${config.transferCooldownMinutes} minutes`);

                // Handle MaxUint256 (no threshold) case
                const thresholdDisplay = config.largeTransferThreshold.toString() === ethers.MaxUint256.toString()
                    ? "No threshold (all transfers normal)"
                    : `${ethers.formatEther(config.largeTransferThreshold)} VSC`;
                console.log(`   🚨 Large Transfer Threshold: ${thresholdDisplay}`);

                console.log(`   📊 Enhanced Logging: ${config.enhancedLogging ? '✅ Enabled' : '❌ Disabled'}`);
                console.log(`   🔐 Enhanced Privacy: ${config.enhancedPrivacy ? '✅ Enabled' : '❌ Disabled'}`);
            }

            displaySuccess('INVESTOR TYPE CONFIGURATIONS DISPLAYED');

        } catch (error) {
            displayError(`Failed to show configurations: ${error.message}`);
        }
    }

    /** Option 53: Assign Investor Types */
    async assignInvestorTypes() {
        displaySection('ASSIGN INVESTOR TYPES', '👥');
        console.log('\n💡 This option shows investors from the INVESTOR ONBOARDING SYSTEM (Option 23)');
        console.log('💡 All investors here have proper KYC/AML, multi-sig wallets, and token locking.');
        console.log('');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            // Check if we have investors from the onboarding system
            if (!this.state.investors || this.state.investors.size === 0) {
                console.log('\n❌ NO INVESTORS FOUND!');
                console.log('');
                console.log('💡 To create investors with proper onboarding:');
                console.log('   1. Go to Option 23: INVESTOR ONBOARDING SYSTEM');
                console.log('   2. Create normal users (Sub-option 1)');
                console.log('   3. Request investor status (Sub-option 2)');
                console.log('   4. Complete the onboarding workflow');
                console.log('');
                console.log('✅ This ensures:');
                console.log('   - KYC/AML verification');
                console.log('   - Multi-signature wallets');
                console.log('   - Token locking requirements');
                console.log('   - Bank approval workflow');
                console.log('   - Complete compliance');
                return;
            }

            console.log('\n📋 INVESTORS FROM ONBOARDING SYSTEM:');
            console.log('='.repeat(50));

            // Get digital token contract to fetch real balances
            const digitalToken = this.state.getContract('token') || this.state.getContract('digitalToken');

            let index = 1;
            const investorArray = Array.from(this.state.investors.values());

            for (const investor of investorArray) {
                console.log(`\n${index}. ${investor.name}`);
                console.log(`   🆔 Address: ${investor.address}`);
                console.log(`   📋 Current Type: ${investor.type}`);

                // Check KYC/AML status
                const kycStatus = investor.kycStatus || 'NOT_ISSUED';
                const amlStatus = investor.amlStatus || 'NOT_ISSUED';
                console.log(`   🎯 KYC Status: ${kycStatus} ${kycStatus === 'ISSUED' ? '✅' : '❌'}`);
                console.log(`   🔍 AML Status: ${amlStatus} ${amlStatus === 'ISSUED' ? '✅' : '❌'}`);

                // Get real on-chain balance
                let balance = 0;
                if (digitalToken) {
                    try {
                        const onchainBalance = await digitalToken.balanceOf(investor.address);
                        balance = parseFloat(ethers.formatEther(onchainBalance));
                    } catch (error) {
                        balance = investor.tokenBalance || 0;
                    }
                } else {
                    balance = investor.tokenBalance || 0;
                }
                console.log(`   💰 Token Balance: ${balance.toLocaleString()} VSC`);

                if (investor.multiSigWallet) {
                    console.log(`   🔐 Multi-Sig Wallet: ${investor.multiSigWallet.address}`);
                    console.log(`   💰 Locked Tokens: ${investor.multiSigWallet.tokensLocked} VSC`);
                }
                index++;
            }

            const choice = await this.promptUser('\nSelect investor number (or 0 to cancel): ');
            const investorIndex = parseInt(choice) - 1;

            if (investorIndex < 0 || investorIndex >= investorArray.length) {
                console.log('❌ Invalid selection');
                return;
            }

            const selectedInvestor = investorArray[investorIndex];

            console.log('\n📊 SELECT INVESTOR TYPE:');
            console.log('0. 👤 Normal Investor');
            console.log('1. 🛒 Retail Investor');
            console.log('2. 💼 Accredited Investor');
            console.log('3. 🏛️ Institutional Investor');

            const typeChoice = await this.promptUser('\nSelect type (0-3): ');
            const newType = parseInt(typeChoice);

            if (newType < 0 || newType > 3) {
                console.log('❌ Invalid type selection');
                return;
            }

            console.log(`\n🔄 Assigning ${selectedInvestor.name} to type ${newType}...`);
            const tx = await investorTypeRegistry.assignInvestorType(selectedInvestor.address, newType);
            await tx.wait();

            // Update investor record
            selectedInvestor.type = ['Normal', 'Retail', 'Accredited', 'Institutional'][newType];

            displaySuccess('INVESTOR TYPE ASSIGNED!');
            console.log(`   👤 Investor: ${selectedInvestor.name}`);
            console.log(`   📋 New Type: ${selectedInvestor.type}`);
            console.log(`   🔗 Transaction: ${tx.hash}`);

        } catch (error) {
            displayError(`Failed to assign investor type: ${error.message}`);
        }
    }

    /** Option 54: Upgrade/Downgrade Investor Types */
    async upgradeDowngradeInvestorTypes() {
        displaySection('UPGRADE/DOWNGRADE INVESTOR TYPES', '⬆️');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            if (!this.state.investors || this.state.investors.size === 0) {
                console.log('\n❌ NO INVESTORS FOUND!');
                console.log('💡 Create investors first using Option 23');
                return;
            }

            console.log('\n📋 CURRENT INVESTOR TYPES:');
            console.log('='.repeat(50));

            let index = 1;
            const investorArray = Array.from(this.state.investors.values());

            for (const investor of investorArray) {
                const currentTypeBigInt = await investorTypeRegistry.getInvestorType(investor.address);
                const currentType = Number(currentTypeBigInt); // Convert BigInt to Number
                const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];
                console.log(`${index}. ${investor.name} - Current: ${typeNames[currentType]}`);
                index++;
            }

            const choice = await this.promptUser('\nSelect investor number (or 0 to cancel): ');
            const investorIndex = parseInt(choice) - 1;

            if (investorIndex < 0 || investorIndex >= investorArray.length) {
                console.log('❌ Invalid selection');
                return;
            }

            const selectedInvestor = investorArray[investorIndex];
            const currentTypeBigInt = await investorTypeRegistry.getInvestorType(selectedInvestor.address);
            const currentType = Number(currentTypeBigInt); // Convert BigInt to Number

            console.log('\n📊 UPGRADE/DOWNGRADE OPTIONS:');
            console.log('1. ⬆️ Upgrade (increase privileges)');
            console.log('2. ⬇️ Downgrade (decrease privileges)');

            const actionChoice = await this.promptUser('\nSelect action (1-2): ');
            let newType;

            if (actionChoice === '1') {
                // Upgrade
                newType = Math.min(currentType + 1, 3);
                if (newType === currentType) {
                    console.log('❌ Already at maximum type (Institutional)');
                    return;
                }
            } else if (actionChoice === '2') {
                // Downgrade
                newType = Math.max(currentType - 1, 0);
                if (newType === currentType) {
                    console.log('❌ Already at minimum type (Normal)');
                    return;
                }
            } else {
                console.log('❌ Invalid action');
                return;
            }

            const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];
            console.log(`\n🔄 Changing ${selectedInvestor.name} from ${typeNames[currentType]} to ${typeNames[newType]}...`);

            const tx = await investorTypeRegistry.assignInvestorType(selectedInvestor.address, newType);
            await tx.wait();

            selectedInvestor.type = typeNames[newType];

            displaySuccess('INVESTOR TYPE UPDATED!');
            console.log(`   👤 Investor: ${selectedInvestor.name}`);
            console.log(`   📋 Old Type: ${typeNames[currentType]}`);
            console.log(`   📋 New Type: ${typeNames[newType]}`);
            console.log(`   🔗 Transaction: ${tx.hash}`);

        } catch (error) {
            displayError(`Failed to upgrade/downgrade investor type: ${error.message}`);
        }
    }

    /** Option 55: Test Transfer Limits by Type */
    async testTransferLimits() {
        displaySection('TEST TRANSFER LIMITS BY TYPE', '💰');
        console.log('\n💡 This option uses investors from the INVESTOR ONBOARDING SYSTEM (Option 23)');
        console.log('💡 All investors have proper KYC/AML, multi-sig wallets, and token locking.');
        console.log('');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        const digitalToken = this.state.getContract('token') || this.state.getContract('digitalToken');

        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        if (!digitalToken) {
            displayError('Digital token not deployed. Please deploy ERC-3643 system first (option 21).');
            return;
        }

        try {
            // Check if we have investors from the onboarding system
            if (!this.state.investors || this.state.investors.size === 0) {
                console.log('\n❌ NO INVESTORS FOUND!');
                console.log('');
                console.log('💡 To create investors for transfer testing:');
                console.log('   1. Go to Option 23: INVESTOR ONBOARDING SYSTEM');
                console.log('   2. Create at least 2 normal users (Sub-option 1)');
                console.log('   3. Request investor status for each (Sub-option 2)');
                console.log('   4. Complete the onboarding workflow');
                console.log('');
                console.log('💡 You need at least 2 investors to test transfers!');
                return;
            }

            const investorArray = Array.from(this.state.investors.values());

            if (investorArray.length < 2) {
                console.log('\n⚠️  INSUFFICIENT INVESTORS!');
                console.log(`   Current: ${investorArray.length} investor(s)`);
                console.log(`   Required: At least 2 investors`);
                console.log('');
                console.log('💡 Create more investors using Option 23 (INVESTOR ONBOARDING SYSTEM)');
                return;
            }

            console.log('\n📋 AVAILABLE INVESTORS:');
            console.log('='.repeat(50));

            let index = 1;
            for (const investor of investorArray) {
                console.log(`\n${index}. ${investor.name}`);
                console.log(`   🆔 Address: ${investor.address.substring(0, 10)}...`);
                console.log(`   📋 Type: ${investor.type}`);

                // Get real on-chain balance
                let balance = 0;
                try {
                    const onchainBalance = await digitalToken.balanceOf(investor.address);
                    balance = parseFloat(ethers.formatEther(onchainBalance));
                } catch (error) {
                    balance = investor.tokenBalance || 0;
                }
                console.log(`   💳 Balance: ${balance.toLocaleString()} VSC`);

                // Get transfer limit for this investor type
                const typeMap = { 'NORMAL': 0, 'RETAIL': 1, 'ACCREDITED': 2, 'INSTITUTIONAL': 3 };
                const typeIndex = typeMap[investor.type] || 0;
                const config = await investorTypeRegistry.getInvestorTypeConfig(typeIndex);
                console.log(`   📊 Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`);

                index++;
            }

            console.log('\n' + '='.repeat(50));

            // Select sender
            const senderChoice = await this.promptUser(`\nSelect SENDER (1-${investorArray.length}): `);
            const senderIndex = parseInt(senderChoice) - 1;
            const sender = investorArray[senderIndex];

            if (!sender) {
                console.log('❌ Invalid sender selection');
                return;
            }

            // Select recipient
            console.log(`\n📋 SELECT RECIPIENT (cannot be ${sender.name}):`);
            const recipients = investorArray.filter((inv, idx) => idx !== senderIndex);

            for (let idx = 0; idx < recipients.length; idx++) {
                const inv = recipients[idx];
                // Get real on-chain balance
                let balance = 0;
                try {
                    const onchainBalance = await digitalToken.balanceOf(inv.address);
                    balance = parseFloat(ethers.formatEther(onchainBalance));
                } catch (error) {
                    balance = inv.tokenBalance || 0;
                }
                console.log(`${idx + 1}. ${inv.name} (${inv.type}) - Balance: ${balance.toLocaleString()} VSC`);
            }

            const recipientChoice = await this.promptUser(`\nSelect RECIPIENT (1-${recipients.length}): `);
            const recipient = recipients[parseInt(recipientChoice) - 1];

            if (!recipient) {
                console.log('❌ Invalid recipient selection');
                return;
            }

            console.log('\n💸 TRANSFER SETUP:');
            console.log('='.repeat(50));

            // Get sender's real balance
            let senderBalance = 0;
            try {
                const onchainBalance = await digitalToken.balanceOf(sender.address);
                senderBalance = parseFloat(ethers.formatEther(onchainBalance));
            } catch (error) {
                senderBalance = sender.tokenBalance || 0;
            }

            console.log(`📤 From: ${sender.name} (${sender.type})`);
            console.log(`   Address: ${sender.address}`);
            console.log(`   Balance: ${senderBalance.toLocaleString()} VSC`);
            console.log('');

            // Get recipient's real balance
            let recipientBalance = 0;
            try {
                const onchainBalance = await digitalToken.balanceOf(recipient.address);
                recipientBalance = parseFloat(ethers.formatEther(onchainBalance));
            } catch (error) {
                recipientBalance = recipient.tokenBalance || 0;
            }

            console.log(`📥 To: ${recipient.name} (${recipient.type})`);
            console.log(`   Address: ${recipient.address}`);
            console.log(`   Balance: ${recipientBalance.toLocaleString()} VSC`);
            console.log('');

            // Get sender's transfer limit
            const typeMap = { 'NORMAL': 0, 'RETAIL': 1, 'ACCREDITED': 2, 'INSTITUTIONAL': 3 };
            const senderTypeIndex = typeMap[sender.type] || 0;
            const senderConfig = await investorTypeRegistry.getInvestorTypeConfig(senderTypeIndex);
            const maxTransfer = senderConfig.maxTransferAmount;

            console.log(`📊 ${sender.name}'s Max Transfer: ${ethers.formatEther(maxTransfer)} VSC`);
            console.log('');

            const amount = await this.promptUser('Enter transfer amount (in VSC): ');
            const transferAmount = ethers.parseEther(amount);

            console.log('\n🔍 VALIDATING TRANSFER...');

            // Check if amount exceeds limit
            if (transferAmount > maxTransfer) {
                console.log(`❌ TRANSFER BLOCKED!`);
                console.log(`   Amount: ${amount} VSC`);
                console.log(`   Limit: ${ethers.formatEther(maxTransfer)} VSC`);
                console.log(`   Reason: Exceeds ${sender.type} investor transfer limit`);
                return;
            }

            console.log(`✅ Transfer amount within limit`);
            console.log(`   Amount: ${amount} VSC`);
            console.log(`   Limit: ${ethers.formatEther(maxTransfer)} VSC`);

            displaySuccess('TRANSFER LIMIT TEST COMPLETE!');
            console.log('   💡 Transfer would be allowed (within limits)');
            console.log('   💡 Use Option 26 to execute actual transfers');

        } catch (error) {
            displayError(`Transfer limits testing failed: ${error.message}`);
        }
    }

    /** Option 56: Test Holding Limits by Type */
    async testHoldingLimits() {
        displaySection('TEST HOLDING LIMITS BY TYPE', '🏦');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            console.log('\n🧪 TESTING HOLDING LIMITS FOR EACH INVESTOR TYPE');

            const testUsers = this.state.signers.slice(0, 4);
            const investorTypes = [0, 1, 2, 3];
            const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];

            console.log('\n📊 HOLDING LIMIT TESTS:');

            for (let i = 0; i < testUsers.length; i++) {
                const config = await investorTypeRegistry.getInvestorTypeConfig(investorTypes[i]);
                const maxHolding = config.maxHoldingAmount; // Already BigInt, keep as-is for ethers operations
                const testAmount = maxHolding + ethers.parseEther("10000"); // BigInt + BigInt = OK

                console.log(`\n${typeNames[i]} Investor (${testUsers[i].address}):`);
                console.log(`   📊 Max Holding Limit: ${ethers.formatEther(maxHolding)} VSC`);

                // Test within limit (BigInt - BigInt = OK)
                const withinLimit = await investorTypeRegistry.canHoldAmount(
                    testUsers[i].address,
                    maxHolding - ethers.parseEther("5000")
                );
                console.log(`   ✅ Holding within limit: ${withinLimit ? 'ALLOWED' : 'BLOCKED'}`);

                // Test over limit
                const overLimit = await investorTypeRegistry.canHoldAmount(
                    testUsers[i].address,
                    testAmount
                );
                console.log(`   ❌ Holding over limit: ${overLimit ? 'ALLOWED' : 'BLOCKED'}`);
            }

            displaySuccess('HOLDING LIMITS TESTING COMPLETE');

        } catch (error) {
            displayError(`Holding limits testing failed: ${error.message}`);
        }
    }

    /** Option 57: Test Large Transfer Detection */
    async testLargeTransferDetection() {
        displaySection('TEST LARGE TRANSFER DETECTION', '🚨');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            console.log('\n🧪 TESTING LARGE TRANSFER DETECTION FOR EACH TYPE');

            const testUsers = this.state.signers.slice(0, 4);
            const investorTypes = [0, 1, 2, 3];
            const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];

            console.log('\n📊 LARGE TRANSFER DETECTION TESTS:');

            for (let i = 0; i < testUsers.length; i++) {
                const config = await investorTypeRegistry.getInvestorTypeConfig(investorTypes[i]);
                const threshold = config.largeTransferThreshold;
                const normalAmount = threshold - ethers.parseEther("1000");
                const largeAmount = threshold + ethers.parseEther("1000");

                console.log(`\n${typeNames[i]} Investor (${testUsers[i].address}):`);
                console.log(`   🚨 Large Transfer Threshold: ${ethers.formatEther(threshold)} VSC`);

                // Test normal transfer
                const isNormalLarge = await investorTypeRegistry.isLargeTransfer(
                    testUsers[i].address,
                    normalAmount
                );
                console.log(`   📊 ${ethers.formatEther(normalAmount)} VSC: ${isNormalLarge ? '🚨 LARGE' : '✅ NORMAL'}`);

                // Test large transfer
                const isLarge = await investorTypeRegistry.isLargeTransfer(
                    testUsers[i].address,
                    largeAmount
                );
                console.log(`   📊 ${ethers.formatEther(largeAmount)} VSC: ${isLarge ? '🚨 LARGE' : '✅ NORMAL'}`);
            }

            displaySuccess('LARGE TRANSFER DETECTION TESTING COMPLETE');

        } catch (error) {
            displayError(`Large transfer detection testing failed: ${error.message}`);
        }
    }

    /** Option 58: Test Transfer Cooldowns */
    async testTransferCooldowns() {
        displaySection('TEST TRANSFER COOLDOWNS', '🔄');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            console.log('\n🧪 TESTING TRANSFER COOLDOWNS FOR EACH TYPE');

            const testUsers = this.state.signers.slice(0, 4);
            const investorTypes = [0, 1, 2, 3];
            const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];

            console.log('\n📊 TRANSFER COOLDOWN TESTS:');

            for (let i = 0; i < testUsers.length; i++) {
                const config = await investorTypeRegistry.getInvestorTypeConfig(investorTypes[i]);
                const cooldownMinutes = Number(config.transferCooldownMinutes); // Convert BigInt to Number

                console.log(`\n${typeNames[i]} Investor (${testUsers[i].address}):`);
                console.log(`   ⏰ Transfer Cooldown: ${cooldownMinutes} minutes`);
                console.log(`   📊 Cooldown in seconds: ${cooldownMinutes * 60}`);

                // Get cooldown from registry (returns minutes, not seconds!)
                const cooldownMinutesFromRegistry = await investorTypeRegistry.getTransferCooldown(testUsers[i].address);
                const cooldownMins = Number(cooldownMinutesFromRegistry); // Convert BigInt to Number
                console.log(`   ✅ Registry cooldown: ${cooldownMins} minutes (${cooldownMins * 60} seconds)`);
            }

            console.log('\n💡 Note: Actual cooldown enforcement would be implemented in the token contract');
            displaySuccess('TRANSFER COOLDOWNS TESTING COMPLETE');

        } catch (error) {
            displayError(`Transfer cooldowns testing failed: ${error.message}`);
        }
    }

    /** Option 59: Run Complete Investor Type Tests */
    async runCompleteTests() {
        displaySection('RUN COMPLETE INVESTOR TYPE TESTS', '🧪');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        if (!investorTypeRegistry) {
            displayError('InvestorTypeRegistry not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            console.log('\n🎯 RUNNING COMPREHENSIVE INVESTOR TYPE SYSTEM TESTS');
            console.log('');

            // Test 1: Show configurations
            console.log('1️⃣  Testing: Show Investor Type Configurations');
            await this.showInvestorTypeConfigurations();
            console.log('');

            // Test 2: Holding limits
            console.log('2️⃣  Testing: Holding Limits by Type');
            await this.testHoldingLimits();
            console.log('');

            // Test 3: Large transfer detection
            console.log('3️⃣  Testing: Large Transfer Detection');
            await this.testLargeTransferDetection();
            console.log('');

            // Test 4: Transfer cooldowns
            console.log('4️⃣  Testing: Transfer Cooldowns');
            await this.testTransferCooldowns();
            console.log('');

            displaySuccess('ALL INVESTOR TYPE TESTS COMPLETED!');
            console.log('   ✅ Configurations displayed');
            console.log('   ✅ Holding limits tested');
            console.log('   ✅ Large transfer detection tested');
            console.log('   ✅ Transfer cooldowns tested');
            console.log('');
            console.log('💡 Use Option 60 to view the complete dashboard');

        } catch (error) {
            displayError(`Complete tests failed: ${error.message}`);
        }
    }

    /** Option 60: Investor Type System Dashboard */
    async showDashboard() {
        displaySection('INVESTOR TYPE SYSTEM DASHBOARD', '📋');

        const investorTypeRegistry = this.state.getContract('investorTypeRegistry');
        const investorTypeCompliance = this.state.getContract('investorTypeCompliance');

        if (!investorTypeRegistry || !investorTypeCompliance) {
            displayError('Investor Type System not deployed. Please deploy first (option 51).');
            return;
        }

        try {
            console.log('\n📊 SYSTEM STATUS:');
            console.log('='.repeat(50));
            console.log(`   📋 InvestorTypeRegistry: ${await investorTypeRegistry.getAddress()}`);
            console.log(`   🔒 InvestorTypeCompliance: ${await investorTypeCompliance.getAddress()}`);
            console.log(`   👮 Owner: ${this.state.signers[0].address}`);

            // Check governance integration
            const governance = this.state.getContract('governance') || this.state.getContract('vanguardGovernance');
            if (governance) {
                console.log(`   🗳️ Governance: Integrated`);
                console.log(`   📍 Governance Address: ${await governance.getAddress()}`);
            } else {
                console.log(`   🗳️ Governance: Not integrated`);
            }

            // Show investor type configurations
            console.log('\n📋 INVESTOR TYPE CONFIGURATIONS:');
            console.log('='.repeat(50));

            const investorTypes = [0, 1, 2, 3];
            const typeNames = ['Normal', 'Retail', 'Accredited', 'Institutional'];
            const typeEmojis = ['👤', '🛒', '💼', '🏛️'];

            for (let i = 0; i < investorTypes.length; i++) {
                const config = await investorTypeRegistry.getInvestorTypeConfig(investorTypes[i]);
                console.log(`\n${typeEmojis[i]} ${typeNames[i]} Investor (Type ${investorTypes[i]}):`);
                console.log(`   💰 Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`);
                console.log(`   🏦 Max Holding: ${ethers.formatEther(config.maxHoldingAmount)} VSC`);
                console.log(`   ⏰ Cooldown: ${config.transferCooldownMinutes} minutes`);

                const thresholdDisplay = config.largeTransferThreshold.toString() === ethers.MaxUint256.toString()
                    ? "No threshold"
                    : `${ethers.formatEther(config.largeTransferThreshold)} VSC`;
                console.log(`   🚨 Large Transfer: ${thresholdDisplay}`);
            }

            // Show assigned investors
            if (this.state.investors && this.state.investors.size > 0) {
                console.log('\n👥 ASSIGNED INVESTORS:');
                console.log('='.repeat(50));

                let index = 1;
                for (const investor of this.state.investors.values()) {
                    const investorType = await investorTypeRegistry.getInvestorType(investor.address);
                    console.log(`${index}. ${investor.name} - Type: ${typeNames[investorType]}`);
                    index++;
                }
            } else {
                console.log('\n👥 ASSIGNED INVESTORS:');
                console.log('='.repeat(50));
                console.log('   ℹ️  No investors assigned yet');
                console.log('   💡 Use Option 23 to create investors');
                console.log('   💡 Use Option 53 to assign types');
            }

            console.log('\n📈 SYSTEM STATISTICS:');
            console.log('='.repeat(50));
            console.log(`   📊 Total Investor Types: 4`);
            console.log(`   👥 Assigned Investors: ${this.state.investors ? this.state.investors.size : 0}`);
            console.log(`   🔒 Compliance Checks: Active`);
            console.log(`   ⚖️ Governance: ${governance ? 'Integrated' : 'Not integrated'}`);

            displaySuccess('DASHBOARD DISPLAYED SUCCESSFULLY');

        } catch (error) {
            displayError(`Dashboard display failed: ${error.message}`);
        }
    }
}

module.exports = InvestorTypeModule;

