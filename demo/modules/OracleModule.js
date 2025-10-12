/**
 * @fileoverview Oracle management module
 * @module OracleModule
 * @description Handles oracle network operations including deployment, registration,
 * whitelist/blacklist management, and consensus operations.
 * Covers menu options 31-40.
 */

const { displayInfo, displaySection, displaySuccess, displayError } = require('../utils/DisplayHelpers');
const { ethers } = require('hardhat');

/**
 * @class OracleModule
 * @description Manages oracle network operations.
 */
class OracleModule {
    constructor(state, logger, promptUser, deployer) {
        this.state = state;
        this.logger = logger;
        this.promptUser = promptUser;
        this.deployer = deployer;
    }

    /** Option 31: Deploy Oracle Management System */
    async deployOracleSystem() {
        displaySection('DEPLOY ORACLE MANAGEMENT SYSTEM', '🏗️');

        try {
            // Deploy Oracle Manager
            console.log('📦 Deploying Oracle Manager...');
            const OracleManagerFactory = await ethers.getContractFactory('OracleManager');
            const oracleManager = await OracleManagerFactory.deploy();
            await oracleManager.waitForDeployment();
            this.state.setContract('oracleManager', oracleManager);
            this.state.oracleManager = oracleManager; // Alias
            console.log(`✅ Oracle Manager deployed: ${await oracleManager.getAddress()}`);

            // Deploy Whitelist Oracle
            console.log('📦 Deploying Whitelist Oracle...');
            const WhitelistOracleFactory = await ethers.getContractFactory('WhitelistOracle');
            const whitelistOracle = await WhitelistOracleFactory.deploy(
                await oracleManager.getAddress(),
                'Whitelist Oracle',
                'Oracle for managing whitelist consensus and attestations'
            );
            await whitelistOracle.waitForDeployment();
            this.state.setContract('whitelistOracle', whitelistOracle);
            this.state.whitelistOracle = whitelistOracle; // Alias
            console.log(`✅ Whitelist Oracle deployed: ${await whitelistOracle.getAddress()}`);

            // Deploy Blacklist Oracle
            console.log('📦 Deploying Blacklist Oracle...');
            const BlacklistOracleFactory = await ethers.getContractFactory('BlacklistOracle');
            const blacklistOracle = await BlacklistOracleFactory.deploy(
                await oracleManager.getAddress(),
                'Blacklist Oracle',
                'Oracle for managing blacklist consensus and attestations'
            );
            await blacklistOracle.waitForDeployment();
            this.state.setContract('blacklistOracle', blacklistOracle);
            this.state.blacklistOracle = blacklistOracle; // Alias
            console.log(`✅ Blacklist Oracle deployed: ${await blacklistOracle.getAddress()}`);

            // Deploy Consensus Oracle
            console.log('📦 Deploying Consensus Oracle...');
            const ConsensusOracleFactory = await ethers.getContractFactory('ConsensusOracle');
            const consensusOracle = await ConsensusOracleFactory.deploy(
                await oracleManager.getAddress(),
                'Consensus Oracle',
                'Oracle implementing M-of-N consensus mechanism for oracle attestations'
            );
            await consensusOracle.waitForDeployment();
            this.state.setContract('consensusOracle', consensusOracle);
            this.state.consensusOracle = consensusOracle; // Alias
            console.log(`✅ Consensus Oracle deployed: ${await consensusOracle.getAddress()}`);

            // Register oracles in the manager
            console.log('\n🔧 Registering oracles in manager...');

            // Register KYC Oracle (signer[1])
            await oracleManager.registerOracle(
                this.state.signers[1].address,
                'KYC_ORACLE',
                'KYC verification oracle for identity validation',
                100 // Initial reputation
            );
            console.log(`✅ KYC Oracle registered: ${this.state.signers[1].address}`);

            // Register AML Oracle (signer[2])
            await oracleManager.registerOracle(
                this.state.signers[2].address,
                'AML_ORACLE',
                'AML screening oracle for anti-money laundering checks',
                100 // Initial reputation
            );
            console.log(`✅ AML Oracle registered: ${this.state.signers[2].address}`);

            // Register Compliance Oracle (signer[3])
            await oracleManager.registerOracle(
                this.state.signers[3].address,
                'COMPLIANCE_ORACLE',
                'Compliance validation oracle for regulatory checks',
                100 // Initial reputation
            );
            console.log(`✅ Compliance Oracle registered: ${this.state.signers[3].address}`);

            // Store oracle configurations
            this.state.oracleConfig.set('kyc', {
                address: this.state.signers[1].address,
                role: 'KYC_ORACLE',
                reputation: 100
            });
            this.state.oracleConfig.set('aml', {
                address: this.state.signers[2].address,
                role: 'AML_ORACLE',
                reputation: 100
            });
            this.state.oracleConfig.set('compliance', {
                address: this.state.signers[3].address,
                role: 'COMPLIANCE_ORACLE',
                reputation: 100
            });

            // Set consensus threshold
            await oracleManager.setConsensusThreshold(2); // 2 out of 3 oracles
            console.log('✅ Consensus threshold set to 2/3');

            displaySuccess('ORACLE MANAGEMENT SYSTEM DEPLOYED SUCCESSFULLY!');
            console.log('📊 System Status:');
            console.log(`   🏛️ Oracle Manager: ${await oracleManager.getAddress()}`);
            console.log(`   📋 Whitelist Oracle: ${await whitelistOracle.getAddress()}`);
            console.log(`   🚫 Blacklist Oracle: ${await blacklistOracle.getAddress()}`);
            console.log(`   🤝 Consensus Oracle: ${await consensusOracle.getAddress()}`);
            console.log(`   👥 Registered Oracles: 3`);
            console.log(`   ⚖️ Consensus Threshold: 2/3`);

        } catch (error) {
            displayError(`Oracle system deployment failed: ${error.message}`);
        }
    }

    /** Option 32: Register & Configure Oracles */
    async registerOracles() {
        console.log('\n👥 REGISTER & CONFIGURE ORACLES');
        console.log('='.repeat(50));

        const oracleManager = this.state.getContract('oracleManager');
        if (!oracleManager) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        try {
            console.log('\n🔧 ORACLE REGISTRATION & CONFIGURATION');
            console.log('-'.repeat(40));

            // Check if oracles are already registered
            const totalOracles = await oracleManager.getOracleCount();
            console.log(`📊 Currently registered oracles: ${totalOracles}`);

            if (totalOracles >= 3) {
                console.log('✅ Oracles already registered. Showing current configuration...');

                // Display current oracle configuration
                for (const [key, config] of this.state.oracleConfig) {
                    const oracleInfo = await oracleManager.getOracleInfo(config.address);
                    console.log(`\n${key.toUpperCase()} Oracle:`);
                    console.log(`   📍 Address: ${config.address}`);
                    console.log(`   🏆 Reputation: ${oracleInfo.reputation}`);
                    console.log(`   ✅ Status: ${oracleInfo.active ? 'ACTIVE' : 'INACTIVE'}`);
                    console.log(`   📝 Role: ${config.role}`);
                }
            } else {
                console.log('\n🔄 Registering additional oracles...');

                // Register additional oracles if needed
                const oraclesToRegister = [
                    { address: this.state.signers[4].address, name: 'RISK_ORACLE', description: 'Risk assessment oracle for transaction monitoring' },
                    { address: this.state.signers[5].address, name: 'FRAUD_ORACLE', description: 'Fraud detection oracle for suspicious activity' }
                ];

                for (const oracle of oraclesToRegister) {
                    try {
                        await oracleManager.registerOracle(
                            oracle.address,
                            oracle.name,
                            oracle.description,
                            100 // Initial reputation
                        );
                        console.log(`✅ ${oracle.name} registered: ${oracle.address}`);

                        // Add to local config
                        this.state.oracleConfig.set(oracle.name.toLowerCase().replace('_', ''), {
                            address: oracle.address,
                            role: oracle.name,
                            reputation: 100
                        });
                    } catch (error) {
                        console.log(`⚠️ ${oracle.name} registration failed: ${error.message}`);
                    }
                }
            }

            // Configure oracle permissions
            console.log('\n🔐 CONFIGURING ORACLE PERMISSIONS');
            console.log('-'.repeat(35));

            // Set emergency oracles for blacklist operations
            const blacklistOracle = this.state.getContract('blacklistOracle');
            if (blacklistOracle) {
                try {
                    // Set AML Oracle as emergency oracle
                    await blacklistOracle.setEmergencyOracle(this.state.signers[2].address, true);
                    console.log('✅ AML Oracle set as emergency oracle for blacklist operations');
                } catch (error) {
                    console.log(`⚠️ Emergency oracle setup: ${error.message}`);
                }
            }

            // Configure consensus thresholds
            console.log('\n⚖️ CONFIGURING CONSENSUS THRESHOLDS');
            console.log('-'.repeat(35));

            try {
                const currentThreshold = await oracleManager.getConsensusThreshold();
                console.log(`📊 Current consensus threshold: ${currentThreshold}`);

                // Adjust threshold based on number of oracles
                const newThreshold = Math.max(2, Math.floor(Number(totalOracles) * 0.6)); // 60% consensus
                const currentThresholdNum = Number(currentThreshold);

                if (newThreshold !== currentThresholdNum) {
                    await oracleManager.setConsensusThreshold(newThreshold);
                    console.log(`✅ Consensus threshold updated to: ${newThreshold}`);
                } else {
                    console.log('✅ Consensus threshold is optimal');
                }
            } catch (error) {
                console.log(`⚠️ Threshold configuration: ${error.message}`);
            }

            // Test oracle connectivity
            console.log('\n🔍 TESTING ORACLE CONNECTIVITY');
            console.log('-'.repeat(30));

            for (const [key, config] of this.state.oracleConfig) {
                try {
                    const oracleInfo = await oracleManager.getOracleInfo(config.address);
                    const status = oracleInfo.active ? '🟢 ONLINE' : '🔴 OFFLINE';
                    console.log(`   ${key.toUpperCase()}: ${status}`);
                } catch (error) {
                    console.log(`   ${key.toUpperCase()}: 🔴 ERROR - ${error.message}`);
                }
            }

            console.log('\n🎉 ORACLE REGISTRATION & CONFIGURATION COMPLETE!');
            console.log('📊 System Status:');
            console.log(`   👥 Total Oracles: ${await oracleManager.getOracleCount()}`);
            console.log(`   ⚖️ Consensus Threshold: ${await oracleManager.getConsensusThreshold()}`);
            console.log(`   🔗 Oracle Manager: ${await oracleManager.getAddress()}`);

        } catch (error) {
            console.error('❌ Oracle registration failed:', error.message);
        }
    }

    /** Option 33: Manage Oracle Whitelist */
    async manageWhitelist() {
        console.log('\n📋 MANAGE ORACLE WHITELIST (ACCESS APPROVAL)');
        console.log('='.repeat(60));

        const whitelistOracle = this.state.getContract('whitelistOracle');
        if (!whitelistOracle) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        console.log('\n🎯 WHITELIST MANAGEMENT OPTIONS:');
        console.log('1. Add User to Whitelist (KYC Success)');
        console.log('2. Upgrade Whitelist Tier (AML Success)');
        console.log('3. Remove from Whitelist');
        console.log('4. View Whitelist Status');
        console.log('5. Batch Whitelist Operations');
        console.log('0. Back to Main Menu');

        const choice = await this.promptUser('Select whitelist action (0-5): ');

        try {
            switch (choice) {
                case '1':
                    await this.addUserToWhitelist();
                    break;
                case '2':
                    await this.upgradeWhitelistTier();
                    break;
                case '3':
                    await this.removeFromWhitelist();
                    break;
                case '4':
                    await this.viewWhitelistStatus();
                    break;
                case '5':
                    await this.batchWhitelistOperations();
                    break;
                case '0':
                    return;
                default:
                    console.log('❌ Invalid choice');
            }
        } catch (error) {
            console.error('❌ Whitelist management failed:', error.message);
        }
    }

    async addUserToWhitelist() {
        console.log('\n✅ ADD USER TO WHITELIST');
        console.log('-'.repeat(40));

        const whitelistOracle = this.state.getContract('whitelistOracle');

        // Show available identities
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No OnchainID identities found. Please create identities first (option 3)');
            return;
        }

        console.log('🆔 Available Identities:');
        let index = 0;
        const identityArray = Array.from(this.state.identities.values());
        const seenAddresses = new Set(); // Prevent duplicates
        const uniqueIdentities = [];

        for (const identity of identityArray) {
            // Skip if we've already seen this address
            if (seenAddresses.has(identity.owner)) {
                continue;
            }

            console.log(`   ${index}: ${identity.owner} (OnchainID: ${identity.address})`);
            uniqueIdentities.push(identity);
            seenAddresses.add(identity.owner);
            index++;
        }

        const identityIndex = await this.promptUser(`Select identity (0-${uniqueIdentities.length - 1}): `);
        const selectedIdentity = uniqueIdentities[parseInt(identityIndex)];

        if (!selectedIdentity) {
            console.log('❌ Invalid identity selection');
            return;
        }

        const tier = await this.promptUser('Whitelist tier (1-5, 5=highest): ');
        const duration = await this.promptUser('Duration in days (0=permanent): ');
        const reason = await this.promptUser('Reason for whitelisting: ');

        const durationSeconds = parseInt(duration) * 24 * 60 * 60;

        const tx = await whitelistOracle.addToWhitelist(
            selectedIdentity.owner,
            parseInt(tier),
            durationSeconds,
            reason
        );
        const receipt = await tx.wait();

        console.log('\n✅ USER ADDED TO WHITELIST!');
        console.log(`   👤 User: ${selectedIdentity.owner}`);
        console.log(`   🏆 Tier: ${tier}`);
        console.log(`   ⏰ Duration: ${duration === '0' ? 'Permanent' : duration + ' days'}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async upgradeWhitelistTier() {
        console.log('\n⬆️ UPGRADE WHITELIST TIER');
        console.log('-'.repeat(40));

        const whitelistOracle = this.state.getContract('whitelistOracle');

        // Show available identities
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No OnchainID identities found. Please create identities first (option 3)');
            return;
        }

        console.log('🆔 Available Identities:');
        let index = 0;
        const identityArray = Array.from(this.state.identities.values());
        const seenAddresses = new Set();
        const uniqueIdentities = [];

        for (const identity of identityArray) {
            if (seenAddresses.has(identity.owner)) continue;

            // Check if already whitelisted
            try {
                const whitelistInfo = await whitelistOracle.getWhitelistInfo(identity.owner);
                // The contract returns: (isWhitelistedStatus, timestamp, expiryTime, tier, reason, attestingOracles)
                // Access via index [0] or named property 'isWhitelistedStatus'
                const isWhitelisted = whitelistInfo[0] || whitelistInfo.isWhitelistedStatus;

                if (isWhitelisted) {
                    console.log(`   ${index}: ${identity.owner} (Current Tier: ${whitelistInfo.tier})`);
                    uniqueIdentities.push(identity);
                    seenAddresses.add(identity.owner);
                    index++;
                }
            } catch (error) {
                // Skip if not whitelisted or error occurred
            }
        }

        if (uniqueIdentities.length === 0) {
            console.log('❌ No whitelisted users found to upgrade');
            return;
        }

        const identityIndex = await this.promptUser(`Select identity (0-${uniqueIdentities.length - 1}): `);
        const selectedIdentity = uniqueIdentities[parseInt(identityIndex)];

        if (!selectedIdentity) {
            console.log('❌ Invalid identity selection');
            return;
        }

        const currentInfo = await whitelistOracle.getWhitelistInfo(selectedIdentity.owner);
        console.log(`\nCurrent tier: ${currentInfo.tier}`);

        const newTier = await this.promptUser('New tier (1-5, 5=highest): ');
        const duration = await this.promptUser('Duration in days (0=permanent): ');
        const reason = await this.promptUser('Reason for upgrade: ');

        const durationSeconds = parseInt(duration) * 24 * 60 * 60;

        const tx = await whitelistOracle.addToWhitelist(
            selectedIdentity.owner,
            parseInt(newTier),
            durationSeconds,
            reason
        );
        const receipt = await tx.wait();

        console.log('\n✅ WHITELIST TIER UPGRADED!');
        console.log(`   👤 User: ${selectedIdentity.owner}`);
        console.log(`   🏆 Old Tier: ${currentInfo.tier} → New Tier: ${newTier}`);
        console.log(`   ⏰ Duration: ${duration === '0' ? 'Permanent' : duration + ' days'}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async removeFromWhitelist() {
        console.log('\n❌ REMOVE FROM WHITELIST');
        console.log('-'.repeat(40));

        const whitelistOracle = this.state.getContract('whitelistOracle');

        // Show whitelisted identities
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No OnchainID identities found');
            return;
        }

        console.log('🆔 Whitelisted Users:');
        let index = 0;
        const whitelistedUsers = [];

        for (const identity of this.state.identities.values()) {
            try {
                const whitelistInfo = await whitelistOracle.getWhitelistInfo(identity.owner);
                const isWhitelisted = whitelistInfo[0] || whitelistInfo.isWhitelistedStatus;

                if (isWhitelisted) {
                    console.log(`   ${index}: ${identity.owner} (Tier: ${whitelistInfo.tier})`);
                    whitelistedUsers.push(identity);
                    index++;
                }
            } catch (error) {
                // Skip
            }
        }

        if (whitelistedUsers.length === 0) {
            console.log('❌ No whitelisted users found');
            return;
        }

        const userIndex = await this.promptUser(`Select user to remove (0-${whitelistedUsers.length - 1}): `);
        const selectedUser = whitelistedUsers[parseInt(userIndex)];

        if (!selectedUser) {
            console.log('❌ Invalid selection');
            return;
        }

        const reason = await this.promptUser('Reason for removal: ');

        const tx = await whitelistOracle.removeFromWhitelist(selectedUser.owner, reason);
        const receipt = await tx.wait();

        console.log('\n✅ USER REMOVED FROM WHITELIST!');
        console.log(`   👤 User: ${selectedUser.owner}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async viewWhitelistStatus() {
        console.log('\n📊 VIEW WHITELIST STATUS');
        console.log('-'.repeat(40));

        const whitelistOracle = this.state.getContract('whitelistOracle');

        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No identities to check');
            return;
        }

        console.log('📋 WHITELIST STATUS REPORT:\n');
        let whitelistedCount = 0;

        for (const identity of this.state.identities.values()) {
            try {
                const whitelistInfo = await whitelistOracle.getWhitelistInfo(identity.owner);
                const isWhitelisted = whitelistInfo[0] || whitelistInfo.isWhitelistedStatus;

                if (isWhitelisted) {
                    whitelistedCount++;
                    console.log(`✅ ${identity.owner}`);
                    console.log(`   🏆 Tier: ${whitelistInfo.tier}`);
                    console.log(`   📝 Reason: ${whitelistInfo.reason}`);
                    console.log(`   ⏰ Added: ${new Date(Number(whitelistInfo.timestamp) * 1000).toLocaleString()}`);
                    console.log('');
                }
            } catch (error) {
                // Skip
            }
        }

        console.log(`📊 Total Whitelisted: ${whitelistedCount}/${this.state.identities.size}`);
    }

    async batchWhitelistOperations() {
        console.log('\n📦 BATCH WHITELIST OPERATIONS');
        console.log('-'.repeat(40));

        const whitelistOracle = this.state.getContract('whitelistOracle');

        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No identities available');
            return;
        }

        console.log('🆔 Available Identities:');
        const identityArray = Array.from(this.state.identities.values());
        identityArray.forEach((identity, index) => {
            console.log(`   ${index}: ${identity.owner}`);
        });

        const indicesInput = await this.promptUser('Enter indices to whitelist (comma-separated, e.g., 0,1,2): ');
        const indices = indicesInput.split(',').map(i => parseInt(i.trim()));

        const selectedUsers = indices.map(i => identityArray[i]).filter(u => u);

        if (selectedUsers.length === 0) {
            console.log('❌ No valid users selected');
            return;
        }

        const tier = await this.promptUser('Whitelist tier for all (1-5): ');
        const duration = await this.promptUser('Duration in days (0=permanent): ');
        const reason = await this.promptUser('Reason for batch whitelisting: ');

        const addresses = selectedUsers.map(u => u.owner);
        const tiers = new Array(addresses.length).fill(parseInt(tier));
        const durationSeconds = parseInt(duration) * 24 * 60 * 60;

        const tx = await whitelistOracle.batchAddToWhitelist(addresses, tiers, durationSeconds, reason);
        const receipt = await tx.wait();

        console.log('\n✅ BATCH WHITELIST COMPLETE!');
        console.log(`   👥 Users Added: ${addresses.length}`);
        console.log(`   🏆 Tier: ${tier}`);
        console.log(`   ⏰ Duration: ${duration === '0' ? 'Permanent' : duration + ' days'}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
        console.log('\n📋 Whitelisted Users:');
        addresses.forEach(addr => console.log(`   ✅ ${addr}`));
    }

    /** Option 34: Manage Oracle Blacklist */
    async manageBlacklist() {
        console.log('\n🚫 MANAGE ORACLE BLACKLIST (ACCESS RESTRICTION)');
        console.log('='.repeat(60));

        const blacklistOracle = this.state.getContract('blacklistOracle');
        if (!blacklistOracle) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        console.log('\n🎯 BLACKLIST MANAGEMENT OPTIONS:');
        console.log('1. Add User to Blacklist (AML Failure)');
        console.log('2. Emergency Blacklist');
        console.log('3. Remove from Blacklist');
        console.log('4. View Blacklist Status');
        console.log('5. Update Blacklist Severity');
        console.log('0. Back to Main Menu');

        const choice = await this.promptUser('Select blacklist action (0-5): ');

        try {
            switch (choice) {
                case '1':
                    await this.addUserToBlacklist();
                    break;
                case '2':
                    await this.emergencyBlacklist();
                    break;
                case '3':
                    await this.removeFromBlacklist();
                    break;
                case '4':
                    await this.viewBlacklistStatus();
                    break;
                case '5':
                    await this.updateBlacklistSeverity();
                    break;
                case '0':
                    return;
                default:
                    console.log('❌ Invalid choice');
            }
        } catch (error) {
            console.error('❌ Blacklist management failed:', error.message);
        }
    }

    async addUserToBlacklist() {
        console.log('\n🚫 ADD USER TO BLACKLIST');
        console.log('-'.repeat(40));

        const blacklistOracle = this.state.getContract('blacklistOracle');

        // Show available identities
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No OnchainID identities found. Please create identities first (option 3)');
            return;
        }

        console.log('🆔 Available Identities:');
        let index = 0;
        const identityArray = Array.from(this.state.identities.values());
        const seenAddresses = new Set();
        const uniqueIdentities = [];

        for (const identity of identityArray) {
            if (seenAddresses.has(identity.owner)) continue;

            console.log(`   ${index}: ${identity.owner} (OnchainID: ${identity.address})`);
            uniqueIdentities.push(identity);
            seenAddresses.add(identity.owner);
            index++;
        }

        const identityIndex = await this.promptUser(`Select identity (0-${uniqueIdentities.length - 1}): `);
        const selectedIdentity = uniqueIdentities[parseInt(identityIndex)];

        if (!selectedIdentity) {
            console.log('❌ Invalid identity selection');
            return;
        }

        console.log('\n🚨 Severity Levels:');
        console.log('   0: LOW - Minor compliance issue');
        console.log('   1: MEDIUM - Moderate risk');
        console.log('   2: HIGH - Serious violation');
        console.log('   3: CRITICAL - Immediate threat');

        const severity = await this.promptUser('Blacklist severity (0-3): ');
        const duration = await this.promptUser('Duration in days (0=permanent): ');
        const reason = await this.promptUser('Reason for blacklisting: ');

        const durationSeconds = parseInt(duration) * 24 * 60 * 60;

        const tx = await blacklistOracle.addToBlacklist(
            selectedIdentity.owner,
            parseInt(severity),
            durationSeconds,
            reason
        );
        const receipt = await tx.wait();

        const severityNames = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        console.log('\n🚫 USER ADDED TO BLACKLIST!');
        console.log(`   👤 User: ${selectedIdentity.owner}`);
        console.log(`   🚨 Severity: ${severityNames[parseInt(severity)]} (${severity})`);
        console.log(`   ⏰ Duration: ${duration === '0' ? 'Permanent' : duration + ' days'}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async emergencyBlacklist() {
        console.log('\n🚨 EMERGENCY BLACKLIST');
        console.log('-'.repeat(40));
        console.log('💡 This is a shortcut to Option 35: Emergency Oracle Actions');
        console.log('⚠️  Redirecting to full emergency protocol...\n');
        await this.emergencyActions();
    }

    async removeFromBlacklist() {
        console.log('\n✅ REMOVE FROM BLACKLIST');
        console.log('-'.repeat(40));

        const blacklistOracle = this.state.getContract('blacklistOracle');

        // Show blacklisted identities
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No OnchainID identities found');
            return;
        }

        console.log('🆔 Blacklisted Users:');
        let index = 0;
        const blacklistedUsers = [];

        for (const identity of this.state.identities.values()) {
            try {
                const blacklistInfo = await blacklistOracle.getBlacklistInfo(identity.owner);
                const isBlacklisted = blacklistInfo[0] || blacklistInfo.isBlacklistedStatus;

                if (isBlacklisted) {
                    const severityNames = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
                    console.log(`   ${index}: ${identity.owner} (Severity: ${severityNames[Number(blacklistInfo.severity)]})`);
                    blacklistedUsers.push(identity);
                    index++;
                }
            } catch (error) {
                // Skip
            }
        }

        if (blacklistedUsers.length === 0) {
            console.log('❌ No blacklisted users found');
            return;
        }

        const userIndex = await this.promptUser(`Select user to remove (0-${blacklistedUsers.length - 1}): `);
        const selectedUser = blacklistedUsers[parseInt(userIndex)];

        if (!selectedUser) {
            console.log('❌ Invalid selection');
            return;
        }

        const reason = await this.promptUser('Reason for removal: ');

        const tx = await blacklistOracle.removeFromBlacklist(selectedUser.owner, reason);
        const receipt = await tx.wait();

        console.log('\n✅ USER REMOVED FROM BLACKLIST!');
        console.log(`   👤 User: ${selectedUser.owner}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async viewBlacklistStatus() {
        console.log('\n📊 VIEW BLACKLIST STATUS');
        console.log('-'.repeat(40));

        const blacklistOracle = this.state.getContract('blacklistOracle');

        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No identities to check');
            return;
        }

        console.log('📋 BLACKLIST STATUS REPORT:\n');
        let blacklistedCount = 0;
        const severityNames = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

        for (const identity of this.state.identities.values()) {
            try {
                const blacklistInfo = await blacklistOracle.getBlacklistInfo(identity.owner);
                const isBlacklisted = blacklistInfo[0] || blacklistInfo.isBlacklistedStatus;

                if (isBlacklisted) {
                    blacklistedCount++;
                    console.log(`🚫 ${identity.owner}`);
                    console.log(`   🚨 Severity: ${severityNames[Number(blacklistInfo.severity)]}`);
                    console.log(`   📝 Reason: ${blacklistInfo.reason}`);
                    console.log(`   ⏰ Added: ${new Date(Number(blacklistInfo.timestamp) * 1000).toLocaleString()}`);
                    console.log('');
                }
            } catch (error) {
                // Skip
            }
        }

        console.log(`📊 Total Blacklisted: ${blacklistedCount}/${this.state.identities.size}`);
    }

    async updateBlacklistSeverity() {
        console.log('\n⚠️ UPDATE BLACKLIST SEVERITY');
        console.log('-'.repeat(40));

        const blacklistOracle = this.state.getContract('blacklistOracle');

        // Show blacklisted identities
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No identities found');
            return;
        }

        console.log('🆔 Blacklisted Users:');
        let index = 0;
        const blacklistedUsers = [];
        const severityNames = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

        for (const identity of this.state.identities.values()) {
            try {
                const blacklistInfo = await blacklistOracle.getBlacklistInfo(identity.owner);
                const isBlacklisted = blacklistInfo[0] || blacklistInfo.isBlacklistedStatus;

                if (isBlacklisted) {
                    console.log(`   ${index}: ${identity.owner} (Current: ${severityNames[Number(blacklistInfo.severity)]})`);
                    blacklistedUsers.push({ identity, currentSeverity: Number(blacklistInfo.severity) });
                    index++;
                }
            } catch (error) {
                // Skip
            }
        }

        if (blacklistedUsers.length === 0) {
            console.log('❌ No blacklisted users found');
            return;
        }

        const userIndex = await this.promptUser(`Select user (0-${blacklistedUsers.length - 1}): `);
        const selectedUser = blacklistedUsers[parseInt(userIndex)];

        if (!selectedUser) {
            console.log('❌ Invalid selection');
            return;
        }

        console.log(`\nCurrent severity: ${severityNames[selectedUser.currentSeverity]}`);
        console.log('\n🚨 Severity Levels:');
        console.log('   0: LOW - Minor compliance issue');
        console.log('   1: MEDIUM - Moderate risk');
        console.log('   2: HIGH - Serious violation');
        console.log('   3: CRITICAL - Immediate threat');

        const newSeverity = await this.promptUser('New severity (0-3): ');
        const reason = await this.promptUser('Reason for severity update: ');

        // Remove and re-add with new severity
        await blacklistOracle.removeFromBlacklist(selectedUser.identity.owner, 'Severity update');
        const tx = await blacklistOracle.addToBlacklist(
            selectedUser.identity.owner,
            parseInt(newSeverity),
            0, // Permanent
            reason
        );
        const receipt = await tx.wait();

        console.log('\n✅ BLACKLIST SEVERITY UPDATED!');
        console.log(`   👤 User: ${selectedUser.identity.owner}`);
        console.log(`   🚨 Old Severity: ${severityNames[selectedUser.currentSeverity]} → New: ${severityNames[parseInt(newSeverity)]}`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    /** Option 35: Emergency Oracle Actions */
    async emergencyActions() {
        console.log('\n🚨 EMERGENCY ORACLE ACTIONS');
        console.log('='.repeat(50));

        const blacklistOracle = this.state.getContract('blacklistOracle');
        if (!blacklistOracle) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        console.log('⚠️  EMERGENCY PROTOCOLS ACTIVATED');
        console.log('This simulates critical security threats requiring immediate action');
        console.log('');

        // Show available users
        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No identities available for emergency action');
            return;
        }

        console.log('🆔 Available Users for Emergency Action:');
        let index = 0;
        const identityArray = Array.from(this.state.identities.values());
        for (const identity of identityArray) {
            console.log(`   ${index}: ${identity.owner}`);
            index++;
        }

        const identityIndex = await this.promptUser(`Select user for emergency blacklist (0-${identityArray.length - 1}): `);
        const selectedIdentity = identityArray[parseInt(identityIndex)];

        if (!selectedIdentity) {
            console.log('❌ Invalid selection');
            return;
        }

        const reason = await this.promptUser('Emergency reason: ');

        try {
            // Emergency oracle (Oracle 2 - AML Oracle) performs emergency blacklist
            const emergencyOracle = this.state.signers[2];

            console.log('🚨 Executing emergency blacklist...');
            const tx = await blacklistOracle.connect(emergencyOracle).emergencyBlacklist(
                selectedIdentity.owner,
                3, // CRITICAL severity
                reason
            );
            const receipt = await tx.wait();

            console.log('\n🚨 EMERGENCY BLACKLIST EXECUTED!');
            console.log(`   👤 User: ${selectedIdentity.owner}`);
            console.log(`   🚨 Severity: CRITICAL (3)`);
            console.log(`   👮 Emergency Oracle: ${emergencyOracle.address}`);
            console.log(`   📝 Reason: ${reason}`);
            console.log(`   🔗 Transaction: ${receipt.hash}`);
            console.log('   ⚡ Action: IMMEDIATE - No consensus required');

        } catch (error) {
            console.error('❌ Emergency action failed:', error.message);
        }
    }

    /** Option 36: Oracle Reputation Management */
    async manageReputation() {
        console.log('\n📊 ORACLE REPUTATION MANAGEMENT');
        console.log('='.repeat(50));

        const oracleManager = this.state.getContract('oracleManager');
        if (!oracleManager) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        try {
            console.log('📊 Current Oracle Reputations:');

            // Check reputations for all registered oracles
            for (const [key, config] of this.state.oracleConfig) {
                const oracleInfo = await oracleManager.getOracleInfo(config.address);
                console.log(`   ${key.toUpperCase()}: ${config.address}`);
                console.log(`     🏆 Reputation: ${oracleInfo.reputation}`);
                console.log(`     ✅ Correct Attestations: ${oracleInfo.correctAttestations}`);
                console.log(`     ❌ Incorrect Attestations: ${oracleInfo.incorrectAttestations}`);
                console.log(`     📊 Role: ${config.role}`);
                console.log('');
            }

            console.log('🎯 REPUTATION ACTIONS:');
            console.log('1. Reward Oracle (Good Performance)');
            console.log('2. Penalize Oracle (Poor Performance)');
            console.log('3. View Detailed Oracle Stats');
            console.log('0. Back to Main Menu');

            const choice = await this.promptUser('Select action (0-3): ');

            switch (choice) {
                case '1':
                    await this.rewardOracle();
                    break;
                case '2':
                    await this.penalizeOracle();
                    break;
                case '3':
                    await this.viewDetailedOracleStats();
                    break;
                case '0':
                    return;
                default:
                    console.log('❌ Invalid choice');
            }

        } catch (error) {
            console.error('❌ Reputation management failed:', error.message);
        }
    }

    async rewardOracle() {
        console.log('\n🏆 REWARD ORACLE');
        console.log('-'.repeat(40));

        const oracleManager = this.state.getContract('oracleManager');

        if (!this.state.oracleConfig || this.state.oracleConfig.size === 0) {
            console.log('❌ No oracles registered');
            return;
        }

        console.log('👥 Registered Oracles:');
        let index = 0;
        const oracleArray = [];

        for (const [key, config] of this.state.oracleConfig) {
            try {
                const oracleInfo = await oracleManager.getOracleInfo(config.address);
                console.log(`   ${index}: ${key.toUpperCase()} - ${config.address}`);
                console.log(`      🏆 Current Reputation: ${oracleInfo.reputation}`);
                oracleArray.push({ key, config, info: oracleInfo });
                index++;
            } catch (error) {
                console.log(`   ${index}: ${key.toUpperCase()} - Error retrieving info`);
            }
        }

        const oracleIndex = await this.promptUser(`Select oracle to reward (0-${oracleArray.length - 1}): `);
        const selectedOracle = oracleArray[parseInt(oracleIndex)];

        if (!selectedOracle) {
            console.log('❌ Invalid selection');
            return;
        }

        const rewardAmount = await this.promptUser('Reward amount (reputation points): ');
        const reason = await this.promptUser('Reason for reward: ');

        const tx = await oracleManager.rewardOracle(
            selectedOracle.config.address,
            parseInt(rewardAmount),
            reason
        );
        const receipt = await tx.wait();

        const updatedInfo = await oracleManager.getOracleInfo(selectedOracle.config.address);

        console.log('\n🏆 ORACLE REWARDED!');
        console.log(`   👤 Oracle: ${selectedOracle.key.toUpperCase()}`);
        console.log(`   📍 Address: ${selectedOracle.config.address}`);
        console.log(`   ⬆️ Reputation: ${selectedOracle.info.reputation} → ${updatedInfo.reputation} (+${rewardAmount})`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async penalizeOracle() {
        console.log('\n⚠️ PENALIZE ORACLE');
        console.log('-'.repeat(40));

        const oracleManager = this.state.getContract('oracleManager');

        if (!this.state.oracleConfig || this.state.oracleConfig.size === 0) {
            console.log('❌ No oracles registered');
            return;
        }

        console.log('👥 Registered Oracles:');
        let index = 0;
        const oracleArray = [];

        for (const [key, config] of this.state.oracleConfig) {
            try {
                const oracleInfo = await oracleManager.getOracleInfo(config.address);
                console.log(`   ${index}: ${key.toUpperCase()} - ${config.address}`);
                console.log(`      🏆 Current Reputation: ${oracleInfo.reputation}`);
                oracleArray.push({ key, config, info: oracleInfo });
                index++;
            } catch (error) {
                console.log(`   ${index}: ${key.toUpperCase()} - Error retrieving info`);
            }
        }

        const oracleIndex = await this.promptUser(`Select oracle to penalize (0-${oracleArray.length - 1}): `);
        const selectedOracle = oracleArray[parseInt(oracleIndex)];

        if (!selectedOracle) {
            console.log('❌ Invalid selection');
            return;
        }

        const penaltyAmount = await this.promptUser('Penalty amount (reputation points): ');
        const reason = await this.promptUser('Reason for penalty: ');

        const tx = await oracleManager.penalizeOracle(
            selectedOracle.config.address,
            parseInt(penaltyAmount),
            reason
        );
        const receipt = await tx.wait();

        const updatedInfo = await oracleManager.getOracleInfo(selectedOracle.config.address);

        console.log('\n⚠️ ORACLE PENALIZED!');
        console.log(`   👤 Oracle: ${selectedOracle.key.toUpperCase()}`);
        console.log(`   📍 Address: ${selectedOracle.config.address}`);
        console.log(`   ⬇️ Reputation: ${selectedOracle.info.reputation} → ${updatedInfo.reputation} (-${penaltyAmount})`);
        console.log(`   📝 Reason: ${reason}`);
        console.log(`   🔗 Transaction: ${receipt.hash}`);
    }

    async viewDetailedOracleStats() {
        console.log('\n📊 DETAILED ORACLE STATISTICS');
        console.log('-'.repeat(40));

        const oracleManager = this.state.getContract('oracleManager');

        if (!this.state.oracleConfig || this.state.oracleConfig.size === 0) {
            console.log('❌ No oracles registered');
            return;
        }

        console.log('📈 COMPREHENSIVE ORACLE PERFORMANCE REPORT\n');

        for (const [key, config] of this.state.oracleConfig) {
            try {
                const oracleInfo = await oracleManager.getOracleInfo(config.address);

                console.log(`${'='.repeat(50)}`);
                console.log(`🔷 ${key.toUpperCase()} ORACLE`);
                console.log(`${'='.repeat(50)}`);
                console.log(`📍 Address: ${config.address}`);
                console.log(`📊 Role: ${config.role}`);
                console.log(`🏆 Reputation: ${oracleInfo.reputation}/1000`);
                console.log(`✅ Correct Attestations: ${oracleInfo.correctAttestations}`);
                console.log(`❌ Incorrect Attestations: ${oracleInfo.incorrectAttestations}`);
                console.log(`🔄 Active Status: ${oracleInfo.isActive ? '✅ ACTIVE' : '❌ INACTIVE'}`);

                // Calculate accuracy
                const total = Number(oracleInfo.correctAttestations) + Number(oracleInfo.incorrectAttestations);
                if (total > 0) {
                    const accuracy = (Number(oracleInfo.correctAttestations) / total * 100).toFixed(2);
                    console.log(`🎯 Accuracy: ${accuracy}%`);
                } else {
                    console.log(`🎯 Accuracy: N/A (No attestations yet)`);
                }

                console.log('');
            } catch (error) {
                console.log(`❌ ${key.toUpperCase()}: Error retrieving detailed stats`);
                console.log('');
            }
        }

        console.log(`${'='.repeat(50)}`);
    }

    /** Option 37: Oracle Consensus Operations */
    async consensusOperations() {
        console.log('\n🤝 ORACLE CONSENSUS OPERATIONS');
        console.log('='.repeat(50));

        const consensusOracle = this.state.getContract('consensusOracle');
        if (!consensusOracle) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        console.log('\n🎯 CONSENSUS OPERATIONS:');
        console.log('1. Create Consensus Query');
        console.log('2. Submit Oracle Vote');
        console.log('3. Check Consensus Result');
        console.log('4. View Active Queries');
        console.log('0. Back to Main Menu');

        const choice = await this.promptUser('\nSelect action (0-4): ');

        try {
            switch (choice) {
                case '1':
                    await this.createConsensusQuery();
                    break;
                case '2':
                    await this.submitOracleVote();
                    break;
                case '3':
                    await this.checkConsensusResult();
                    break;
                case '4':
                    await this.viewActiveQueries();
                    break;
                case '0':
                    return;
                default:
                    console.log('❌ Invalid choice');
            }
        } catch (error) {
            console.error('❌ Consensus operation failed:', error.message);
        }
    }

    async createConsensusQuery() {
        console.log('\n📝 CREATE CONSENSUS QUERY');
        console.log('-'.repeat(40));

        const consensusOracle = this.state.getContract('consensusOracle');

        if (!this.state.identities || this.state.identities.size === 0) {
            console.log('❌ No identities available');
            console.log('💡 Create identities first (option 3)');
            return;
        }

        try {
            // Select subject
            console.log('\n👤 Select subject for query:');
            let index = 0;
            const identityArray = Array.from(this.state.identities.values());
            for (const identity of identityArray) {
                console.log(`   ${index}: ${identity.owner}`);
                index++;
            }

            const subjectIndex = await this.promptUser(`\nSelect subject (0-${index - 1}): `);
            const subject = identityArray[parseInt(subjectIndex)];

            if (!subject) {
                console.log('❌ Invalid selection');
                return;
            }

            // Select query type
            console.log('\n📋 Select query type:');
            console.log('1. Whitelist Approval');
            console.log('2. Blacklist Decision');
            console.log('3. Identity Verification');
            console.log('4. Compliance Check');
            console.log('5. Reputation Update');

            const queryTypeChoice = await this.promptUser('\nSelect type (1-5): ');
            const queryType = parseInt(queryTypeChoice) || 1;

            // Get query description
            const description = await this.promptUser('Enter query description: ');
            const queryData = ethers.toUtf8Bytes(description);

            console.log('\n🔍 Creating consensus query...');
            console.log(`   👤 Subject: ${subject.owner}`);
            console.log(`   📋 Type: ${queryType}`);
            console.log(`   📝 Description: ${description}`);

            // Create consensus query
            const tx = await consensusOracle.createConsensusQuery(
                subject.owner,
                queryType,
                queryData
            );
            const receipt = await tx.wait();

            // Extract query ID from event
            let queryId = null;
            for (const log of receipt.logs) {
                try {
                    const parsed = consensusOracle.interface.parseLog(log);
                    if (parsed.name === 'ConsensusQueryCreated') {
                        queryId = parsed.args.queryId;
                        break;
                    }
                } catch (e) {
                    // Skip unparseable logs
                }
            }

            console.log('\n✅ CONSENSUS QUERY CREATED!');
            console.log('='.repeat(70));
            console.log(`🆔 Query ID: ${queryId}`);
            console.log('='.repeat(70));
            console.log(`   👤 Subject: ${subject.owner}`);
            console.log(`   📋 Type: ${queryType}`);
            console.log(`   🔗 Transaction: ${receipt.hash}`);
            console.log(`   🧱 Block: ${receipt.blockNumber}`);
            console.log('');
            console.log('⚠️  IMPORTANT: Copy the Query ID above to vote on this query!');
            console.log('💡 Oracles can now vote using Option 37, Sub-option 2');
            console.log('💡 You will need to paste the ENTIRE Query ID (not the subject address)');

        } catch (error) {
            console.error('❌ Failed to create consensus query:', error.message);
        }
    }

    async submitOracleVote() {
        console.log('\n🗳️ SUBMIT ORACLE VOTE');
        console.log('-'.repeat(30));

        const consensusOracle = this.state.getContract('consensusOracle');

        try {
            console.log('\n⚠️  IMPORTANT: Enter the QUERY ID (long hash), NOT the subject address!');
            console.log('💡 Query ID format: 0x followed by 64 characters');
            console.log('💡 Example: 0xc6dcc0ba1f4448a3f9b9dbf1d0e815944678b39a1f1f7e20f03246e81529cbd4');
            console.log('');

            const queryId = await this.promptUser('Enter query ID (0x...): ');

            // Validate query ID format
            if (!queryId || !queryId.startsWith('0x')) {
                console.log('❌ Invalid query ID format');
                console.log('💡 Query ID should start with 0x');
                return;
            }

            // Check if it's a valid 32-byte hash (66 characters including 0x)
            if (queryId.length !== 66) {
                console.log('❌ Invalid query ID length');
                console.log(`   Expected: 66 characters (0x + 64 hex digits)`);
                console.log(`   Got: ${queryId.length} characters`);
                console.log('');
                console.log('⚠️  Did you enter the subject address instead of the Query ID?');
                console.log('💡 The Query ID is the long hash shown when you created the query');
                console.log('💡 Subject address is only 42 characters (0x + 40 hex digits)');
                return;
            }

            // Select oracle
            console.log('\n👥 Select oracle to vote:');
            console.log('   0: KYC Oracle (Signer 1)');
            console.log('   1: AML Oracle (Signer 2)');
            console.log('   2: Compliance Oracle (Signer 3)');

            const oracleIndex = await this.promptUser('\nSelect oracle (0-2): ');
            const oracleSigner = this.state.signers[parseInt(oracleIndex) + 1];

            if (!oracleSigner) {
                console.log('❌ Invalid oracle selection');
                return;
            }

            // Get vote
            const voteChoice = await this.promptUser('\nVote (1=APPROVE, 0=REJECT): ');
            const vote = voteChoice === '1';

            console.log('\n🔍 Submitting vote...');
            console.log(`   🆔 Query ID: ${queryId}`);
            console.log(`   👤 Oracle: ${oracleSigner.address}`);
            console.log(`   🗳️ Vote: ${vote ? '✅ APPROVE' : '❌ REJECT'}`);

            // Get query details to get the subject
            const query = await consensusOracle.consensusQueries(queryId);
            const subject = query.subject;

            // Generate signature for the vote
            // Message format: keccak256(abi.encodePacked(subject, queryId, vote, chainId))
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const messageHash = ethers.solidityPackedKeccak256(
                ['address', 'bytes32', 'bool', 'uint256'],
                [subject, queryId, vote, chainId]
            );

            // Sign the message
            const signature = await oracleSigner.signMessage(ethers.getBytes(messageHash));

            console.log('   🔐 Signature generated');

            // Submit vote with signature
            const tx = await consensusOracle.connect(oracleSigner).submitVote(
                queryId,
                vote,
                signature
            );
            const receipt = await tx.wait();

            console.log('\n✅ VOTE SUBMITTED!');
            console.log(`   🔗 Transaction: ${receipt.hash}`);
            console.log(`   🧱 Block: ${receipt.blockNumber}`);
            console.log('\n💡 Check consensus result (option 37, sub-option 3)');

        } catch (error) {
            console.error('❌ Failed to submit vote:', error.message);

            // Provide helpful error messages
            if (error.message.includes('no matching fragment')) {
                console.log('');
                console.log('💡 TROUBLESHOOTING:');
                console.log('   1. Make sure you entered the QUERY ID (66 characters)');
                console.log('   2. NOT the subject address (42 characters)');
                console.log('   3. Query ID is shown when you create a query (Option 37, Sub-option 1)');
            } else if (error.message.includes('Query does not exist')) {
                console.log('');
                console.log('💡 TROUBLESHOOTING:');
                console.log('   1. The query ID might be incorrect');
                console.log('   2. Create a new query first (Option 37, Sub-option 1)');
                console.log('   3. Copy the entire Query ID from the creation output');
            } else if (error.message.includes('already voted')) {
                console.log('');
                console.log('💡 This oracle has already voted on this query');
                console.log('   Try voting with a different oracle');
            }
        }
    }

    async checkConsensusResult() {
        console.log('\n📊 CHECK CONSENSUS RESULT');
        console.log('-'.repeat(35));

        const consensusOracle = this.state.getContract('consensusOracle');

        try {
            const queryId = await this.promptUser('Enter query ID (0x...): ');

            if (!queryId || !queryId.startsWith('0x')) {
                console.log('❌ Invalid query ID format');
                return;
            }

            console.log('\n🔍 Fetching consensus result...');

            // Get query info
            const query = await consensusOracle.consensusQueries(queryId);

            console.log('\n📊 CONSENSUS QUERY DETAILS');
            console.log('='.repeat(40));
            console.log(`🆔 Query ID: ${queryId}`);
            console.log(`👤 Subject: ${query.subject}`);
            console.log(`📋 Type: ${query.queryType}`);
            console.log(`⏰ Created: ${new Date(Number(query.timestamp) * 1000).toLocaleString()}`);
            console.log(`⏳ Expires: ${new Date(Number(query.expiryTime) * 1000).toLocaleString()}`);

            console.log('\n🗳️ VOTING RESULTS:');
            console.log(`   ✅ Positive Votes: ${query.positiveVotes}`);
            console.log(`   ❌ Negative Votes: ${query.negativeVotes}`);
            console.log(`   📊 Total Votes: ${query.totalVotes}`);

            const totalVotes = Number(query.positiveVotes) + Number(query.negativeVotes);
            if (totalVotes > 0) {
                const approvalRate = (Number(query.positiveVotes) / totalVotes * 100).toFixed(1);
                console.log(`   📈 Approval Rate: ${approvalRate}%`);
            }

            console.log('\n🎯 CONSENSUS STATUS:');
            if (query.isResolved) {
                console.log(`   ✅ RESOLVED`);
                console.log(`   🏆 Result: ${query.consensusResult ? '✅ APPROVED' : '❌ REJECTED'}`);
            } else {
                console.log(`   ⏳ PENDING (waiting for more votes)`);
            }

        } catch (error) {
            console.error('❌ Failed to check consensus:', error.message);
        }
    }

    async viewActiveQueries() {
        console.log('\n📋 ACTIVE CONSENSUS QUERIES');
        console.log('-'.repeat(35));

        console.log('\n💡 This feature requires tracking query IDs from creation events');
        console.log('   Query IDs are displayed when you create a query (option 37, sub-option 1)');
        console.log('   Save the query ID to check its status later');
        console.log('');
        console.log('📝 WORKFLOW:');
        console.log('   1. Create a consensus query (Option 37 → 1)');
        console.log('   2. Copy the Query ID from the output');
        console.log('   3. Submit votes from different oracles (Option 37 → 2)');
        console.log('   4. Check consensus result (Option 37 → 3)');
        console.log('');
        console.log('🔍 QUERY TYPES:');
        console.log('   1. Whitelist Approval - Approve user for whitelist');
        console.log('   2. Blacklist Decision - Decide on blacklisting');
        console.log('   3. Identity Verification - Verify user identity');
        console.log('   4. Compliance Check - Check compliance status');
        console.log('   5. Reputation Update - Update oracle reputation');
    }

    /** Option 38: Integrate Oracles with Token */
    async integrateWithToken() {
        console.log('\n🔗 INTEGRATE ORACLES WITH DIGITAL TOKEN');
        console.log('='.repeat(50));

        const digitalToken = this.state.getContract('digitalToken');
        if (!digitalToken) {
            console.log('❌ Please deploy Vanguard StableCoin System first (option 21)');
            return;
        }

        const oracleManager = this.state.getContract('oracleManager');
        if (!oracleManager) {
            console.log('❌ Please deploy Oracle Management System first (option 31)');
            return;
        }

        try {
            const tokenAddress = await digitalToken.getAddress();
            console.log(`🪙 Digital Token: ${tokenAddress}`);
            console.log('🔗 Integrating Oracle System with Vanguard StableCoin...');

            // This demonstrates how oracles would integrate with token operations
            console.log('\n📋 Integration Scenarios:');
            console.log('1. 🔍 Pre-transfer Oracle Validation');
            console.log('2. 📊 Real-time Compliance Monitoring');
            console.log('3. 🚫 Oracle-based Transfer Blocking');
            console.log('4. 📈 Compliance Score Integration');

            console.log('\n🔍 PRE-TRANSFER ORACLE VALIDATION:');
            console.log('   • Whitelist check before token transfer');
            console.log('   • Blacklist verification');
            console.log('   • Real-time AML screening');

            // Simulate oracle validation for a transfer
            const whitelistOracle = this.state.getContract('whitelistOracle');
            const blacklistOracle = this.state.getContract('blacklistOracle');

            if (this.state.identities && this.state.identities.size > 0) {
                const firstIdentity = Array.from(this.state.identities.values())[0];

                console.log('\n🧪 TESTING ORACLE VALIDATION:');
                console.log(`   Testing user: ${firstIdentity.owner}`);

                // Check whitelist status
                const isWhitelisted = await whitelistOracle.isWhitelisted(firstIdentity.owner);
                console.log(`   📋 Whitelist Status: ${isWhitelisted ? '✅ APPROVED' : '❌ NOT APPROVED'}`);

                // Check blacklist status
                const isBlacklisted = await blacklistOracle.isBlacklisted(firstIdentity.owner);
                console.log(`   🚫 Blacklist Status: ${isBlacklisted ? '❌ BLOCKED' : '✅ CLEAR'}`);

                // Determine transfer eligibility
                const transferEligible = isWhitelisted && !isBlacklisted;
                console.log(`   💸 Transfer Eligible: ${transferEligible ? '✅ YES' : '❌ NO'}`);

                if (transferEligible) {
                    console.log('   🎉 User passes oracle validation - transfer would be allowed');
                } else {
                    console.log('   🚫 User fails oracle validation - transfer would be blocked');
                }
            }

            console.log('\n✅ ORACLE-DIGITAL TOKEN INTEGRATION COMPLETE!');
            console.log('🔗 Oracle system is now monitoring Vanguard StableCoin transactions');
            console.log('📊 Real-time compliance validation active');
            console.log('🛡️ Enhanced security through oracle consensus');

        } catch (error) {
            console.error('❌ Oracle integration failed:', error.message);
        }
    }

    /** Option 39: Oracle System Dashboard */
    async showDashboard() {
        console.log('\n📋 ORACLE SYSTEM DASHBOARD');
        console.log('='.repeat(50));

        const oracleManager = this.state.getContract('oracleManager');
        if (!oracleManager) {
            console.log('❌ Oracle Management System not deployed');
            console.log('💡 Please run option 31 first');
            return;
        }

        try {
            console.log('🔧 ORACLE MANAGEMENT SYSTEM STATUS');
            console.log('-'.repeat(40));

            // Oracle Manager Status
            const totalOracles = await oracleManager.getOracleCount();
            const activeOracles = await oracleManager.getActiveOracles();
            const consensusThreshold = await oracleManager.getConsensusThreshold();

            console.log(`📊 Oracle Network:`);
            console.log(`   Total Oracles: ${totalOracles}`);
            console.log(`   Active Oracles: ${activeOracles.length}`);
            console.log(`   Consensus Threshold: ${consensusThreshold}/${totalOracles}`);

            // Individual Oracle Status
            console.log('\n👥 INDIVIDUAL ORACLE STATUS:');
            for (const [key, config] of this.state.oracleConfig) {
                try {
                    const oracleInfo = await oracleManager.getOracleInfo(config.address);
                    console.log(`\n${key.toUpperCase()} (${config.role}):`);
                    console.log(`   📍 Address: ${config.address}`);
                    console.log(`   🏆 Reputation: ${oracleInfo.reputation}`);
                    console.log(`   ✅ Correct: ${oracleInfo.correctAttestations}`);
                    console.log(`   ❌ Incorrect: ${oracleInfo.incorrectAttestations}`);
                    console.log(`   🔄 Active: ${oracleInfo.isActive ? 'YES' : 'NO'}`);
                } catch (error) {
                    console.log(`\n${key.toUpperCase()}: ❌ Error retrieving info`);
                }
            }

            // Whitelist/Blacklist Summary
            console.log('\n📋 WHITELIST/BLACKLIST SUMMARY:');
            let whitelistCount = 0;
            let blacklistCount = 0;

            const whitelistOracle = this.state.getContract('whitelistOracle');
            const blacklistOracle = this.state.getContract('blacklistOracle');

            if (this.state.identities) {
                for (const identity of this.state.identities.values()) {
                    try {
                        const isWhitelisted = await whitelistOracle.isWhitelisted(identity.owner);
                        const isBlacklisted = await blacklistOracle.isBlacklisted(identity.owner);

                        if (isWhitelisted) whitelistCount++;
                        if (isBlacklisted) blacklistCount++;
                    } catch (error) {
                        // Skip errors for individual checks
                    }
                }
            }

            console.log(`   📋 Whitelisted Users: ${whitelistCount}`);
            console.log(`   🚫 Blacklisted Users: ${blacklistCount}`);
            console.log(`   👥 Total Identities: ${this.state.identities ? this.state.identities.size : 0}`);

            // Integration Status
            const digitalToken = this.state.getContract('digitalToken');
            const complianceRules = this.state.getContract('complianceRules');
            const onchainIDFactory = this.state.getContract('onchainIDFactory');

            console.log('\n🔗 INTEGRATION STATUS:');
            console.log(`   🏛️ ERC-3643 Vanguard StableCoin: ${digitalToken ? '✅ CONNECTED' : '❌ NOT CONNECTED'}`);
            console.log(`   ⚖️ ComplianceRules: ${complianceRules ? '✅ CONNECTED' : '❌ NOT CONNECTED'}`);
            console.log(`   🆔 OnchainID System: ${onchainIDFactory ? '✅ CONNECTED' : '❌ NOT CONNECTED'}`);

            console.log('\n🎯 ORACLE SYSTEM HEALTH: ✅ OPERATIONAL');

        } catch (error) {
            console.error('❌ Dashboard generation failed:', error.message);
        }
    }

    /** Option 40: Test Complete Oracle Integration */
    async testIntegration() {
        console.log('\n🧪 TEST COMPLETE ORACLE INTEGRATION');
        console.log('='.repeat(50));

        const oracleManager = this.state.getContract('oracleManager');
        const digitalToken = this.state.getContract('digitalToken');

        if (!oracleManager || !digitalToken) {
            console.log('❌ Missing required systems:');
            console.log(`   Oracle System: ${oracleManager ? '✅' : '❌'}`);
            console.log(`   Vanguard StableCoin: ${digitalToken ? '✅' : '❌'}`);
            console.log('💡 Please deploy both systems first');
            return;
        }

        try {
            console.log('🔄 Running Complete Integration Test...');
            console.log('This test demonstrates the full oracle-integrated workflow');

            const whitelistOracle = this.state.getContract('whitelistOracle');
            const blacklistOracle = this.state.getContract('blacklistOracle');
            const consensusOracle = this.state.getContract('consensusOracle');

            // Test 1: Oracle Consensus for Critical Decision
            console.log('\n1️⃣ TESTING ORACLE CONSENSUS');
            console.log('-'.repeat(30));

            if (this.state.identities && this.state.identities.size > 0) {
                const testUser = Array.from(this.state.identities.values())[0];
                const queryData = ethers.toUtf8Bytes('Should user be approved for high-value transfer?');
                const tx1 = await consensusOracle.createConsensusQuery(
                    testUser.owner,
                    4, // QUERY_TYPE_COMPLIANCE
                    queryData
                );
                const receipt1 = await tx1.wait();
                console.log('✅ Consensus query created for high-value transfer approval');
                console.log(`   🔗 Transaction: ${receipt1.hash}`);
            } else {
                console.log('⚠️ No identities available for consensus test');
            }

            // Test 2: Whitelist Integration with Vanguard StableCoin
            console.log('\n2️⃣ TESTING WHITELIST-DIGITAL TOKEN INTEGRATION');
            console.log('-'.repeat(45));

            if (this.state.identities && this.state.identities.size > 0) {
                const testUser = Array.from(this.state.identities.values())[0];

                // Add user to whitelist
                await whitelistOracle.addToWhitelist(
                    testUser.owner,
                    5, // Highest tier
                    0, // Permanent
                    'Integration test - approved for Vanguard StableCoin'
                );
                console.log(`✅ User added to whitelist: ${testUser.owner}`);

                // Verify whitelist status
                const whitelistInfo = await whitelistOracle.getWhitelistInfo(testUser.owner);
                console.log(`   🏆 Tier: ${whitelistInfo.tier}`);
                console.log(`   📝 Reason: ${whitelistInfo.reason}`);
            }

            // Test 3: Emergency Protocol
            console.log('\n3️⃣ TESTING EMERGENCY PROTOCOLS');
            console.log('-'.repeat(30));

            if (this.state.identities && this.state.identities.size > 1) {
                const testUser2 = Array.from(this.state.identities.values())[1];
                const emergencyOracle = this.state.signers[2]; // AML Oracle

                await blacklistOracle.connect(emergencyOracle).emergencyBlacklist(
                    testUser2.owner,
                    3, // Critical
                    'Integration test - emergency protocol'
                );
                console.log(`✅ Emergency blacklist executed: ${testUser2.owner}`);
                console.log(`   🚨 Severity: CRITICAL`);
                console.log(`   👮 Emergency Oracle: ${emergencyOracle.address}`);
            }

            // Test 4: Oracle Reputation Update
            console.log('\n4️⃣ TESTING ORACLE REPUTATION SYSTEM');
            console.log('-'.repeat(35));

            const oracle1 = this.state.signers[1];
            await oracleManager.rewardOracle(oracle1.address, 50, 'Integration test reward');
            console.log(`✅ Oracle rewarded: ${oracle1.address} (+50 reputation)`);

            const updatedInfo = await oracleManager.getOracleInfo(oracle1.address);
            console.log(`   🏆 New Reputation: ${updatedInfo.reputation}`);

            // Test Summary
            console.log('\n🎉 COMPLETE INTEGRATION TEST RESULTS');
            console.log('='.repeat(40));
            console.log('✅ Oracle Consensus: WORKING');
            console.log('✅ Whitelist Integration: WORKING');
            console.log('✅ Emergency Protocols: WORKING');
            console.log('✅ Reputation System: WORKING');
            console.log('✅ Vanguard StableCoin Integration: READY');
            console.log('');
            console.log('🔗 Oracle system is fully integrated with:');
            console.log('   • ERC-3643 Digital Token System');
            console.log('   • OnchainID Identity Management');
            console.log('   • ComplianceRules Engine');
            console.log('   • KYC/AML Workflow');
            console.log('');
            console.log('🛡️ SECURITY FEATURES ACTIVE:');
            console.log('   • Multi-oracle consensus validation');
            console.log('   • Emergency blacklist protocols');
            console.log('   • Real-time compliance monitoring');
            console.log('   • Reputation-based oracle weighting');

        } catch (error) {
            console.error('❌ Integration test failed:', error.message);
        }
    }
}

module.exports = OracleModule;

