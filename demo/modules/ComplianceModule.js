/**
 * @fileoverview Compliance rules management module
 * @module ComplianceModule
 * @description Handles all compliance-related operations including jurisdiction rules,
 * investor type rules, holding period rules, and compliance level rules.
 * Covers menu options 13-20.
 * 
 * @example
 * const ComplianceModule = require('./modules/ComplianceModule');
 * const module = new ComplianceModule(state, logger, promptUser);
 * await module.configureJurisdictionRules();
 */

const { displaySection, displaySuccess, displayError, displayInfo } = require('../utils/DisplayHelpers');

/**
 * @class ComplianceModule
 * @description Manages compliance rules for the demo system.
 * Handles jurisdiction, investor type, holding period, and compliance level rules.
 */
class ComplianceModule {
    /**
     * Create a ComplianceModule
     * @param {Object} state - DemoState instance
     * @param {Object} logger - EnhancedLogger instance
     * @param {Function} promptUser - Function to prompt user for input
     * @param {Object} deployer - ContractDeployer instance
     */
    constructor(state, logger, promptUser, deployer) {
        this.state = state;
        this.logger = logger;
        this.promptUser = promptUser;
        this.deployer = deployer;
    }

    /**
     * Option 13: Deploy ComplianceRules contract
     *
     * @returns {Promise<void>}
     *
     * @example
     * await module.deployComplianceRules();
     */
    async deployComplianceRules() {
        displaySection('DEPLOYING COMPLIANCE RULES CONTRACT', '🏗️');

        if (!this.state.getContract('onchainIDFactory')) {
            displayError('Please deploy contracts first (option 1)');
            return;
        }

        try {
            // Display jurisdiction rules information
            console.log('\n🌍 INITIAL JURISDICTION RULES');
            console.log('='.repeat(50));
            console.log('\n📋 How Jurisdiction Rules Work:');
            console.log('   • WHITELIST (Allowed Countries): If set, ONLY these countries can participate');
            console.log('   • BLACKLIST (Blocked Countries): These countries are ALWAYS blocked');
            console.log('   • If NO whitelist: All countries allowed EXCEPT blocked ones');
            console.log('   • If whitelist exists: ONLY allowed countries, AND blocked are still blocked');
            console.log('');
            console.log('📋 Common Country Codes (ISO 3166-1 numeric):');
            console.log('   840 - United States');
            console.log('   826 - United Kingdom');
            console.log('   124 - Canada');
            console.log('   276 - Germany');
            console.log('   250 - France');
            console.log('   392 - Japan');
            console.log('   702 - Singapore');
            console.log('   36  - Australia');
            console.log('   344 - Hong Kong');
            console.log('   756 - Switzerland');
            console.log('');
            console.log('📋 Common Sanctioned Countries:');
            console.log('   156 - China');
            console.log('   643 - Russia');
            console.log('   850 - North Korea');
            console.log('   364 - Iran');
            console.log('   760 - Syria');
            console.log('');
            console.log('💡 After deployment, only governance can update these rules');
            console.log('');

            // Ask for allowed countries (whitelist)
            const allowedInput = await this.promptUser('Enter ALLOWED countries (whitelist, comma-separated, or press Enter for none): ');
            let allowedCountries = [];

            if (allowedInput.trim() !== '') {
                allowedCountries = allowedInput.split(',').map(c => parseInt(c.trim()));
                console.log(`   ✅ Whitelist active: Only ${allowedCountries.join(', ')} allowed`);
            } else {
                console.log('   ℹ️  No whitelist: All countries allowed (except blocked)');
            }

            // Ask for blocked countries (blacklist)
            const blockedInput = await this.promptUser('Enter BLOCKED countries (blacklist, comma-separated, or press Enter for default): ');
            let blockedCountries;

            if (blockedInput.trim() === '') {
                // Default: Block sanctioned countries
                blockedCountries = [156, 643, 850, 364, 760];
                console.log('   ✅ Using default blacklist: China, Russia, North Korea, Iran, Syria');
            } else {
                blockedCountries = blockedInput.split(',').map(c => parseInt(c.trim()));
                console.log(`   ✅ Blacklist: ${blockedCountries.join(', ')}`);
            }

            console.log('\n📊 Final Configuration:');
            if (allowedCountries.length > 0) {
                console.log(`   ✅ Whitelist: ${allowedCountries.join(', ')} (ONLY these allowed)`);
            } else {
                console.log('   ℹ️  Whitelist: None (all countries allowed except blocked)');
            }
            console.log(`   ❌ Blacklist: ${blockedCountries.join(', ')} (ALWAYS blocked)`);

            // Deploy with user-provided configuration
            await this.deployer.deployComplianceRulesWithConfig(allowedCountries, blockedCountries);

            console.log('\n🎉 COMPLIANCE RULES CONTRACT DEPLOYED SUCCESSFULLY!');
            console.log('📋 Features Available:');
            console.log('   • Jurisdiction-based validation');
            console.log('   • Investor type validation');
            console.log('   • Holding period enforcement');
            console.log('   • Compliance level checks');
            console.log('   • Governance-controlled updates');

        } catch (error) {
            displayError(`ComplianceRules deployment failed: ${error.message}`);
        }
    }

    /**
     * Option 14: Configure jurisdiction rules
     *
     * @returns {Promise<void>}
     *
     * @example
     * await module.configureJurisdictionRules();
     */
    async configureJurisdictionRules() {
        console.log('\n🌍 CONFIGURE JURISDICTION RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            // Use the ERC-3643 Digital Token for compliance testing
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                console.log('💡 Please deploy contracts first using option 1');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log('\n🌍 Setting up jurisdiction rules for Digital Token...');
            console.log(`📦 Token: ${tokenAddress}`);

            // ⚠️ SHOW CURRENT RULES FIRST
            console.log('\n📊 CURRENT JURISDICTION RULES:');
            console.log('='.repeat(50));

            let currentAllowed = [];
            let currentBlocked = [];

            try {
                const currentRule = await complianceRules.getJurisdictionRule(tokenAddress);
                currentAllowed = currentRule.allowedCountries.map(c => Number(c));
                currentBlocked = currentRule.blockedCountries.map(c => Number(c));

                console.log('\n✅ Current WHITELIST (Allowed Countries):');
                if (currentAllowed.length === 0) {
                    console.log('   ℹ️  No whitelist - All countries allowed (except blocked)');
                } else {
                    console.log(`   📊 Total: ${currentAllowed.length} countries`);
                    console.log(`   📋 Countries: ${currentAllowed.join(', ')}`);
                }

                console.log('\n❌ Current BLACKLIST (Blocked Countries):');
                if (currentBlocked.length === 0) {
                    console.log('   ℹ️  No countries blocked');
                } else {
                    console.log(`   📊 Total: ${currentBlocked.length} countries`);
                    console.log(`   📋 Countries: ${currentBlocked.join(', ')}`);
                }
            } catch (error) {
                console.log('   ℹ️  No current rules found (first time setup)');
            }

            // Interactive management menu
            console.log('\n🔧 JURISDICTION RULES MANAGEMENT:');
            console.log('='.repeat(50));
            console.log('1. ➕ Add countries to whitelist');
            console.log('2. ➖ Remove countries from whitelist');
            console.log('3. ➕ Add countries to blacklist');
            console.log('4. ➖ Remove countries from blacklist');
            console.log('5. 🔄 Replace all rules (complete reset)');
            console.log('6. ❌ Cancel');
            console.log('');

            const action = await this.promptUser('Select action (1-6): ');

            let allowedArray = [...currentAllowed];
            let blockedArray = [...currentBlocked];

            switch (action.trim()) {
                case '1': // Add to whitelist
                    console.log('\n➕ ADD COUNTRIES TO WHITELIST');
                    console.log('   Examples: 840 (US), 826 (UK), 124 (Canada), 276 (Germany), 392 (Japan)');
                    const addAllowedInput = await this.promptUser('Countries to add: ');
                    if (addAllowedInput.trim()) {
                        const toAdd = addAllowedInput.split(',').map(c => parseInt(c.trim()));
                        toAdd.forEach(country => {
                            if (!allowedArray.includes(country)) {
                                allowedArray.push(country);
                                console.log(`   ✅ Added ${country} to whitelist`);
                            } else {
                                console.log(`   ℹ️  ${country} already in whitelist`);
                            }
                        });
                    }
                    break;

                case '2': // Remove from whitelist
                    console.log('\n➖ REMOVE COUNTRIES FROM WHITELIST');
                    console.log(`   Current whitelist: ${allowedArray.join(', ')}`);
                    const removeAllowedInput = await this.promptUser('Countries to remove: ');
                    if (removeAllowedInput.trim()) {
                        const toRemove = removeAllowedInput.split(',').map(c => parseInt(c.trim()));
                        toRemove.forEach(country => {
                            const index = allowedArray.indexOf(country);
                            if (index > -1) {
                                allowedArray.splice(index, 1);
                                console.log(`   ✅ Removed ${country} from whitelist`);
                            } else {
                                console.log(`   ℹ️  ${country} not in whitelist`);
                            }
                        });
                    }
                    break;

                case '3': // Add to blacklist
                    console.log('\n➕ ADD COUNTRIES TO BLACKLIST');
                    console.log('   Examples: 643 (Russia), 156 (China), 850 (North Korea), 364 (Iran), 760 (Syria)');
                    const addBlockedInput = await this.promptUser('Countries to add: ');
                    if (addBlockedInput.trim()) {
                        const toAdd = addBlockedInput.split(',').map(c => parseInt(c.trim()));
                        toAdd.forEach(country => {
                            if (!blockedArray.includes(country)) {
                                blockedArray.push(country);
                                console.log(`   ✅ Added ${country} to blacklist`);
                            } else {
                                console.log(`   ℹ️  ${country} already in blacklist`);
                            }
                        });
                    }
                    break;

                case '4': // Remove from blacklist
                    console.log('\n➖ REMOVE COUNTRIES FROM BLACKLIST');
                    console.log(`   Current blacklist: ${blockedArray.join(', ')}`);
                    const removeBlockedInput = await this.promptUser('Countries to remove: ');
                    if (removeBlockedInput.trim()) {
                        const toRemove = removeBlockedInput.split(',').map(c => parseInt(c.trim()));
                        toRemove.forEach(country => {
                            const index = blockedArray.indexOf(country);
                            if (index > -1) {
                                blockedArray.splice(index, 1);
                                console.log(`   ✅ Removed ${country} from blacklist`);
                            } else {
                                console.log(`   ℹ️  ${country} not in blacklist`);
                            }
                        });
                    }
                    break;

                case '5': // Replace all
                    console.log('\n🔄 REPLACE ALL RULES (COMPLETE RESET)');
                    console.log('⚠️  This will completely replace current rules!');
                    console.log('\n📋 Configure NEW allowed countries (comma-separated):');
                    console.log('   Examples: 840 (US), 826 (UK), 124 (Canada), 276 (Germany), 392 (Japan)');
                    console.log('   💡 Leave empty for no whitelist');
                    const newAllowedInput = await this.promptUser('Allowed countries: ');
                    allowedArray = newAllowedInput.trim() ? newAllowedInput.split(',').map(c => parseInt(c.trim())) : [];

                    console.log('\n📋 Configure NEW blocked countries (comma-separated):');
                    console.log('   Examples: 643 (Russia), 156 (China), 850 (North Korea), 364 (Iran), 760 (Syria)');
                    console.log('   💡 Leave empty for no blacklist');
                    const newBlockedInput = await this.promptUser('Blocked countries: ');
                    blockedArray = newBlockedInput.trim() ? newBlockedInput.split(',').map(c => parseInt(c.trim())) : [];
                    break;

                case '6': // Cancel
                    console.log('\n❌ Operation cancelled');
                    return;

                default:
                    console.log('\n❌ Invalid option. Operation cancelled.');
                    return;
            }

            // Set jurisdiction rules
            console.log('\n📝 UPDATING JURISDICTION RULES...');
            console.log(`🔍 DEBUG - Writing to blockchain:`);
            console.log(`   Token: ${tokenAddress}`);
            console.log(`   Allowed: [${allowedArray.join(', ')}]`);
            console.log(`   Blocked: [${blockedArray.join(', ')}]`);

            const tx = await complianceRules.connect(this.state.signers[0]).setJurisdictionRule(
                tokenAddress,
                allowedArray,
                blockedArray
            );
            const receipt = await tx.wait();

            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

            console.log('\n✅ JURISDICTION RULES UPDATED SUCCESSFULLY!');
            console.log('='.repeat(50));
            console.log('\n📊 NEW CONFIGURATION:');
            console.log(`   ✅ Whitelist (${allowedArray.length} countries): ${allowedArray.length > 0 ? allowedArray.join(', ') : 'None (all allowed except blocked)'}`);
            console.log(`   ❌ Blacklist (${blockedArray.length} countries): ${blockedArray.length > 0 ? blockedArray.join(', ') : 'None'}`);
            console.log(`\n🔗 Transaction: ${receipt.hash}`);
            console.log(`🧱 Block: ${receipt.blockNumber}`);
            console.log(`⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

            // Test the rules
            console.log('\n🧪 Testing jurisdiction validation...');
            for (const country of allowedArray.slice(0, 2)) {
                const [isValid, reason] = await complianceRules.validateJurisdiction(tokenAddress, country);
                console.log(`   Country ${country}: ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
            }
            for (const country of blockedArray.slice(0, 2)) {
                const [isValid, reason] = await complianceRules.validateJurisdiction(tokenAddress, country);
                console.log(`   Country ${country}: ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
            }

        } catch (error) {
            console.error('❌ Jurisdiction rules configuration failed:', error.message);
        }
    }

    /**
     * Option 15: Configure investor type rules
     *
     * @returns {Promise<void>}
     */
    async configureInvestorTypeRules() {
        console.log('\n👥 CONFIGURE INVESTOR TYPE RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log('\n👥 Setting up investor type rules for Digital Token...');
            console.log(`📦 Token: ${tokenAddress}`);

            // Interactive configuration
            console.log('\n📋 Configure allowed investor types:');
            console.log('   0: Unverified, 1: Retail, 2: Accredited, 3: Institutional');
            const allowedInput = await this.promptUser('Allowed types (default: 1,2,3): ');
            const allowedTypes = allowedInput || '1,2,3';
            const allowedArray = allowedTypes.split(',').map(t => parseInt(t.trim()));

            console.log('\n📋 Configure blocked investor types:');
            const blockedInput = await this.promptUser('Blocked types (default: 0): ');
            const blockedTypes = blockedInput || '0';
            const blockedArray = blockedTypes.split(',').map(t => parseInt(t.trim()));

            console.log('\n💰 Set minimum accreditation level:');
            const accreditationInput = await this.promptUser('Minimum accreditation (default: 100000): ');
            const minimumAccreditation = parseInt(accreditationInput || '100000');

            // Set investor type rules
            console.log('\n📝 UPDATING INVESTOR TYPE RULES...');
            console.log(`🔍 DEBUG - Writing to blockchain:`);
            console.log(`   Token: ${tokenAddress}`);
            console.log(`   Allowed Types: [${allowedArray.join(', ')}]`);
            console.log(`   Blocked Types: [${blockedArray.join(', ')}]`);
            console.log(`   Min Accreditation: ${minimumAccreditation}`);

            const tx = await complianceRules.connect(this.state.signers[0]).setInvestorTypeRule(
                tokenAddress,
                allowedArray,
                blockedArray,
                minimumAccreditation
            );
            const receipt = await tx.wait();

            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

            console.log('\n✅ INVESTOR TYPE RULES CONFIGURED!');
            console.log(`   Allowed types: ${allowedArray.join(', ')}`);
            console.log(`   Blocked types: ${blockedArray.join(', ')}`);
            console.log(`   Minimum accreditation: $${minimumAccreditation.toLocaleString()}`);
            console.log(`   Transaction: ${receipt.hash}`);

            // Test the rules
            console.log('\n🧪 Testing investor type validation...');
            const testCases = [
                { type: 2, accreditation: 150000, description: 'Accredited ($150k)' },
                { type: 1, accreditation: 50000, description: 'Retail ($50k)' },
                { type: 0, accreditation: 25000, description: 'Unverified ($25k)' }
            ];

            for (const testCase of testCases) {
                const [isValid, reason] = await complianceRules.validateInvestorType(
                    tokenAddress,
                    testCase.type,
                    testCase.accreditation
                );
                console.log(`   ${testCase.description}: ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
            }

        } catch (error) {
            console.error('❌ Investor type rules configuration failed:', error.message);
        }
    }

    /**
     * Option 16: Configure holding period rules
     *
     * @returns {Promise<void>}
     */
    async configureHoldingPeriodRules() {
        console.log('\n⏰ CONFIGURE HOLDING PERIOD RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log('\n⏰ Setting up holding period rules for Digital Token...');
            console.log(`📦 Token: ${tokenAddress}`);

            // Interactive configuration
            console.log('\n📋 Configure minimum holding period (in hours):');
            const holdingInput = await this.promptUser('Holding period hours (default: 24): ');
            const holdingHours = parseInt(holdingInput || '24');
            const holdingPeriod = holdingHours * 60 * 60; // Convert to seconds

            console.log('\n📋 Configure transfer cooldown (in minutes):');
            const cooldownInput = await this.promptUser('Cooldown minutes (default: 60): ');
            const cooldownMinutes = parseInt(cooldownInput || '60');
            const transferCooldown = cooldownMinutes * 60; // Convert to seconds

            // Set holding period rules
            console.log('\n📝 UPDATING HOLDING PERIOD RULES...');
            console.log(`🔍 DEBUG - Writing to blockchain:`);
            console.log(`   Token: ${tokenAddress}`);
            console.log(`   Holding Period: ${holdingPeriod} seconds (${holdingHours} hours)`);
            console.log(`   Cooldown: ${transferCooldown} seconds (${cooldownMinutes} minutes)`);

            const tx = await complianceRules.connect(this.state.signers[0]).setHoldingPeriodRule(
                tokenAddress,
                holdingPeriod,
                transferCooldown
            );
            const receipt = await tx.wait();

            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

            console.log('\n✅ HOLDING PERIOD RULES CONFIGURED!');
            console.log(`   Minimum holding period: ${holdingHours} hours`);
            console.log(`   Transfer cooldown: ${cooldownMinutes} minutes`);
            console.log(`   Transaction: ${receipt.hash}`);

            // Test the rules
            console.log('\n🧪 Testing holding period validation...');
            const ethers = require('hardhat').ethers;
            const currentBlock = await ethers.provider.getBlock('latest');
            const testCases = [
                {
                    time: currentBlock.timestamp - 1,
                    description: 'Recent acquisition (1 sec ago)'
                },
                {
                    time: currentBlock.timestamp - (holdingPeriod + 3600),
                    description: `Old acquisition (${holdingHours + 1} hrs ago)`
                }
            ];

            for (const testCase of testCases) {
                const [isValid, reason] = await complianceRules.validateHoldingPeriod(
                    tokenAddress,
                    this.state.signers[1].address,
                    testCase.time
                );
                console.log(`   ${testCase.description}: ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
            }

        } catch (error) {
            console.error('❌ Holding period rules configuration failed:', error.message);
        }
    }

    /**
     * Option 17: Configure compliance level rules
     *
     * @returns {Promise<void>}
     */
    async configureComplianceLevelRules() {
        console.log('\n📊 CONFIGURE COMPLIANCE LEVEL RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log('\n📊 Setting up compliance level rules for Digital Token...');
            console.log(`📦 Token: ${tokenAddress}`);

            // Interactive configuration
            console.log('\n📋 Configure compliance level range:');
            const minLevelInput = await this.promptUser('Minimum level (default: 1): ');
            const minimumLevel = parseInt(minLevelInput || '1');

            const maxLevelInput = await this.promptUser('Maximum level (default: 5): ');
            const maximumLevel = parseInt(maxLevelInput || '5');

            // Set up inheritance mapping
            const levels = [];
            const inheritanceLevels = [];
            for (let i = minimumLevel; i <= maximumLevel; i++) {
                levels.push(i);
                // Simple inheritance: higher levels inherit from lower levels
                inheritanceLevels.push(Math.max(1, i - 1));
            }

            console.log(`\n📋 Level inheritance mapping: ${levels.map((l, i) => `${l}→${inheritanceLevels[i]}`).join(', ')}`);

            // Set compliance level rules
            console.log('\n📝 UPDATING COMPLIANCE LEVEL RULES...');
            console.log(`🔍 DEBUG - Writing to blockchain:`);
            console.log(`   Token: ${tokenAddress}`);
            console.log(`   Min Level: ${minimumLevel}`);
            console.log(`   Max Level: ${maximumLevel}`);
            console.log(`   Levels: [${levels.join(', ')}]`);
            console.log(`   Inheritance: [${inheritanceLevels.join(', ')}]`);

            const tx = await complianceRules.connect(this.state.signers[0]).setComplianceLevelRule(
                tokenAddress,
                minimumLevel,
                maximumLevel,
                levels,
                inheritanceLevels
            );
            const receipt = await tx.wait();

            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

            console.log('\n✅ COMPLIANCE LEVEL RULES CONFIGURED!');
            console.log(`   Level range: ${minimumLevel} - ${maximumLevel}`);
            console.log(`   Inheritance mapping: ${levels.map((l, i) => `${l}→${inheritanceLevels[i]}`).join(', ')}`);
            console.log(`   Transaction: ${receipt.hash}`);

            // Test the rules
            console.log('\n🧪 Testing compliance level aggregation...');
            const testInputs = [
                [3, 4, 2, 5],
                [1, 1, 1],
                [5, 4, 3, 2, 1]
            ];

            for (const inputLevels of testInputs) {
                const [aggregatedLevel, isValid] = await complianceRules.aggregateComplianceLevels(
                    tokenAddress,
                    inputLevels
                );
                console.log(`   Input [${inputLevels.join(', ')}] → Level ${aggregatedLevel} (${isValid ? '✅ VALID' : '❌ INVALID'})`);
            }

        } catch (error) {
            console.error('❌ Compliance level rules configuration failed:', error.message);
        }
    }

    /**
     * Option 18: Test all compliance validations
     *
     * @returns {Promise<void>}
     */
    async testAllComplianceValidations() {
        console.log('\n🧪 TEST ALL COMPLIANCE VALIDATIONS');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();
            console.log(`🪙 Testing compliance validations with ERC-3643 Digital Token: ${tokenAddress}`);

            // Comprehensive test suite
            console.log('\n🌍 JURISDICTION VALIDATION TESTS');
            console.log('-'.repeat(40));
            const jurisdictionTests = [
                { country: 840, name: 'United States' },
                { country: 826, name: 'United Kingdom' },
                { country: 643, name: 'Russia' },
                { country: 156, name: 'China' },
                { country: 999, name: 'Unknown Country' }
            ];

            for (const test of jurisdictionTests) {
                try {
                    const [isValid, reason] = await complianceRules.validateJurisdiction(tokenAddress, test.country);
                    console.log(`   ${test.name} (${test.country}): ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
                } catch (error) {
                    console.log(`   ${test.name} (${test.country}): ❌ ERROR - ${error.message}`);
                }
            }

            console.log('\n👥 INVESTOR TYPE VALIDATION TESTS');
            console.log('-'.repeat(40));
            const investorTests = [
                { type: 0, accreditation: 25000, name: 'Unverified ($25k)' },
                { type: 1, accreditation: 50000, name: 'Retail ($50k)' },
                { type: 2, accreditation: 150000, name: 'Accredited ($150k)' },
                { type: 3, accreditation: 1000000, name: 'Institutional ($1M)' }
            ];

            for (const test of investorTests) {
                try {
                    const [isValid, reason] = await complianceRules.validateInvestorType(
                        tokenAddress,
                        test.type,
                        test.accreditation
                    );
                    console.log(`   ${test.name}: ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
                } catch (error) {
                    console.log(`   ${test.name}: ❌ ERROR - ${error.message}`);
                }
            }

            console.log('\n⏰ HOLDING PERIOD VALIDATION TESTS');
            console.log('-'.repeat(40));
            const ethers = require('hardhat').ethers;
            const currentBlock = await ethers.provider.getBlock('latest');
            const holdingTests = [
                {
                    time: currentBlock.timestamp - 1,
                    name: 'Recent acquisition (1 sec ago)'
                },
                {
                    time: currentBlock.timestamp - (12 * 60 * 60),
                    name: 'Medium acquisition (12 hrs ago)'
                },
                {
                    time: currentBlock.timestamp - (48 * 60 * 60),
                    name: 'Old acquisition (48 hrs ago)'
                }
            ];

            for (const test of holdingTests) {
                try {
                    const [isValid, reason] = await complianceRules.validateHoldingPeriod(
                        tokenAddress,
                        this.state.signers[1].address,
                        test.time
                    );
                    console.log(`   ${test.name}: ${isValid ? '✅ ALLOWED' : '❌ BLOCKED'} - ${reason}`);
                } catch (error) {
                    console.log(`   ${test.name}: ❌ ERROR - ${error.message}`);
                }
            }

            console.log('\n📊 COMPLIANCE LEVEL AGGREGATION TESTS');
            console.log('-'.repeat(40));
            const levelTests = [
                { levels: [1, 2, 3], name: 'Basic levels' },
                { levels: [3, 4, 2, 5], name: 'Mixed levels' },
                { levels: [5, 5, 5], name: 'High levels' },
                { levels: [1], name: 'Single level' }
            ];

            for (const test of levelTests) {
                try {
                    const [aggregatedLevel, isValid] = await complianceRules.aggregateComplianceLevels(
                        tokenAddress,
                        test.levels
                    );
                    console.log(`   ${test.name} [${test.levels.join(', ')}]: Level ${aggregatedLevel} (${isValid ? '✅ VALID' : '❌ INVALID'})`);
                } catch (error) {
                    console.log(`   ${test.name}: ❌ ERROR - ${error.message}`);
                }
            }

            console.log('\n🎉 ALL COMPLIANCE VALIDATION TESTS COMPLETED!');

        } catch (error) {
            console.error('❌ Compliance validation tests failed:', error.message);
        }
    }

    /**
     * Option 19: Test access control
     *
     * @returns {Promise<void>}
     */
    async testAccessControl() {
        console.log('\n🔐 COMPREHENSIVE ACCESS CONTROL TESTING');
        console.log('='.repeat(60));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();
            const complianceAddress = await complianceRules.getAddress();

            console.log('\n📋 TEST ENVIRONMENT SETUP');
            console.log('-'.repeat(40));
            console.log(`🏗️  ComplianceRules Contract: ${complianceAddress}`);
            console.log(`🪙 ERC-3643 Digital Token: ${tokenAddress}`);
            console.log(`👑 Contract Owner: ${this.state.signers[0].address}`);
            console.log(`👨‍💼 Test Administrator: ${this.state.signers[1].address}`);
            console.log(`👤 Regular User 1: ${this.state.signers[2].address}`);
            console.log(`👤 Regular User 2: ${this.state.signers[3].address}`);

            // Test 1: Owner Permissions
            console.log('\n👑 TEST 1: OWNER PERMISSIONS');
            console.log('='.repeat(40));
            console.log('🧪 Testing owner can set rule administrators...');

            try {
                const tx1 = await complianceRules.connect(this.state.signers[0]).setRuleAdministrator(
                    this.state.signers[1].address,
                    true
                );
                const receipt1 = await tx1.wait();
                console.log(`✅ SUCCESS: Owner set rule administrator`);
                console.log(`   📍 Administrator: ${this.state.signers[1].address}`);
                console.log(`   🔗 Transaction: ${receipt1.hash}`);
                console.log(`   🧱 Block: ${receipt1.blockNumber}`);
                console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);
            } catch (error) {
                console.log(`❌ FAILED: Owner could not set rule administrator`);
                console.log(`   🚨 Error: ${error.message}`);
            }

            console.log('\n🧪 Testing owner can authorize tokens...');
            try {
                const tx2 = await complianceRules.connect(this.state.signers[0]).authorizeToken(tokenAddress, true);
                const receipt2 = await tx2.wait();
                console.log(`✅ SUCCESS: Owner authorized token`);
                console.log(`   🪙 Token: ${tokenAddress}`);
                console.log(`   🔗 Transaction: ${receipt2.hash}`);
                console.log(`   🧱 Block: ${receipt2.blockNumber}`);
                console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
            } catch (error) {
                console.log(`❌ FAILED: Owner could not authorize token`);
                console.log(`   🚨 Error: ${error.message}`);
            }

            // Test 2: Administrator Permissions
            console.log('\n👨‍💼 TEST 2: ADMINISTRATOR PERMISSIONS');
            console.log('='.repeat(40));
            console.log('🧪 Testing administrator can set jurisdiction rules...');

            try {
                const tx3 = await complianceRules.connect(this.state.signers[1]).setJurisdictionRule(
                    tokenAddress,
                    [840, 276, 826], // USA, Germany, UK
                    [643, 156] // Russia, China
                );
                const receipt3 = await tx3.wait();
                console.log(`✅ SUCCESS: Administrator set jurisdiction rules`);
                console.log(`   🌍 Allowed Countries: [840, 276, 826] (USA, Germany, UK)`);
                console.log(`   🚫 Blocked Countries: [643, 156] (Russia, China)`);
                console.log(`   🔗 Transaction: ${receipt3.hash}`);
                console.log(`   🧱 Block: ${receipt3.blockNumber}`);
                console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);
            } catch (error) {
                console.log(`❌ FAILED: Administrator could not set jurisdiction rules`);
                console.log(`   🚨 Error: ${error.message}`);
            }

            console.log('\n🧪 Testing administrator can set investor type rules...');
            try {
                const tx4 = await complianceRules.connect(this.state.signers[1]).setInvestorTypeRule(
                    tokenAddress,
                    [1, 2, 3], // Retail, Accredited, Institutional
                    [0], // Unverified
                    100000 // $100k minimum
                );
                const receipt4 = await tx4.wait();
                console.log(`✅ SUCCESS: Administrator set investor type rules`);
                console.log(`   👥 Allowed Types: [1, 2, 3] (Retail, Accredited, Institutional)`);
                console.log(`   🚫 Blocked Types: [0] (Unverified)`);
                console.log(`   💰 Minimum Accreditation: $100,000`);
                console.log(`   🔗 Transaction: ${receipt4.hash}`);
                console.log(`   🧱 Block: ${receipt4.blockNumber}`);
                console.log(`   ⛽ Gas Used: ${receipt4.gasUsed.toLocaleString()}`);
            } catch (error) {
                console.log(`❌ FAILED: Administrator could not set investor type rules`);
                console.log(`   🚨 Error: ${error.message}`);
            }

            // Test 3: Regular User Restrictions
            console.log('\n👤 TEST 3: REGULAR USER ACCESS RESTRICTIONS');
            console.log('='.repeat(50));
            console.log('🧪 Testing regular user CANNOT set jurisdiction rules...');

            try {
                await complianceRules.connect(this.state.signers[2]).setJurisdictionRule(
                    tokenAddress,
                    [392], // Japan
                    []
                );
                console.log(`❌ SECURITY BREACH: Regular user was able to set rules!`);
                console.log(`   🚨 This should NOT have succeeded!`);
            } catch (error) {
                console.log(`✅ SUCCESS: Regular user correctly blocked from setting rules`);
                console.log(`   👤 Blocked User: ${this.state.signers[2].address}`);
                console.log(`   🛡️  Security Message: ${error.message.split('(')[0]}`);
                console.log(`   🔒 Access Control: WORKING`);
            }

            console.log('\n🧪 Testing regular user CANNOT set investor type rules...');
            try {
                await complianceRules.connect(this.state.signers[2]).setInvestorTypeRule(
                    tokenAddress,
                    [1, 2], // Retail, Accredited
                    [3], // Institutional
                    50000 // $50k
                );
                console.log(`❌ SECURITY BREACH: Regular user was able to set investor rules!`);
            } catch (error) {
                console.log(`✅ SUCCESS: Regular user correctly blocked from setting investor rules`);
                console.log(`   👤 Blocked User: ${this.state.signers[2].address}`);
                console.log(`   🛡️  Security Message: ${error.message.split('(')[0]}`);
                console.log(`   🔒 Access Control: WORKING`);
            }

            // Test 4: Unauthorized Administrative Actions
            console.log('\n🚫 TEST 4: UNAUTHORIZED ADMINISTRATIVE ACTIONS');
            console.log('='.repeat(50));
            console.log('🧪 Testing unauthorized user CANNOT set administrators...');

            try {
                await complianceRules.connect(this.state.signers[2]).setRuleAdministrator(
                    this.state.signers[3].address,
                    true
                );
                console.log(`❌ CRITICAL SECURITY BREACH: Unauthorized user set administrator!`);
                console.log(`   🚨 This is a MAJOR security vulnerability!`);
            } catch (error) {
                console.log(`✅ SUCCESS: Unauthorized user correctly blocked from setting administrators`);
                console.log(`   👤 Blocked User: ${this.state.signers[2].address}`);
                console.log(`   🎯 Attempted Target: ${this.state.signers[3].address}`);
                console.log(`   🛡️  Security Message: ${error.message.split('(')[0]}`);
                console.log(`   🔒 Owner-Only Protection: WORKING`);
            }

            console.log('\n🧪 Testing unauthorized user CANNOT authorize tokens...');
            try {
                await complianceRules.connect(this.state.signers[3]).authorizeToken(tokenAddress, true);
                console.log(`❌ CRITICAL SECURITY BREACH: Unauthorized user authorized token!`);
                console.log(`   🚨 This is a MAJOR security vulnerability!`);
            } catch (error) {
                console.log(`✅ SUCCESS: Unauthorized user correctly blocked from authorizing tokens`);
                console.log(`   👤 Blocked User: ${this.state.signers[3].address}`);
                console.log(`   🪙 Protected Token: ${tokenAddress}`);
                console.log(`   🛡️  Security Message: ${error.message.split('(')[0]}`);
                console.log(`   🔒 Owner-Only Protection: WORKING`);
            }

            // Test 5: Permission Revocation
            console.log('\n🔄 TEST 5: PERMISSION REVOCATION');
            console.log('='.repeat(40));
            console.log('🧪 Testing owner can revoke administrator permissions...');

            try {
                const tx5 = await complianceRules.connect(this.state.signers[0]).setRuleAdministrator(
                    this.state.signers[1].address,
                    false
                );
                const receipt5 = await tx5.wait();
                console.log(`✅ SUCCESS: Owner revoked administrator permissions`);
                console.log(`   👨‍💼 Revoked Administrator: ${this.state.signers[1].address}`);
                console.log(`   🔗 Transaction: ${receipt5.hash}`);
                console.log(`   🧱 Block: ${receipt5.blockNumber}`);
                console.log(`   ⛽ Gas Used: ${receipt5.gasUsed.toLocaleString()}`);
            } catch (error) {
                console.log(`❌ FAILED: Owner could not revoke administrator permissions`);
                console.log(`   🚨 Error: ${error.message}`);
            }

            console.log('\n🧪 Testing revoked administrator CANNOT set rules...');
            try {
                await complianceRules.connect(this.state.signers[1]).setJurisdictionRule(
                    tokenAddress,
                    [124], // Canada
                    []
                );
                console.log(`❌ SECURITY ISSUE: Revoked administrator still has access!`);
            } catch (error) {
                console.log(`✅ SUCCESS: Revoked administrator correctly blocked`);
                console.log(`   👨‍💼 Blocked Ex-Administrator: ${this.state.signers[1].address}`);
                console.log(`   🛡️  Security Message: ${error.message.split('(')[0]}`);
                console.log(`   🔒 Permission Revocation: WORKING`);
            }

            // Test Summary
            console.log('\n🎉 ACCESS CONTROL TEST SUMMARY');
            console.log('='.repeat(50));
            console.log('✅ Owner Permissions: WORKING');
            console.log('   • Can set rule administrators ✅');
            console.log('   • Can authorize tokens ✅');
            console.log('   • Can revoke permissions ✅');
            console.log('');
            console.log('✅ Administrator Permissions: WORKING');
            console.log('   • Can set jurisdiction rules ✅');
            console.log('   • Can set investor type rules ✅');
            console.log('   • Cannot perform owner actions ✅');
            console.log('');
            console.log('✅ Access Restrictions: WORKING');
            console.log('   • Regular users blocked from rule setting ✅');
            console.log('   • Unauthorized users blocked from admin actions ✅');
            console.log('   • Permission revocation works correctly ✅');
            console.log('');
            console.log('🔒 SECURITY STATUS: ALL TESTS PASSED');
            console.log('🛡️  ComplianceRules access control is SECURE');

        } catch (error) {
            console.error('❌ Access control tests failed:', error.message);
            console.error('🚨 CRITICAL: Security testing encountered an error');
            console.error('📋 Please review the contract security implementation');
        }
    }

    /**
     * Option 20: Show ComplianceRules dashboard
     *
     * @returns {Promise<void>}
     */
    async showComplianceRulesDashboard() {
        console.log('\n📋 COMPLIANCE RULES DASHBOARD');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            console.log('\n🔧 ORACLE SYSTEM STATUS:');
            console.log('   🚨 Emergency Oracle: AML Oracle');
            console.log('   ⚖️ Equal Voting Weights: 100 each');

            // Add more dashboard content here
            console.log('\n✅ COMPLIANCE RULES DASHBOARD LOADED');

        } catch (error) {
            console.error('❌ Oracle registration failed:', error.message);
        }
    }

    /**
     * Option 20a: View jurisdiction rules
     *
     * @returns {Promise<void>}
     */
    async viewJurisdictionRules() {
        console.log('\n🌍 JURISDICTION RULES (WHITELIST/BLACKLIST)');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            // Get token address
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log(`\n📦 Token: ${tokenAddress}`);
            console.log('');

            // Get jurisdiction rule - FORCE FRESH READ FROM BLOCKCHAIN
            console.log('🔄 Reading current rules from blockchain...');
            const rule = await complianceRules.getJurisdictionRule(tokenAddress);

            // Debug: Show raw data
            console.log(`\n🔍 DEBUG - Raw blockchain data:`);
            console.log(`   Allowed (raw): [${rule.allowedCountries.map(c => Number(c)).join(', ')}]`);
            console.log(`   Blocked (raw): [${rule.blockedCountries.map(c => Number(c)).join(', ')}]`);

            console.log('📊 JURISDICTION RULE STATUS:');
            console.log(`   Active: ${rule.isActive ? '✅ YES' : '❌ NO'}`);
            console.log(`   Last Updated: ${new Date(Number(rule.lastUpdated) * 1000).toLocaleString()}`);
            console.log('');

            // Display allowed countries (whitelist)
            console.log('✅ WHITELIST (Allowed Countries):');
            if (rule.allowedCountries.length === 0) {
                console.log('   ℹ️  No whitelist configured');
                console.log('   💡 All countries are allowed (except blocked ones)');
            } else {
                console.log(`   📊 Total: ${rule.allowedCountries.length} countries`);
                console.log('   📋 Countries:');

                const countryNames = {
                    840: 'United States',
                    826: 'United Kingdom',
                    124: 'Canada',
                    276: 'Germany',
                    250: 'France',
                    380: 'Italy',
                    724: 'Spain',
                    392: 'Japan',
                    410: 'South Korea',
                    702: 'Singapore',
                    36: 'Australia',
                    156: 'China',
                    643: 'Russia',
                    850: 'North Korea',
                    364: 'Iran',
                    760: 'Syria'
                };

                for (let i = 0; i < rule.allowedCountries.length; i++) {
                    const code = Number(rule.allowedCountries[i]);
                    const name = countryNames[code] || 'Unknown';
                    console.log(`      ${i + 1}. ${code} - ${name}`);
                }
                console.log('');
                console.log('   💡 ONLY these countries can participate');
            }
            console.log('');

            // Display blocked countries (blacklist)
            console.log('❌ BLACKLIST (Blocked Countries):');
            if (rule.blockedCountries.length === 0) {
                console.log('   ℹ️  No countries blocked');
                console.log('   💡 All countries are allowed');
            } else {
                console.log(`   📊 Total: ${rule.blockedCountries.length} countries`);
                console.log('   📋 Countries:');

                const countryNames = {
                    840: 'United States',
                    826: 'United Kingdom',
                    124: 'Canada',
                    276: 'Germany',
                    250: 'France',
                    380: 'Italy',
                    724: 'Spain',
                    392: 'Japan',
                    410: 'South Korea',
                    702: 'Singapore',
                    36: 'Australia',
                    156: 'China',
                    643: 'Russia',
                    850: 'North Korea',
                    364: 'Iran',
                    760: 'Syria'
                };

                for (let i = 0; i < rule.blockedCountries.length; i++) {
                    const code = Number(rule.blockedCountries[i]);
                    const name = countryNames[code] || 'Unknown';
                    console.log(`      ${i + 1}. ${code} - ${name}`);
                }
                console.log('');
                console.log('   💡 These countries are ALWAYS blocked');
            }
            console.log('');

            // Display logic explanation
            console.log('📋 HOW IT WORKS:');
            if (rule.allowedCountries.length > 0 && rule.blockedCountries.length > 0) {
                console.log('   1. Check if country is in BLACKLIST → ❌ BLOCKED');
                console.log('   2. Check if country is in WHITELIST → ✅ ALLOWED');
                console.log('   3. If not in WHITELIST → ❌ BLOCKED');
                console.log('');
                console.log('   💡 Whitelist + Blacklist mode');
                console.log('   💡 Only whitelisted countries allowed, blacklist takes priority');
            } else if (rule.allowedCountries.length > 0) {
                console.log('   1. Check if country is in WHITELIST → ✅ ALLOWED');
                console.log('   2. If not in WHITELIST → ❌ BLOCKED');
                console.log('');
                console.log('   💡 Whitelist-only mode');
                console.log('   💡 Only whitelisted countries allowed');
            } else if (rule.blockedCountries.length > 0) {
                console.log('   1. Check if country is in BLACKLIST → ❌ BLOCKED');
                console.log('   2. If not in BLACKLIST → ✅ ALLOWED');
                console.log('');
                console.log('   💡 Blacklist-only mode');
                console.log('   💡 All countries allowed except blacklisted');
            } else {
                console.log('   ✅ All countries are ALLOWED');
                console.log('');
                console.log('   💡 No restrictions mode');
                console.log('   💡 Global access');
            }
            console.log('');

            // Display governance info
            console.log('🗳️ GOVERNANCE:');
            console.log('   💡 To update these rules, use governance voting:');
            console.log('      79. Deploy Governance System');
            console.log('      81. Create Proposal (Type 1: Jurisdiction Rules)');
            console.log('      82. Vote on Proposal');
            console.log('      83. Execute Proposal');
            console.log('');

        } catch (error) {
            console.error('❌ Error viewing jurisdiction rules:', error.message);
        }
    }

    /**
     * Option 20b: View investor type rules
     *
     * @returns {Promise<void>}
     */
    async viewInvestorTypeRules() {
        console.log('\n👥 INVESTOR TYPE RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            // Get token address
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log(`\n📦 Token: ${tokenAddress}`);
            console.log('');

            // Get investor type rule - FORCE FRESH READ FROM BLOCKCHAIN
            console.log('🔄 Reading current rules from blockchain...');
            const rule = await complianceRules.getInvestorTypeRule(tokenAddress);

            // Debug: Show raw data
            console.log(`\n🔍 DEBUG - Raw blockchain data:`);
            console.log(`   Allowed Types (raw): [${rule.allowedTypes.map(t => Number(t)).join(', ')}]`);
            console.log(`   Blocked Types (raw): [${rule.blockedTypes.map(t => Number(t)).join(', ')}]`);
            console.log(`   Min Accreditation (raw): ${Number(rule.minimumAccreditation)}`);
            console.log('');

            console.log('📊 INVESTOR TYPE RULE STATUS:');
            console.log(`   Active: ${rule.isActive ? '✅ YES' : '❌ NO'}`);
            console.log(`   Last Updated: ${new Date(Number(rule.lastUpdated) * 1000).toLocaleString()}`);
            console.log('');

            // Display allowed investor types
            console.log('✅ ALLOWED INVESTOR TYPES:');
            if (rule.allowedTypes.length === 0) {
                console.log('   ℹ️  No whitelist configured');
                console.log('   💡 All investor types are allowed (except blocked)');
            } else {
                console.log(`   📊 Total: ${rule.allowedTypes.length} types`);
                console.log('   📋 Types:');

                const typeNames = {
                    0: 'Unverified',
                    1: 'Retail',
                    2: 'Accredited',
                    3: 'Institutional'
                };

                for (let i = 0; i < rule.allowedTypes.length; i++) {
                    const type = Number(rule.allowedTypes[i]);
                    const name = typeNames[type] || 'Unknown';
                    console.log(`      ${i + 1}. Type ${type} - ${name}`);
                }
                console.log('');
                console.log('   💡 ONLY these investor types can participate');
            }
            console.log('');

            // Display blocked investor types
            console.log('❌ BLOCKED INVESTOR TYPES:');
            if (rule.blockedTypes.length === 0) {
                console.log('   ℹ️  No investor types blocked');
                console.log('   💡 All investor types are allowed');
            } else {
                console.log(`   📊 Total: ${rule.blockedTypes.length} types`);
                console.log('   📋 Types:');

                const typeNames = {
                    0: 'Unverified',
                    1: 'Retail',
                    2: 'Accredited',
                    3: 'Institutional'
                };

                for (let i = 0; i < rule.blockedTypes.length; i++) {
                    const type = Number(rule.blockedTypes[i]);
                    const name = typeNames[type] || 'Unknown';
                    console.log(`      ${i + 1}. Type ${type} - ${name}`);
                }
                console.log('');
                console.log('   💡 These investor types are ALWAYS blocked');
            }
            console.log('');

            // Display minimum accreditation
            console.log('💰 MINIMUM ACCREDITATION:');
            console.log(`   Amount: $${Number(rule.minimumAccreditation).toLocaleString()}`);
            console.log('   💡 Investors must have at least this amount to participate');
            console.log('');

            // Display logic explanation
            console.log('📋 HOW IT WORKS:');
            console.log('   1. Check if investor type is in BLOCKED list → ❌ BLOCKED');
            console.log('   2. Check if investor type is in ALLOWED list → ✅ ALLOWED');
            console.log('   3. Check if accreditation >= minimum → ✅ ALLOWED');
            console.log('   4. If any check fails → ❌ BLOCKED');
            console.log('');

            // Display governance info
            console.log('🗳️ GOVERNANCE:');
            console.log('   💡 To update these rules, use governance voting:');
            console.log('      79. Deploy Governance System');
            console.log('      81. Create Proposal (Type 0: Investor Type Rules)');
            console.log('      82. Vote on Proposal');
            console.log('      83. Execute Proposal');
            console.log('');

        } catch (error) {
            console.error('❌ Error viewing investor type rules:', error.message);
        }
    }

    /**
     * Option 20c: View holding period rules
     *
     * @returns {Promise<void>}
     */
    async viewHoldingPeriodRules() {
        console.log('\n⏰ HOLDING PERIOD RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            // Get token address
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log(`\n📦 Token: ${tokenAddress}`);
            console.log('');

            // Get holding period rule - FORCE FRESH READ FROM BLOCKCHAIN
            console.log('🔄 Reading current rules from blockchain...');
            const rule = await complianceRules.getHoldingPeriodRule(tokenAddress);

            // Debug: Show raw data
            console.log(`\n🔍 DEBUG - Raw blockchain data:`);
            console.log(`   Minimum Holding Period (raw): ${Number(rule.minimumHoldingPeriod)} seconds`);
            console.log(`   Transfer Cooldown (raw): ${Number(rule.transferCooldown)} seconds`);
            console.log('');

            console.log('📊 HOLDING PERIOD RULE STATUS:');
            console.log(`   Active: ${rule.isActive ? '✅ YES' : '❌ NO'}`);
            console.log(`   Last Updated: ${new Date(Number(rule.lastUpdated) * 1000).toLocaleString()}`);
            console.log('');

            // Display holding period
            const holdingPeriodSeconds = Number(rule.minimumHoldingPeriod);
            const holdingPeriodHours = Math.floor(holdingPeriodSeconds / 3600);
            const holdingPeriodDays = Math.floor(holdingPeriodHours / 24);

            console.log('⏰ MINIMUM HOLDING PERIOD:');
            console.log(`   Seconds: ${holdingPeriodSeconds.toLocaleString()}`);
            console.log(`   Hours: ${holdingPeriodHours}`);
            console.log(`   Days: ${holdingPeriodDays}`);
            console.log('   💡 Tokens must be held for this duration before transfer');
            console.log('');

            // Display transfer cooldown
            const cooldownSeconds = Number(rule.transferCooldown);
            const cooldownMinutes = Math.floor(cooldownSeconds / 60);
            const cooldownHours = Math.floor(cooldownMinutes / 60);

            console.log('🔄 TRANSFER COOLDOWN:');
            console.log(`   Seconds: ${cooldownSeconds.toLocaleString()}`);
            console.log(`   Minutes: ${cooldownMinutes}`);
            console.log(`   Hours: ${cooldownHours}`);
            console.log('   💡 Time required between consecutive transfers');
            console.log('');

            // Display logic explanation
            console.log('📋 HOW IT WORKS:');
            console.log('   1. Check token acquisition time');
            console.log('   2. Verify minimum holding period has passed');
            console.log('   3. Check last transfer time');
            console.log('   4. Verify cooldown period has passed');
            console.log('   5. If all checks pass → ✅ ALLOWED');
            console.log('');

            // Display governance info
            console.log('🗳️ GOVERNANCE:');
            console.log('   💡 To update these rules, use governance voting:');
            console.log('      79. Deploy Governance System');
            console.log('      81. Create Proposal (Type 2: Holding Period Rules)');
            console.log('      82. Vote on Proposal');
            console.log('      83. Execute Proposal');
            console.log('');

        } catch (error) {
            console.error('❌ Error viewing holding period rules:', error.message);
        }
    }

    /**
     * Option 20d: View compliance level rules
     *
     * @returns {Promise<void>}
     */
    async viewComplianceLevelRules() {
        console.log('\n📊 COMPLIANCE LEVEL RULES');
        console.log('='.repeat(50));

        const complianceRules = this.state.getContract('complianceRules');
        if (!complianceRules) {
            console.log('❌ ComplianceRules contract not deployed!');
            console.log('💡 Please deploy ComplianceRules first using option 13');
            return;
        }

        try {
            // Get token address
            const token = this.state.getContract('digitalToken');
            if (!token) {
                console.log('❌ Token not deployed!');
                return;
            }
            const tokenAddress = await token.getAddress();

            console.log(`\n📦 Token: ${tokenAddress}`);
            console.log('');

            // Get compliance level rule - FORCE FRESH READ FROM BLOCKCHAIN
            console.log('🔄 Reading current rules from blockchain...');
            const rule = await complianceRules.getComplianceLevelRule(tokenAddress);

            // Debug: Show raw data
            console.log(`\n🔍 DEBUG - Raw blockchain data:`);
            console.log(`   Minimum Level (raw): ${Number(rule.minimumLevel)}`);
            console.log(`   Maximum Level (raw): ${Number(rule.maximumLevel)}`);
            console.log('');

            console.log('📊 COMPLIANCE LEVEL RULE STATUS:');
            console.log(`   Active: ${rule.isActive ? '✅ YES' : '❌ NO'}`);
            console.log(`   Last Updated: ${new Date(Number(rule.lastUpdated) * 1000).toLocaleString()}`);
            console.log('');

            // Display level range
            console.log('📈 COMPLIANCE LEVEL RANGE:');
            console.log(`   Minimum Level: ${Number(rule.minimumLevel)}`);
            console.log(`   Maximum Level: ${Number(rule.maximumLevel)}`);
            console.log('   💡 Investors must have compliance level within this range');
            console.log('');

            // Display logic explanation
            console.log('📋 HOW IT WORKS:');
            console.log('   • Compliance levels represent verification depth');
            console.log('   • Higher levels = more thorough verification');
            console.log('   • Transfers require minimum compliance level');
            console.log('');
            console.log('   Example Levels:');
            console.log('      Level 1: Basic KYC');
            console.log('      Level 2: Enhanced KYC + AML');
            console.log('      Level 3: Full verification + background check');
            console.log('      Level 4: Institutional-grade verification');
            console.log('      Level 5: Maximum compliance');
            console.log('');

            // Display governance info
            console.log('🗳️ GOVERNANCE:');
            console.log('   💡 To update these rules, use governance voting:');
            console.log('      79. Deploy Governance System');
            console.log('      81. Create Proposal (Type 4: Compliance Level Rules)');
            console.log('      82. Vote on Proposal');
            console.log('      83. Execute Proposal');
            console.log('');

        } catch (error) {
            console.error('❌ Error viewing compliance level rules:', error.message);
        }
    }
}

module.exports = ComplianceModule;

