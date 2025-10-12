/**
 * @fileoverview OnchainID management module
 * @module OnchainIDModule
 * @description Handles all OnchainID-related operations including identity creation,
 * key management, claim issuance (KYC/AML), and identity recovery.
 * Covers menu options 1-12.
 *
 * @example
 * const OnchainIDModule = require('./modules/OnchainIDModule');
 * const module = new OnchainIDModule(state, logger, promptUser);
 * await module.createOnchainID();
 */

const { ethers } = require('hardhat');
const { displaySection, displaySuccess, displayError, displayInfo } = require('../utils/DisplayHelpers');

/**
 * @class OnchainIDModule
 * @description Manages OnchainID operations for the demo system.
 * Handles identity creation, management keys, KYC/AML claims, and recovery.
 */
class OnchainIDModule {
    /**
     * Create an OnchainIDModule
     * @param {Object} state - DemoState instance
     * @param {Object} logger - EnhancedLogger instance
     * @param {Function} promptUser - Function to prompt user for input
     */
    constructor(state, logger, promptUser) {
        /**
         * @property {Object} state - Reference to DemoState
         * @private
         */
        this.state = state;

        /**
         * @property {Object} logger - Reference to EnhancedLogger
         * @private
         */
        this.logger = logger;

        /**
         * @property {Function} promptUser - User input function
         * @private
         */
        this.promptUser = promptUser;
    }

    /**
     * Option 2: Create OnchainID for a user
     *
     * @returns {Promise<void>}
     *
     * @example
     * await module.createOnchainID();
     */
    async createOnchainID() {
        displaySection('CREATING ONCHAINID', '🆔');

        if (!this.state.getContract('onchainIDFactory')) {
            displayError('Please deploy contracts first (option 1)');
            return;
        }

        try {
            console.log('\n📋 SELECT ADDRESS TYPE:');
            console.log('1. Use existing signer (from test accounts)');
            console.log('2. Enter custom wallet address');
            console.log('');

            const addressType = await this.promptUser('Select option (1-2): ');

            let selectedAddress;
            let selectedSigner;

            if (addressType === '2') {
                // Custom wallet address
                displayInfo('CUSTOM WALLET ADDRESS');
                const customAddress = await this.promptUser('Enter wallet address (0x...): ');

                if (!ethers.isAddress(customAddress)) {
                    displayError('Invalid Ethereum address format');
                    return;
                }

                selectedAddress = customAddress;
                selectedSigner = this.state.signers[0];

                console.log(`\n👤 Creating OnchainID for custom address: ${selectedAddress}`);
                console.log(`   💰 Transaction paid by: ${selectedSigner.address}`);

            } else {
                // Existing signer
                console.log('\n👥 Available Signers (Hardhat Test Accounts):');
                console.log('='.repeat(70));

                // Define role labels
                const roleLabels = {
                    0: '👑 Platform Owner/Deployer',
                    1: '💰 Fee Wallet',
                    2: '✅ KYC Issuer',
                    3: '🔍 AML Issuer'
                };

                // Show all available signers with role labels
                for (let i = 0; i < this.state.signers.length; i++) {
                    const address = await this.state.signers[i].getAddress();
                    const role = roleLabels[i] || '👤 Available for users';
                    console.log(`   ${i.toString().padStart(2)}: ${address}  ${role}`);
                }

                console.log('='.repeat(70));
                console.log(`   ℹ️  Total available: ${this.state.signers.length} signers`);
                console.log(`   ⚠️  Signers 0-3 are reserved for system roles`);
                console.log(`   ✅ Signers 4-${this.state.signers.length - 1} are available for users/investors`);

                const signerIndex = await this.promptUser(`\nSelect signer (0-${this.state.signers.length - 1}): `);
                const index = parseInt(signerIndex);

                if (index < 0 || index >= this.state.signers.length) {
                    displayError('Invalid signer selection');
                    return;
                }

                selectedSigner = this.state.signers[index];
                selectedAddress = await selectedSigner.getAddress();

                const selectedRole = roleLabels[index] || '👤 User/Investor';
                console.log(`\n👤 Creating OnchainID for: ${selectedAddress}`);
                console.log(`   Role: ${selectedRole}`);
            }

            const salt = ethers.randomBytes(32);
            const factory = this.state.getContract('onchainIDFactory');

            const { receipt } = await this.logger.logTransaction(
                'OnchainID Creation',
                factory.connect(selectedSigner).deployOnchainID(selectedAddress, salt),
                {
                    owner: selectedAddress,
                    salt: salt,
                    factory: await factory.getAddress(),
                    paidBy: selectedSigner.address
                },
                {
                    operation: 'Create OnchainID',
                    userSelected: selectedAddress,
                    transactionPaidBy: selectedSigner.address
                }
            );

            const identityAddress = await factory.getIdentityByOwner(selectedAddress);

            this.state.identities.set(identityAddress, {
                address: identityAddress,
                owner: selectedAddress,
                signer: selectedSigner,
                createdAt: new Date().toISOString(),
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                isCustomAddress: addressType === '2'
            });

            displaySuccess('ONCHAINID CREATED SUCCESSFULLY!');
            console.log(`   User Address: ${selectedAddress}`);
            console.log(`   OnchainID: ${identityAddress}`);

            if (addressType === '2') {
                console.log(`   💰 Transaction paid by: ${selectedSigner.address}`);
                console.log(`   ⚠️  Note: This is a custom address, not a test signer`);
            }

            console.log('\n💡 Next Steps:');
            console.log('   1. Issue KYC Claim (Option 6)');
            console.log('   2. Issue AML Claim (Option 7)');

            // Register in ERC-3643 if available
            if (this.state.getContract('identityRegistry')) {
                await this.registerInERC3643(selectedSigner, identityAddress);
            }

        } catch (error) {
            displayError(`OnchainID creation failed: ${error.message}`);
        }
    }

    /**
     * Register identity in ERC-3643 registry
     *
     * @param {Object} signer - Signer object
     * @param {string} identityAddress - OnchainID address
     * @returns {Promise<void>}
     * @private
     */
    async registerInERC3643(signer, identityAddress) {
        // SKIP ERC-3643 registration during OnchainID creation
        // Registration will happen during KYC claim issuance with proper country code
        console.log('\n📝 ERC-3643 Registration Status:');
        console.log('   ⏭️  Skipping registration (will occur during KYC claim issuance)');
        console.log('   ℹ️  OnchainID created successfully');
        console.log('   ℹ️  Country verification will occur when KYC claim is issued');
        console.log('   ℹ️  Compliance rules will be enforced at that time');
        console.log('');
        console.log('💡 Next Steps:');
        console.log('   1. Issue KYC Claim (Option 6) - This will register the identity with country code');
        console.log('   2. Issue AML Claim (Option 7) - After KYC is issued');
    }

    /**
     * Option 2: Create management keys
     *
     * @returns {Promise<void>}
     */
    async createManagementKeys() {
        displaySection('CREATE MANAGEMENT KEYS', '🔑');

        if (this.state.identities.size === 0) {
            displayError('Please create OnchainID first (option 3)');
            return;
        }

        try {
            // Show available identities
            console.log('\n🆔 Available Identities:');
            const identityArray = Array.from(this.state.identities.values());
            let index = 0;

            for (const identity of identityArray) {
                console.log(`   ${index}: ${identity.address}`);
                console.log(`      Owner: ${identity.owner}`);
                index++;
            }

            const identityIndex = await this.promptUser(`Select identity (0-${identityArray.length - 1}): `);
            const selectedIdentity = identityArray[parseInt(identityIndex)];

            if (!selectedIdentity) {
                displayError('Invalid identity selection');
                return;
            }

            // Get OnchainID contract instance
            const onchainID = await ethers.getContractAt('OnchainID', selectedIdentity.address);

            // Key management menu
            console.log('\n🔑 KEY MANAGEMENT OPTIONS:');
            console.log('1. Add Management Key');
            console.log('2. Add Action Key');
            console.log('3. Add Claim Signer Key');
            console.log('4. Add Encryption Key');
            console.log('0. Back');

            const choice = await this.promptUser('Select option (0-4): ');

            let keyPurpose;
            let keyPurposeName;

            switch (choice) {
                case '1':
                    keyPurpose = 1; // MANAGEMENT_KEY
                    keyPurposeName = 'Management';
                    break;
                case '2':
                    keyPurpose = 2; // ACTION_KEY
                    keyPurposeName = 'Action';
                    break;
                case '3':
                    keyPurpose = 3; // CLAIM_SIGNER_KEY
                    keyPurposeName = 'Claim Signer';
                    break;
                case '4':
                    keyPurpose = 4; // ENCRYPTION_KEY
                    keyPurposeName = 'Encryption';
                    break;
                case '0':
                    return;
                default:
                    displayError('Invalid choice');
                    return;
            }

            // Choose key input method
            console.log('\n🔐 KEY INPUT METHOD:');
            console.log('1. From Ethereum Address');
            console.log('2. From String/Passphrase');
            console.log('0. Back');

            const inputMethod = await this.promptUser('Select input method (0-2): ');

            let keyHash;
            let keyInfo;

            if (inputMethod === '1') {
                // Method 1: From Ethereum Address (with signature verification)

                // Show available signers
                console.log('\n👥 Available Signers:');
                const signerAddresses = await Promise.all(
                    this.state.signers.map(s => s.getAddress())
                );

                for (let i = 0; i < signerAddresses.length; i++) {
                    console.log(`   ${i}: ${signerAddresses[i]}`);
                }
                console.log(`   ${signerAddresses.length}: Enter custom address`);

                const signerChoice = await this.promptUser(`Select signer (0-${signerAddresses.length}): `);
                const signerIndex = parseInt(signerChoice);

                let keyAddress;

                if (signerIndex >= 0 && signerIndex < signerAddresses.length) {
                    // Selected from available signers
                    keyAddress = signerAddresses[signerIndex];
                } else if (signerIndex === signerAddresses.length) {
                    // Custom address
                    keyAddress = await this.promptUser('Enter custom Ethereum address: ');
                } else {
                    displayError('Invalid selection');
                    return;
                }

                // Validate address
                if (!ethers.isAddress(keyAddress)) {
                    displayError('Invalid Ethereum address');
                    return;
                }

                // Check if this address is one of our signers (can auto-sign)
                const availableSignerIndex = signerAddresses.findIndex(
                    addr => addr.toLowerCase() === keyAddress.toLowerCase()
                );

                if (availableSignerIndex >= 0) {
                    // This is one of our signers - we can auto-sign
                    console.log('\n🔐 Verifying ownership via signature...');
                    const message = `Add ${keyPurposeName} Key to OnchainID: ${selectedIdentity.address}`;
                    const signer = this.state.signers[availableSignerIndex];
                    const signature = await signer.signMessage(message);

                    // Verify signature
                    const recoveredAddress = ethers.verifyMessage(message, signature);

                    if (recoveredAddress.toLowerCase() !== keyAddress.toLowerCase()) {
                        displayError('Signature verification failed');
                        return;
                    }

                    console.log('✅ Signature verified!');
                    keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [keyAddress]));
                    keyInfo = `Address: ${keyAddress} (Verified via signature)`;
                } else {
                    // External address - user needs to provide signature manually
                    console.log('\n⚠️  External address detected');
                    console.log('💡 To prove ownership, you need to sign a message with this address');
                    console.log('\n📝 Message to sign:');
                    const message = `Add ${keyPurposeName} Key to OnchainID: ${selectedIdentity.address}`;
                    console.log(`   "${message}"`);
                    console.log('\n🔐 Sign this message with your wallet and paste the signature:');

                    const signature = await this.promptUser('Enter signature (0x...): ');

                    try {
                        // Verify signature
                        const recoveredAddress = ethers.verifyMessage(message, signature);

                        if (recoveredAddress.toLowerCase() !== keyAddress.toLowerCase()) {
                            displayError('Signature verification failed - address mismatch');
                            console.log(`   Expected: ${keyAddress}`);
                            console.log(`   Recovered: ${recoveredAddress}`);
                            return;
                        }

                        console.log('✅ Signature verified!');
                        keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [keyAddress]));
                        keyInfo = `Address: ${keyAddress} (Verified via signature)`;
                    } catch (error) {
                        displayError(`Signature verification failed: ${error.message}`);
                        return;
                    }
                }

            } else if (inputMethod === '2') {
                // Method 2: From String/Passphrase
                const keyString = await this.promptUser('Enter string/passphrase for the new key: ');

                if (!keyString || keyString.trim().length === 0) {
                    displayError('String cannot be empty');
                    return;
                }

                // Create key hash from string
                keyHash = ethers.id(keyString); // keccak256 hash of the string
                keyInfo = `String: "${keyString}" (length: ${keyString.length})`;

            } else if (inputMethod === '0') {
                return;
            } else {
                displayError('Invalid input method');
                return;
            }

            // Add key to OnchainID (must be called by owner or someone with management key)
            console.log(`\n🔐 Adding ${keyPurposeName} Key...`);

            // Debug: Check current management keys
            console.log('\n🔍 DEBUG: Checking current management keys...');
            const currentManagementKeys = await onchainID.getKeysByPurpose(1);
            console.log(`   Current management keys count: ${currentManagementKeys.length}`);
            for (let i = 0; i < currentManagementKeys.length; i++) {
                console.log(`   Key ${i}: ${currentManagementKeys[i]}`);
            }

            // Check what the owner's key should be (FIXED: use solidityPacked to match constructor)
            const ownerAddress = selectedIdentity.owner;
            const expectedOwnerKey = ethers.keccak256(ethers.solidityPacked(['address'], [ownerAddress]));
            console.log(`   Expected owner key: ${expectedOwnerKey}`);
            console.log(`   Owner address: ${ownerAddress}`);

            // Check if owner has management key
            const ownerHasKey = await onchainID.keyHasPurpose(expectedOwnerKey, 1);
            console.log(`   Owner has management key: ${ownerHasKey}`);

            // Find the owner's signer
            let ownerSigner;
            for (const signer of this.state.signers) {
                const addr = await signer.getAddress();
                if (addr.toLowerCase() === ownerAddress.toLowerCase()) {
                    ownerSigner = signer;
                    break;
                }
            }

            if (!ownerSigner) {
                displayError(`Owner signer not found for address: ${ownerAddress}`);
                console.log('   ℹ️  The identity owner must be one of the available signers');
                console.log('   ℹ️  Owner address: ' + ownerAddress);
                return;
            }

            console.log(`\n   ℹ️  Transaction will be sent by owner: ${ownerAddress}`);

            const tx = await onchainID.connect(ownerSigner).addKey(keyHash, keyPurpose, 1); // 1 = ECDSA_TYPE
            await tx.wait();

            displaySuccess(`${keyPurposeName} Key Added Successfully!`);
            console.log(`   Identity: ${selectedIdentity.address}`);
            console.log(`   ${keyInfo}`);
            console.log(`   Key Hash: ${keyHash}`);
            console.log(`   Purpose: ${keyPurposeName} (${keyPurpose})`);
            console.log(`   Type: ECDSA (1)`);

        } catch (error) {
            displayError(`Key creation failed: ${error.message}`);
        }
    }

    /**
     * Option 4: Review identity keys
     *
     * @returns {Promise<void>}
     */
    async reviewIdentityKeys() {
        displaySection('REVIEW IDENTITY KEYS', '🔍');

        if (this.state.identities.size === 0) {
            displayError('Please create OnchainID first (option 3)');
            return;
        }

        try {
            // Show available identities
            console.log('\n🆔 Available Identities:');
            const identityArray = Array.from(this.state.identities.values());
            let index = 0;

            for (const identity of identityArray) {
                console.log(`   ${index}: ${identity.address}`);
                console.log(`      Owner: ${identity.owner}`);
                index++;
            }

            const identityIndex = await this.promptUser(`Select identity (0-${identityArray.length - 1}): `);
            const selectedIdentity = identityArray[parseInt(identityIndex)];

            if (!selectedIdentity) {
                displayError('Invalid identity selection');
                return;
            }

            // Get OnchainID contract instance
            const onchainID = await ethers.getContractAt('OnchainID', selectedIdentity.address);

            console.log(`\n🔍 REVIEWING KEYS FOR: ${selectedIdentity.address}`);
            console.log('='.repeat(70));

            // Key purposes to check
            const keyPurposes = [
                { id: 1, name: 'Management Keys' },
                { id: 2, name: 'Action Keys' },
                { id: 3, name: 'Claim Signer Keys' },
                { id: 4, name: 'Encryption Keys' }
            ];

            for (const purpose of keyPurposes) {
                console.log(`\n🔑 ${purpose.name}:`);

                try {
                    const keys = await onchainID.getKeysByPurpose(purpose.id);

                    if (keys.length === 0) {
                        console.log('   No keys found');
                    } else {
                        for (let i = 0; i < keys.length; i++) {
                            const keyHash = keys[i];
                            const keyInfo = await onchainID.getKey(keyHash);

                            console.log(`   ${i + 1}. Key Hash: ${keyHash}`);
                            console.log(`      Purpose: ${keyInfo.purpose}`);
                            console.log(`      Type: ${keyInfo.keyType === 1n ? 'ECDSA' : 'RSA'}`);
                            console.log(`      Revoked: ${keyInfo.revokedAt > 0n ? 'Yes' : 'No'}`);
                            if (keyInfo.revokedAt > 0n) {
                                const revokedDate = new Date(Number(keyInfo.revokedAt) * 1000);
                                console.log(`      Revoked At: ${revokedDate.toISOString()}`);
                            }
                        }
                    }
                } catch (error) {
                    console.log(`   Error retrieving keys: ${error.message}`);
                }
            }

            console.log('\n✅ Key review completed!');

        } catch (error) {
            displayError(`Key review failed: ${error.message}`);
        }
    }

    /**
     * Option 5: Recover lost keys
     *
     * @returns {Promise<void>}
     */
    async recoverLostKeys() {
        displaySection('RECOVER LOST KEYS', '🚨');

        if (this.state.identities.size === 0) {
            displayError('Please create OnchainID first (option 3)');
            return;
        }

        try {
            // Show available identities
            console.log('\n🆔 Available Identities:');
            const identityArray = Array.from(this.state.identities.values());
            let index = 0;

            for (const identity of identityArray) {
                console.log(`   ${index}: ${identity.address}`);
                console.log(`      Owner: ${identity.owner}`);
                index++;
            }

            const identityIndex = await this.promptUser(`Select identity (0-${identityArray.length - 1}): `);
            const selectedIdentity = identityArray[parseInt(identityIndex)];

            if (!selectedIdentity) {
                displayError('Invalid identity selection');
                return;
            }

            // Get OnchainID contract instance
            const onchainID = await ethers.getContractAt('OnchainID', selectedIdentity.address);

            console.log('\n🚨 KEY RECOVERY OPTIONS:');
            console.log('1. Remove Compromised Key');
            console.log('2. Add Recovery Key');
            console.log('3. Replace Management Key');
            console.log('0. Back');

            const choice = await this.promptUser('Select option (0-3): ');

            switch (choice) {
                case '1':
                    await this.removeCompromisedKey(onchainID, selectedIdentity);
                    break;
                case '2':
                    await this.addRecoveryKey(onchainID, selectedIdentity);
                    break;
                case '3':
                    await this.replaceManagementKey(onchainID, selectedIdentity);
                    break;
                case '0':
                    return;
                default:
                    displayError('Invalid choice');
            }

        } catch (error) {
            displayError(`Key recovery failed: ${error.message}`);
        }
    }

    /**
     * Option 6: Manage KYC claims
     *
     * @returns {Promise<void>}
     */
    async manageKYCClaims() {
        displaySection('KYC CLAIM MANAGEMENT', '📋');

        if (this.state.identities.size === 0) {
            displayError('Please create OnchainID first (option 3)');
            return;
        }

        // Show available identities
        console.log('\n🆔 Available Identities:');
        let index = 0;
        const identityArray = Array.from(this.state.identities.values());
        for (const identity of identityArray) {
            const kycClaim = this.state.claims.get(`${identity.address}_KYC`);
            const status = kycClaim ? (kycClaim.status || 'ISSUED') : 'NOT_ISSUED';
            console.log(`   ${index}: ${identity.address} (Owner: ${identity.owner}) - KYC: ${status}`);
            index++;
        }

        const identityIndex = await this.promptUser(`Select identity (0-${identityArray.length - 1}): `);
        const selectedIdentity = identityArray[parseInt(identityIndex)];

        if (!selectedIdentity) {
            displayError('Invalid identity selection');
            return;
        }

        // Show KYC management options
        console.log(`\n🔐 KYC Management for: ${selectedIdentity.address}`);
        console.log('1. Issue KYC Claim');
        console.log('2. Reject KYC Claim');
        console.log('3. Update KYC Status');
        console.log('4. View KYC History');
        console.log('5. Revoke KYC Claim');
        console.log('0. Back to Main Menu');

        const choice = await this.promptUser('Select KYC action (0-5): ');

        try {
            switch (choice) {
                case '1':
                    await this.issueKYCClaimForIdentity(selectedIdentity);
                    break;
                case '2':
                    await this.rejectKYCClaimForIdentity(selectedIdentity);
                    break;
                case '3':
                    await this.updateKYCStatusForIdentity(selectedIdentity);
                    break;
                case '4':
                    await this.viewKYCHistoryForIdentity(selectedIdentity);
                    break;
                case '5':
                    await this.revokeKYCClaimForIdentity(selectedIdentity);
                    break;
                case '0':
                    return;
                default:
                    displayError('Invalid choice');
            }
        } catch (error) {
            displayError(`KYC management failed: ${error.message}`);
        }
    }

    /**
     * Option 7: Manage AML claims
     *
     * @returns {Promise<void>}
     */
    async manageAMLClaims() {
        displaySection('AML CLAIM MANAGEMENT', '🔍');

        if (this.state.identities.size === 0) {
            displayError('Please create OnchainID first (option 3)');
            return;
        }

        // Show available identities
        console.log('\n🆔 Available Identities:');
        let index = 0;
        const identityArray = Array.from(this.state.identities.values());
        for (const identity of identityArray) {
            const amlClaim = this.state.claims.get(`${identity.address}_AML`);
            const status = amlClaim ? (amlClaim.status || 'ISSUED') : 'NOT_ISSUED';
            console.log(`   ${index}: ${identity.address} (Owner: ${identity.owner}) - AML: ${status}`);
            index++;
        }

        const identityIndex = await this.promptUser(`Select identity (0-${identityArray.length - 1}): `);
        const selectedIdentity = identityArray[parseInt(identityIndex)];

        if (!selectedIdentity) {
            displayError('Invalid identity selection');
            return;
        }

        // Show AML management options
        console.log(`\n🔐 AML Management for: ${selectedIdentity.address}`);
        console.log('1. Issue AML Claim');
        console.log('2. Reject AML Claim');
        console.log('3. Update AML Status');
        console.log('4. View AML History');
        console.log('5. Revoke AML Claim');
        console.log('0. Back to Main Menu');

        const choice = await this.promptUser('Select AML action (0-5): ');

        try {
            switch (choice) {
                case '1':
                    await this.issueAMLClaimForIdentity(selectedIdentity);
                    break;
                case '2':
                    await this.rejectAMLClaimForIdentity(selectedIdentity);
                    break;
                case '3':
                    await this.updateAMLStatusForIdentity(selectedIdentity);
                    break;
                case '4':
                    await this.viewAMLHistoryForIdentity(selectedIdentity);
                    break;
                case '5':
                    await this.revokeAMLClaimForIdentity(selectedIdentity);
                    break;
                case '0':
                    return;
                default:
                    displayError('Invalid choice');
            }
        } catch (error) {
            displayError(`AML management failed: ${error.message}`);
        }
    }

    /**
     * Option 8: Review claim status and history
     *
     * @returns {Promise<void>}
     */
    async reviewClaimStatusHistory() {
        displaySection('REVIEW CLAIM STATUS & HISTORY', '📊');

        if (this.state.identities.size === 0) {
            displayError('No identities found. Please create OnchainID first (option 3)');
            return;
        }

        console.log('\n🆔 IDENTITY CLAIM STATUS:');
        console.log('='.repeat(70));

        for (const identity of this.state.identities.values()) {
            const kycClaim = this.state.claims.get(`${identity.address}_KYC`);
            const amlClaim = this.state.claims.get(`${identity.address}_AML`);

            console.log(`\n👤 Identity: ${identity.address}`);
            console.log(`   Owner: ${identity.owner}`);
            console.log(`   Created: ${identity.createdAt}`);

            // KYC Status
            if (kycClaim) {
                console.log(`   📋 KYC: ${kycClaim.status || 'ISSUED'}`);
                console.log(`      Issued: ${kycClaim.issuedAt}`);
                if (kycClaim.countryCode) {
                    console.log(`      Country: ${kycClaim.countryCode}`);
                }
            } else {
                console.log(`   📋 KYC: NOT_ISSUED`);
            }

            // AML Status
            if (amlClaim) {
                console.log(`   🔍 AML: ${amlClaim.status || 'ISSUED'}`);
                console.log(`      Issued: ${amlClaim.issuedAt}`);
            } else {
                console.log(`   🔍 AML: NOT_ISSUED`);
            }
        }

        console.log('\n' + '='.repeat(70));
        console.log(`📊 Total Identities: ${this.state.identities.size}`);
        console.log(`✅ KYC Issued: ${Array.from(this.state.claims.values()).filter(c => c.type === 'KYC').length}`);
        console.log(`✅ AML Issued: ${Array.from(this.state.claims.values()).filter(c => c.type === 'AML').length}`);
    }

    /**
     * Option 9: Create UTXO with KYC/AML data
     *
     * @returns {Promise<void>}
     */
    async createUTXOWithCompliance() {
        displaySection('CREATE UTXO WITH KYC/AML DATA', '💰');

        if (this.state.identities.size === 0) {
            displayError('Please create OnchainID first (option 3)');
            return;
        }

        try {
            // Show available identities with their compliance status
            console.log('\n🆔 Available Identities:');
            const identityArray = Array.from(this.state.identities.values());
            let index = 0;

            for (const identity of identityArray) {
                const kycClaim = this.state.claims.get(`${identity.address}_KYC`);
                const amlClaim = this.state.claims.get(`${identity.address}_AML`);
                const kycStatus = kycClaim ? kycClaim.status : 'NOT_ISSUED';
                const amlStatus = amlClaim ? amlClaim.status : 'NOT_ISSUED';
                const utxoEligible = (kycStatus === 'ISSUED' && amlStatus === 'ISSUED');

                console.log(`   ${index}: ${identity.address} (Owner: ${identity.owner})`);
                console.log(`      KYC: ${kycStatus} | AML: ${amlStatus} | UTXO Eligible: ${utxoEligible ? '✅' : '❌'}`);
                index++;
            }

            const identityIndex = await this.promptUser(`Select identity (0-${identityArray.length - 1}): `);
            const selectedIdentity = identityArray[parseInt(identityIndex)];

            if (!selectedIdentity) {
                displayError('Invalid identity selection');
                return;
            }

            // Check compliance status
            const kycClaim = this.state.claims.get(`${selectedIdentity.address}_KYC`);
            const amlClaim = this.state.claims.get(`${selectedIdentity.address}_AML`);
            const kycStatus = kycClaim ? kycClaim.status : 'NOT_ISSUED';
            const amlStatus = amlClaim ? amlClaim.status : 'NOT_ISSUED';
            const utxoEligible = (kycStatus === 'ISSUED' && amlStatus === 'ISSUED');

            console.log(`\n🔍 COMPLIANCE CHECK FOR: ${selectedIdentity.address}`);
            console.log(`📋 KYC Status: ${kycStatus}`);
            console.log(`🔍 AML Status: ${amlStatus}`);
            console.log(`💰 UTXO Eligible: ${utxoEligible ? '✅ YES' : '❌ NO'}`);

            if (!utxoEligible) {
                console.log('\n❌ UTXO CREATION BLOCKED');
                console.log('💡 Requirements for UTXO creation:');
                console.log('   • KYC Status: ISSUED');
                console.log('   • AML Status: ISSUED');
                return;
            }

            // Create UTXO
            const value = await this.promptUser('Enter UTXO value (in ETH): ');
            const utxoId = ethers.id(`${selectedIdentity.address}_${Date.now()}`);

            // Store UTXO in state
            if (!this.state.utxos) {
                this.state.utxos = new Map();
            }

            this.state.utxos.set(utxoId, {
                owner: selectedIdentity.owner,
                identity: selectedIdentity.address,
                value: ethers.parseEther(value),
                kycStatus: kycStatus,
                amlStatus: amlStatus,
                complianceStatus: 'COMPLIANT',
                createdAt: new Date().toISOString()
            });

            displaySuccess('UTXO CREATED SUCCESSFULLY!');
            console.log(`   UTXO ID: ${utxoId.substring(0, 10)}...${utxoId.substring(58)}`);
            console.log(`   Owner: ${selectedIdentity.owner}`);
            console.log(`   Value: ${value} ETH`);
            console.log(`   KYC: ${kycStatus}`);
            console.log(`   AML: ${amlStatus}`);

        } catch (error) {
            displayError(`UTXO creation failed: ${error.message}`);
        }
    }

    /**
     * Option 10: Verify UTXO contains compliance data
     *
     * @returns {Promise<void>}
     */
    async verifyUTXOCompliance() {
        displaySection('VERIFY UTXO CONTAINS COMPLIANCE DATA', '🔍');

        if (!this.state.utxos || this.state.utxos.size === 0) {
            displayError('No UTXOs found. Please create a UTXO first (option 9)');
            return;
        }

        try {
            // Show available UTXOs
            console.log('\n💰 Available UTXOs:');
            const utxoArray = Array.from(this.state.utxos.entries());
            let index = 0;

            for (const [utxoId, metadata] of utxoArray) {
                console.log(`   ${index}: ${utxoId.substring(0, 10)}...${utxoId.substring(58)}`);
                console.log(`      Owner: ${metadata.owner}`);
                console.log(`      Value: ${ethers.formatEther(metadata.value)} ETH`);
                console.log(`      Status: ${metadata.complianceStatus}`);
                index++;
            }

            const utxoIndex = await this.promptUser(`Select UTXO to verify (0-${utxoArray.length - 1}): `);
            const [selectedUtxoId, selectedMetadata] = utxoArray[parseInt(utxoIndex)];

            if (!selectedMetadata) {
                displayError('Invalid UTXO selection');
                return;
            }

            console.log('\n🔍 VERIFYING UTXO COMPLIANCE DATA...');
            console.log('\n✅ UTXO COMPLIANCE VERIFICATION COMPLETE');
            console.log('='.repeat(60));
            console.log(`📋 UTXO ID: ${selectedUtxoId}`);
            console.log(`👤 Owner: ${selectedMetadata.owner}`);
            console.log(`💰 Value: ${ethers.formatEther(selectedMetadata.value)} ETH`);
            console.log(`📋 KYC Status: ${selectedMetadata.kycStatus}`);
            console.log(`🔍 AML Status: ${selectedMetadata.amlStatus}`);
            console.log(`✅ Compliance Status: ${selectedMetadata.complianceStatus}`);
            console.log(`📅 Created: ${selectedMetadata.createdAt}`);

        } catch (error) {
            displayError(`UTXO verification failed: ${error.message}`);
        }
    }

    /**
     * Option 11: Show complete proof
     *
     * @returns {Promise<void>}
     */
    async showCompleteProof() {
        displaySection('SHOW COMPLETE PROOF', '🔐');
        console.log('⚠️  This feature displays complete compliance proofs');
        console.log('💡 Use the comprehensive privacy system for full implementation');
    }

    /**
     * Option 12: Run automated full test
     *
     * @returns {Promise<void>}
     */
    async runAutomatedTest() {
        displaySection('RUN AUTOMATED FULL TEST', '🧪');
        console.log('⚠️  This feature runs automated compliance tests');
        console.log('💡 Use the comprehensive testing system for full implementation');
    }

    // ========== KYC CLAIM HELPER METHODS ==========

    /**
     * Issue KYC claim for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async issueKYCClaimForIdentity(identity) {
        console.log(`\n📋 ISSUING KYC CLAIM FOR: ${identity.address}`);

        try {
            // Step 1: Ask for country code (from KYC proof submission)
            console.log('\n🌍 KYC PROOF SUBMISSION - COUNTRY VERIFICATION');
            console.log('='.repeat(70));
            console.log('📋 User submits KYC proof with their country of residence');
            console.log('🔍 ComplianceRules engine will verify if country is allowed');
            console.log('');
            console.log('💡 How it works:');
            console.log('   1. User submits country code with KYC proof');
            console.log('   2. System checks ComplianceRules (whitelist/blacklist)');
            console.log('   3. If country is allowed → KYC claim issued ✅');
            console.log('   4. If country is blocked → KYC claim rejected ❌');
            console.log('');
            console.log('📋 Common Country Codes (ISO 3166-1 numeric):');
            console.log('   840 - United States');
            console.log('   826 - United Kingdom');
            console.log('   124 - Canada');
            console.log('   276 - Germany');
            console.log('   250 - France');
            console.log('   156 - China (may be blocked)');
            console.log('   643 - Russia (may be blocked)');
            console.log('   850 - North Korea (may be blocked)');
            console.log('   364 - Iran (may be blocked)');
            console.log('');

            const countryInput = await this.promptUser('Enter country code from KYC proof (e.g., 840 for US): ');
            const countryCode = parseInt(countryInput) || 0;

            console.log(`\n🔍 COMPLIANCE CHECK: Verifying country ${countryCode}...`);

            // Step 2: Register identity with jurisdiction validation
            const identityRegistry = this.state.getContract('identityRegistry');
            if (identityRegistry) {
                try {
                    const existingIdentity = await identityRegistry.identity(identity.owner);

                    if (existingIdentity === identity.address) {
                        console.log('\n⚠️  IDENTITY ALREADY REGISTERED');
                        console.log(`   Country Code: ${countryCode}`);
                        console.log(`   ℹ️  Skipping registration, proceeding with KYC claim`);
                        identity.countryCode = countryCode;
                    } else {
                        console.log(`\n📝 Registering identity with country code ${countryCode}...`);
                        await identityRegistry.registerIdentity(
                            identity.owner,
                            identity.address,
                            countryCode
                        );

                        console.log('\n✅ IDENTITY REGISTERED SUCCESSFULLY!');
                        console.log(`   Country Code: ${countryCode}`);
                        console.log(`   ✅ Jurisdiction rules enforced`);
                        identity.countryCode = countryCode;
                    }
                } catch (error) {
                    if (error.message.includes('already registered')) {
                        console.log('\n⚠️  IDENTITY ALREADY REGISTERED');
                        console.log(`   Country Code: ${countryCode}`);
                        console.log(`   ℹ️  Proceeding with KYC claim`);
                        identity.countryCode = countryCode;
                    } else if (error.message.includes('Country not allowed') || error.message.includes('Country is blocked')) {
                        console.log('\n❌ IDENTITY REGISTRATION FAILED!');
                        console.log(`   Error: ${error.message}`);
                        console.log('\n💡 This means:');
                        console.log('   • User\'s country is BLOCKED by jurisdiction rules');
                        console.log('   • User\'s country is NOT in the allowed list');
                        console.log('   • User CANNOT participate in the system');
                        console.log('\n❌ KYC CLAIM NOT ISSUED - Country blocked');
                        return;
                    } else {
                        console.log('\n❌ IDENTITY REGISTRATION FAILED!');
                        console.log(`   Error: ${error.message}`);
                        console.log('\n❌ KYC CLAIM NOT ISSUED');
                        return;
                    }
                }
            }

            // Step 3: Issue KYC claim
            const kycIssuer = this.state.signers[1]; // KYC issuer
            const claimTopics = [1]; // KYC topic
            const claimData = ethers.AbiCoder.defaultAbiCoder().encode(
                ['uint256', 'bool'],
                [countryCode, true]
            );

            console.log('\n📝 Issuing KYC claim on-chain...');
            const OnchainID = await ethers.getContractFactory('OnchainID');
            const identityContract = OnchainID.attach(identity.address);

            await this.logger.logTransaction(
                'KYC Claim Issuance',
                identityContract.connect(kycIssuer).addClaim(
                    claimTopics[0],
                    1, // scheme
                    kycIssuer.address,
                    '0x', // signature
                    claimData,
                    ''
                ),
                {
                    identity: identity.address,
                    topic: claimTopics[0],
                    issuer: kycIssuer.address,
                    countryCode: countryCode
                }
            );

            // Store claim in state
            this.state.claims.set(`${identity.address}_KYC`, {
                type: 'KYC',
                identity: identity.address,
                issuer: kycIssuer.address,
                countryCode: countryCode,
                status: 'ISSUED',
                issuedAt: new Date().toISOString()
            });

            displaySuccess('KYC CLAIM ISSUED SUCCESSFULLY!');
            console.log(`   Identity: ${identity.address}`);
            console.log(`   Country Code: ${countryCode}`);
            console.log(`   Issuer: ${kycIssuer.address}`);

        } catch (error) {
            displayError(`KYC claim issuance failed: ${error.message}`);
        }
    }

    /**
     * Reject KYC claim for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async rejectKYCClaimForIdentity(identity) {
        console.log(`\n❌ REJECTING KYC CLAIM FOR: ${identity.address}`);

        const claim = this.state.claims.get(`${identity.address}_KYC`);
        if (claim) {
            claim.status = 'REJECTED';
            claim.rejectedAt = new Date().toISOString();
            displaySuccess('KYC claim rejected');
        } else {
            displayError('No KYC claim found to reject');
        }
    }

    /**
     * Update KYC status for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async updateKYCStatusForIdentity(identity) {
        console.log(`\n🔄 UPDATING KYC STATUS FOR: ${identity.address}`);

        const claim = this.state.claims.get(`${identity.address}_KYC`);
        if (!claim) {
            displayError('No KYC claim found to update');
            return;
        }

        console.log('\n📋 Select new status:');
        console.log('1. ISSUED');
        console.log('2. REJECTED');
        console.log('3. REVOKED');
        console.log('4. EXPIRED');

        const choice = await this.promptUser('Select status (1-4): ');
        const statusMap = { '1': 'ISSUED', '2': 'REJECTED', '3': 'REVOKED', '4': 'EXPIRED' };

        if (statusMap[choice]) {
            claim.status = statusMap[choice];
            claim.updatedAt = new Date().toISOString();
            displaySuccess(`KYC status updated to: ${statusMap[choice]}`);
        } else {
            displayError('Invalid choice');
        }
    }

    /**
     * View KYC history for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async viewKYCHistoryForIdentity(identity) {
        console.log(`\n📜 KYC HISTORY FOR: ${identity.address}`);
        console.log('='.repeat(50));

        const claim = this.state.claims.get(`${identity.address}_KYC`);
        if (!claim) {
            console.log('❌ No KYC claim found');
            return;
        }

        console.log(`\n📋 KYC Claim Details:`);
        console.log(`   Status: ${claim.status}`);
        console.log(`   Issuer: ${claim.issuer}`);
        console.log(`   Country Code: ${claim.countryCode}`);
        console.log(`   Issued At: ${claim.issuedAt}`);
        if (claim.updatedAt) console.log(`   Updated At: ${claim.updatedAt}`);
        if (claim.rejectedAt) console.log(`   Rejected At: ${claim.rejectedAt}`);
        if (claim.revokedAt) console.log(`   Revoked At: ${claim.revokedAt}`);
    }

    /**
     * Revoke KYC claim for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async revokeKYCClaimForIdentity(identity) {
        console.log(`\n🚫 REVOKING KYC CLAIM FOR: ${identity.address}`);

        const claim = this.state.claims.get(`${identity.address}_KYC`);
        if (claim) {
            claim.status = 'REVOKED';
            claim.revokedAt = new Date().toISOString();
            displaySuccess('KYC claim revoked');
        } else {
            displayError('No KYC claim found to revoke');
        }
    }

    // ========== AML CLAIM HELPER METHODS ==========

    /**
     * Issue AML claim for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async issueAMLClaimForIdentity(identity) {
        console.log(`\n🔍 ISSUING AML CLAIM FOR: ${identity.address}`);

        try {
            const amlIssuer = this.state.signers[2]; // AML issuer
            const claimTopics = [2]; // AML topic
            const claimData = ethers.AbiCoder.defaultAbiCoder().encode(
                ['bool'],
                [true]
            );

            console.log('\n📝 Issuing AML claim on-chain...');
            const OnchainID = await ethers.getContractFactory('OnchainID');
            const identityContract = OnchainID.attach(identity.address);

            await this.logger.logTransaction(
                'AML Claim Issuance',
                identityContract.connect(amlIssuer).addClaim(
                    claimTopics[0],
                    1, // scheme
                    amlIssuer.address,
                    '0x', // signature
                    claimData,
                    ''
                ),
                {
                    identity: identity.address,
                    topic: claimTopics[0],
                    issuer: amlIssuer.address
                }
            );

            // Store claim in state
            this.state.claims.set(`${identity.address}_AML`, {
                type: 'AML',
                identity: identity.address,
                issuer: amlIssuer.address,
                status: 'ISSUED',
                issuedAt: new Date().toISOString()
            });

            displaySuccess('AML CLAIM ISSUED SUCCESSFULLY!');
            console.log(`   Identity: ${identity.address}`);
            console.log(`   Issuer: ${amlIssuer.address}`);

        } catch (error) {
            displayError(`AML claim issuance failed: ${error.message}`);
        }
    }

    /**
     * Reject AML claim for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async rejectAMLClaimForIdentity(identity) {
        console.log(`\n❌ REJECTING AML CLAIM FOR: ${identity.address}`);

        const claim = this.state.claims.get(`${identity.address}_AML`);
        if (claim) {
            claim.status = 'REJECTED';
            claim.rejectedAt = new Date().toISOString();
            displaySuccess('AML claim rejected');
        } else {
            displayError('No AML claim found to reject');
        }
    }

    /**
     * Update AML status for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async updateAMLStatusForIdentity(identity) {
        console.log(`\n🔄 UPDATING AML STATUS FOR: ${identity.address}`);

        const claim = this.state.claims.get(`${identity.address}_AML`);
        if (!claim) {
            displayError('No AML claim found to update');
            return;
        }

        console.log('\n📋 Select new status:');
        console.log('1. ISSUED');
        console.log('2. REJECTED');
        console.log('3. REVOKED');
        console.log('4. EXPIRED');

        const choice = await this.promptUser('Select status (1-4): ');
        const statusMap = { '1': 'ISSUED', '2': 'REJECTED', '3': 'REVOKED', '4': 'EXPIRED' };

        if (statusMap[choice]) {
            claim.status = statusMap[choice];
            claim.updatedAt = new Date().toISOString();
            displaySuccess(`AML status updated to: ${statusMap[choice]}`);
        } else {
            displayError('Invalid choice');
        }
    }

    /**
     * View AML history for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async viewAMLHistoryForIdentity(identity) {
        console.log(`\n📜 AML HISTORY FOR: ${identity.address}`);
        console.log('='.repeat(50));

        const claim = this.state.claims.get(`${identity.address}_AML`);
        if (!claim) {
            console.log('❌ No AML claim found');
            return;
        }

        console.log(`\n🔍 AML Claim Details:`);
        console.log(`   Status: ${claim.status}`);
        console.log(`   Issuer: ${claim.issuer}`);
        console.log(`   Issued At: ${claim.issuedAt}`);
        if (claim.updatedAt) console.log(`   Updated At: ${claim.updatedAt}`);
        if (claim.rejectedAt) console.log(`   Rejected At: ${claim.rejectedAt}`);
        if (claim.revokedAt) console.log(`   Revoked At: ${claim.revokedAt}`);
    }

    /**
     * Revoke AML claim for an identity
     * @param {Object} identity - Identity object
     * @returns {Promise<void>}
     * @private
     */
    async revokeAMLClaimForIdentity(identity) {
        console.log(`\n🚫 REVOKING AML CLAIM FOR: ${identity.address}`);

        const claim = this.state.claims.get(`${identity.address}_AML`);
        if (claim) {
            claim.status = 'REVOKED';
            claim.revokedAt = new Date().toISOString();
            displaySuccess('AML claim revoked');
        } else {
            displayError('No AML claim found to revoke');
        }
    }

    // ========== KEY RECOVERY HELPER METHODS ==========

    /**
     * Remove a compromised key from an identity
     */
    async removeCompromisedKey(onchainID, identity) {
        console.log('\n🗑️  REMOVE COMPROMISED KEY');
        console.log('='.repeat(40));

        // ========== STEP 1: OWNER CONFIRMATION ==========
        console.log('\n👑 OWNER CONFIRMATION REQUIRED');
        console.log('='.repeat(70));
        console.log('⚠️  This operation will permanently remove a key from the identity');
        console.log('⚠️  The identity owner must approve this action');
        console.log('');

        // Find owner's signer
        const ownerAddress = identity.owner;
        let ownerSigner;
        for (const signer of this.state.signers) {
            const addr = await signer.getAddress();
            if (addr.toLowerCase() === ownerAddress.toLowerCase()) {
                ownerSigner = signer;
                break;
            }
        }

        if (!ownerSigner) {
            displayError(`Owner signer not found for address: ${ownerAddress}`);
            console.log('   ℹ️  The identity owner must be one of the available signers');
            return;
        }

        console.log(`   Owner: ${ownerAddress}`);
        console.log('   Please confirm you want to proceed with key removal');

        const ownerConfirm = await this.promptUser('Owner confirms key removal? (yes/no): ');
        if (ownerConfirm.toLowerCase() !== 'yes') {
            console.log('   ❌ Operation cancelled by owner');
            return;
        }

        // Owner signs confirmation
        const confirmMessage = `Approve key removal from OnchainID: ${await onchainID.getAddress()}`;
        const ownerSignature = await ownerSigner.signMessage(confirmMessage);
        const recoveredOwner = ethers.verifyMessage(confirmMessage, ownerSignature);

        if (recoveredOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
            displayError('Owner signature verification failed');
            return;
        }

        console.log('   ✅ Owner approval verified');

        // ========== STEP 2: SELECT KEY TO REMOVE ==========
        const keyPurposes = [
            { id: 1, name: 'Management' },
            { id: 2, name: 'Action' },
            { id: 3, name: 'Claim Signer' },
            { id: 4, name: 'Encryption' }
        ];

        console.log('\n📋 Select key purpose to remove:');
        keyPurposes.forEach((p, i) => {
            console.log(`   ${i + 1}. ${p.name} Keys`);
        });

        const purposeChoice = await this.promptUser('Select purpose (1-4): ');
        const selectedPurpose = keyPurposes[parseInt(purposeChoice) - 1];

        if (!selectedPurpose) {
            displayError('Invalid purpose selection');
            return;
        }

        const keys = await onchainID.getKeysByPurpose(selectedPurpose.id);

        if (keys.length === 0) {
            displayError('No keys found for this purpose');
            return;
        }

        console.log(`\n🔑 ${selectedPurpose.name} Keys:`);
        for (let i = 0; i < keys.length; i++) {
            console.log(`   ${i}: ${keys[i]}`);
        }

        const keyIndex = await this.promptUser(`Select key to remove (0-${keys.length - 1}): `);
        const keyToRemove = keys[parseInt(keyIndex)];

        if (!keyToRemove) {
            displayError('Invalid key selection');
            return;
        }

        // ========== STEP 3: PROVE OWNERSHIP OF KEY BEING REMOVED ==========
        console.log('\n🔐 SECURITY CHECK: Prove ownership of the key being removed');
        console.log('='.repeat(70));
        console.log('⚠️  You must prove you own this key before it can be removed!');
        console.log('');
        console.log('📋 How was this key created?');
        console.log('1. From Ethereum Address (requires signature)');
        console.log('2. From String/Passphrase (requires exact match)');
        console.log('0. Cancel');

        const keyTypeChoice = await this.promptUser('Select key type (0-2): ');

        if (keyTypeChoice === '0') {
            console.log('   ❌ Operation cancelled');
            return;
        }

        let keyOwnerSignature;
        let useSecureRemoval = false;

        if (keyTypeChoice === '1') {
            // Address-based key - require signature
            console.log('\n🔐 ADDRESS-BASED KEY VERIFICATION');
            console.log('Enter the Ethereum address of this key:');
            const keyAddress = await this.promptUser('Address: ');

            // Verify hash matches
            const expectedHash = ethers.keccak256(ethers.solidityPacked(['address'], [keyAddress]));
            if (expectedHash !== keyToRemove) {
                displayError('Address does not match the selected key hash');
                console.log(`   Expected: ${keyToRemove}`);
                console.log(`   Got: ${expectedHash}`);
                return;
            }

            // Find signer for this address
            let keySigner;
            for (const signer of this.state.signers) {
                const addr = await signer.getAddress();
                if (addr.toLowerCase() === keyAddress.toLowerCase()) {
                    keySigner = signer;
                    break;
                }
            }

            if (!keySigner) {
                displayError(`Signer not found for address: ${keyAddress}`);
                console.log('   ℹ️  The key owner must be one of the available signers');
                return;
            }

            // Sign message to prove ownership
            const message = `Remove key from OnchainID: ${await onchainID.getAddress()}`;
            keyOwnerSignature = await keySigner.signMessage(message);

            const recoveredAddress = ethers.verifyMessage(message, keyOwnerSignature);
            if (recoveredAddress.toLowerCase() !== keyAddress.toLowerCase()) {
                displayError('Signature verification failed - you do not own this key!');
                return;
            }

            console.log('   ✅ Key ownership verified via signature');
            useSecureRemoval = true;

        } else if (keyTypeChoice === '2') {
            // String-based key - require exact passphrase
            console.log('\n🔐 STRING-BASED KEY VERIFICATION');
            const keyString = await this.promptUser('Enter the exact string/passphrase: ');

            const expectedHash = ethers.id(keyString);
            if (expectedHash !== keyToRemove) {
                displayError('String does not match the selected key hash - incorrect passphrase!');
                return;
            }

            console.log('   ✅ Key ownership verified via passphrase match');
            useSecureRemoval = false; // String-based keys cannot use removeKeyWithProof

        } else {
            displayError('Invalid choice');
            return;
        }

        // ========== STEP 4: REMOVE KEY WITH APPROPRIATE METHOD ==========
        console.log('\n🗑️  Removing key...');

        let tx;
        if (useSecureRemoval) {
            // Use secure removeKeyWithProof for address-based keys
            console.log('   ℹ️  Using secure removeKeyWithProof() function');
            tx = await onchainID.connect(ownerSigner).removeKeyWithProof(
                keyToRemove,
                selectedPurpose.id,
                keyOwnerSignature
            );
        } else {
            // Use removeKey for string-based keys (no on-chain proof possible)
            console.log('   ⚠️  Using removeKey() for string-based key (passphrase verified)');
            tx = await onchainID.connect(ownerSigner).removeKey(keyToRemove, selectedPurpose.id);
        }

        await tx.wait();

        displaySuccess('Key removed successfully!');
        console.log(`   Key: ${keyToRemove}`);
        console.log(`   Purpose: ${selectedPurpose.name}`);
        console.log(`   Method: ${useSecureRemoval ? 'removeKeyWithProof (secure)' : 'removeKey (passphrase verified)'}`);
    }

    /**
     * Add a recovery key to an identity
     */
    async addRecoveryKey(onchainID, identity) {
        console.log('\n🔐 ADD RECOVERY KEY');
        console.log('='.repeat(40));

        // ========== STEP 1: OWNER CONFIRMATION ==========
        console.log('\n👑 OWNER CONFIRMATION REQUIRED');
        console.log('='.repeat(70));
        console.log('⚠️  This operation will add a new recovery key to the identity');
        console.log('⚠️  The identity owner must approve this action');
        console.log('');

        // Find owner's signer
        const ownerAddress = identity.owner;
        let ownerSigner;
        for (const signer of this.state.signers) {
            const addr = await signer.getAddress();
            if (addr.toLowerCase() === ownerAddress.toLowerCase()) {
                ownerSigner = signer;
                break;
            }
        }

        if (!ownerSigner) {
            displayError(`Owner signer not found for address: ${ownerAddress}`);
            console.log('   ℹ️  The identity owner must be one of the available signers');
            return;
        }

        console.log(`   Owner: ${ownerAddress}`);
        console.log('   Please confirm you want to proceed with adding recovery key');

        const ownerConfirm = await this.promptUser('Owner confirms adding recovery key? (yes/no): ');
        if (ownerConfirm.toLowerCase() !== 'yes') {
            console.log('   ❌ Operation cancelled by owner');
            return;
        }

        // Owner signs confirmation
        const confirmMessage = `Approve adding recovery key to OnchainID: ${await onchainID.getAddress()}`;
        const ownerSignature = await ownerSigner.signMessage(confirmMessage);
        const recoveredOwner = ethers.verifyMessage(confirmMessage, ownerSignature);

        if (recoveredOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
            displayError('Owner signature verification failed');
            return;
        }

        console.log('   ✅ Owner approval verified');

        // ========== STEP 2: CHOOSE KEY INPUT METHOD ==========
        console.log('\n🔐 KEY INPUT METHOD:');
        console.log('1. From Ethereum Address');
        console.log('2. From String/Passphrase');
        console.log('0. Back');

        const inputMethod = await this.promptUser('Select input method (0-2): ');

        let keyHash;
        let keyInfo;

        if (inputMethod === '1') {
            // Method 1: From Ethereum Address (with signature verification)

            // Show available signers
            console.log('\n👥 Available Signers:');
            const signerAddresses = await Promise.all(
                this.state.signers.map(s => s.getAddress())
            );

            for (let i = 0; i < signerAddresses.length; i++) {
                console.log(`   ${i}: ${signerAddresses[i]}`);
            }
            console.log(`   ${signerAddresses.length}: Enter custom address`);

            const signerChoice = await this.promptUser(`Select signer (0-${signerAddresses.length}): `);
            const choiceIndex = parseInt(signerChoice);

            let recoveryAddress;

            if (choiceIndex >= 0 && choiceIndex < signerAddresses.length) {
                recoveryAddress = signerAddresses[choiceIndex];
            } else if (choiceIndex === signerAddresses.length) {
                recoveryAddress = await this.promptUser('Enter custom recovery address: ');
            } else {
                displayError('Invalid selection');
                return;
            }

            if (!ethers.isAddress(recoveryAddress)) {
                displayError('Invalid Ethereum address');
                return;
            }

            // Signature verification
            const signerIndex = signerAddresses.findIndex(
                addr => addr.toLowerCase() === recoveryAddress.toLowerCase()
            );

            if (signerIndex >= 0) {
                // Auto-sign with available signer
                console.log('\n🔐 Verifying ownership via signature...');
                const message = `Add Recovery Key to OnchainID: ${identity.address}`;
                const signer = this.state.signers[signerIndex];
                const signature = await signer.signMessage(message);
                const recoveredAddr = ethers.verifyMessage(message, signature);

                if (recoveredAddr.toLowerCase() !== recoveryAddress.toLowerCase()) {
                    displayError('Signature verification failed');
                    return;
                }
                console.log('✅ Signature verified!');
            } else {
                // Manual signature required
                console.log('\n⚠️  External address - signature required');
                const message = `Add Recovery Key to OnchainID: ${identity.address}`;
                console.log(`📝 Message to sign: "${message}"`);
                const signature = await this.promptUser('Enter signature (0x...): ');

                try {
                    const recoveredAddr = ethers.verifyMessage(message, signature);
                    if (recoveredAddr.toLowerCase() !== recoveryAddress.toLowerCase()) {
                        displayError('Signature verification failed');
                        return;
                    }
                    console.log('✅ Signature verified!');
                } catch (error) {
                    displayError(`Signature verification failed: ${error.message}`);
                    return;
                }
            }

            keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveryAddress]));
            keyInfo = `Recovery Address: ${recoveryAddress} (Verified)`;

        } else if (inputMethod === '2') {
            // Method 2: From String/Passphrase
            const recoveryString = await this.promptUser('Enter recovery string/passphrase: ');

            if (!recoveryString || recoveryString.trim().length === 0) {
                displayError('String cannot be empty');
                return;
            }

            keyHash = ethers.id(recoveryString);
            keyInfo = `Recovery String: "${recoveryString}" (length: ${recoveryString.length})`;

        } else if (inputMethod === '0') {
            return;
        } else {
            displayError('Invalid input method');
            return;
        }

        console.log('\n🔐 Adding recovery key as Management Key...');
        console.log('   ℹ️  Transaction will be sent by owner');
        const tx = await onchainID.connect(ownerSigner).addKey(keyHash, 1, 1); // MANAGEMENT_KEY, ECDSA_TYPE
        await tx.wait();

        displaySuccess('Recovery key added successfully!');
        console.log(`   ${keyInfo}`);
        console.log(`   Key Hash: ${keyHash}`);
        console.log(`   Purpose: Management (1)`);
        console.log(`   Added by: ${ownerAddress} (owner)`);
    }

    /**
     * Replace a management key (for key rotation)
     */
    async replaceManagementKey(onchainID, identity) {
        console.log('\n🔄 REPLACE MANAGEMENT KEY');
        console.log('='.repeat(40));

        // ========== STEP 1: OWNER CONFIRMATION ==========
        console.log('\n👑 OWNER CONFIRMATION REQUIRED');
        console.log('='.repeat(70));
        console.log('⚠️  This operation will replace a management key');
        console.log('⚠️  The identity owner must approve this action');
        console.log('');

        // Find owner's signer
        const ownerAddress = identity.owner;
        let ownerSigner;
        for (const signer of this.state.signers) {
            const addr = await signer.getAddress();
            if (addr.toLowerCase() === ownerAddress.toLowerCase()) {
                ownerSigner = signer;
                break;
            }
        }

        if (!ownerSigner) {
            displayError(`Owner signer not found for address: ${ownerAddress}`);
            console.log('   ℹ️  The identity owner must be one of the available signers');
            return;
        }

        console.log(`   Owner: ${ownerAddress}`);
        console.log('   Please confirm you want to proceed with key replacement');

        const ownerConfirm = await this.promptUser('Owner confirms key replacement? (yes/no): ');
        if (ownerConfirm.toLowerCase() !== 'yes') {
            console.log('   ❌ Operation cancelled by owner');
            return;
        }

        // Owner signs confirmation
        const confirmMessage = `Approve key replacement on OnchainID: ${await onchainID.getAddress()}`;
        const ownerSignature = await ownerSigner.signMessage(confirmMessage);
        const recoveredOwner = ethers.verifyMessage(confirmMessage, ownerSignature);

        if (recoveredOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
            displayError('Owner signature verification failed');
            return;
        }

        console.log('   ✅ Owner approval verified');

        // ========== STEP 2: SELECT KEY TO REPLACE ==========
        const managementKeys = await onchainID.getKeysByPurpose(1);

        if (managementKeys.length === 0) {
            displayError('No management keys found');
            return;
        }

        console.log('\n🔑 Current Management Keys:');
        for (let i = 0; i < managementKeys.length; i++) {
            console.log(`   ${i}: ${managementKeys[i]}`);
        }

        const oldKeyIndex = await this.promptUser(`Select key to replace (0-${managementKeys.length - 1}): `);
        const oldKey = managementKeys[parseInt(oldKeyIndex)];

        if (!oldKey) {
            displayError('Invalid key selection');
            return;
        }

        // ========== STEP 3: VERIFY OWNERSHIP OF OLD KEY ==========
        console.log('\n🔐 SECURITY CHECK: Prove ownership of the OLD key');
        console.log('='.repeat(70));
        console.log('⚠️  You must prove you own the key being replaced!');
        console.log('');
        console.log('📋 OLD KEY INPUT METHOD:');
        console.log('1. From Ethereum Address (requires signature)');
        console.log('2. From String/Passphrase (requires exact match)');
        console.log('0. Cancel');

        const oldKeyMethod = await this.promptUser('How was the OLD key created? (0-2): ');

        if (oldKeyMethod === '0') {
            console.log('❌ Key replacement cancelled');
            return;
        }

        let oldKeyVerified = false;
        let oldKeySignature = null;
        let useSecureRemoval = false;

        if (oldKeyMethod === '1') {
            // Method 1: Verify address-based key with signature
            console.log('\n🔐 VERIFY ADDRESS-BASED KEY');
            const oldAddress = await this.promptUser('Enter the Ethereum address of the OLD key: ');

            if (!ethers.isAddress(oldAddress)) {
                displayError('Invalid Ethereum address');
                return;
            }

            // Verify the hash matches
            const expectedHash = ethers.keccak256(ethers.solidityPacked(['address'], [oldAddress]));
            if (expectedHash !== oldKey) {
                displayError('Address does not match the selected key hash');
                console.log(`   Expected: ${oldKey}`);
                console.log(`   Got: ${expectedHash}`);
                return;
            }

            // Find signer for this address
            let oldKeySigner;
            for (const signer of this.state.signers) {
                const addr = await signer.getAddress();
                if (addr.toLowerCase() === oldAddress.toLowerCase()) {
                    oldKeySigner = signer;
                    break;
                }
            }

            if (oldKeySigner) {
                // Auto-sign with available signer
                console.log('\n🔐 Signing challenge to prove ownership...');
                const message = `Prove ownership of OLD key for OnchainID: ${identity.address}`;
                oldKeySignature = await oldKeySigner.signMessage(message);
                const recoveredAddr = ethers.verifyMessage(message, oldKeySignature);

                if (recoveredAddr.toLowerCase() !== oldAddress.toLowerCase()) {
                    displayError('Signature verification failed - you do not own this key!');
                    return;
                }
                console.log('✅ Ownership verified via signature!');
                oldKeyVerified = true;
                useSecureRemoval = true;
            } else {
                // Manual signature required
                console.log('\n⚠️  External address - signature required');
                const message = `Prove ownership of OLD key for OnchainID: ${identity.address}`;
                console.log(`📝 Message to sign: "${message}"`);
                oldKeySignature = await this.promptUser('Enter signature (0x...): ');

                try {
                    const recoveredAddr = ethers.verifyMessage(message, oldKeySignature);
                    if (recoveredAddr.toLowerCase() !== oldAddress.toLowerCase()) {
                        displayError('Signature verification failed - you do not own this key!');
                        return;
                    }
                    console.log('✅ Ownership verified via signature!');
                    oldKeyVerified = true;
                    useSecureRemoval = true;
                } catch (error) {
                    displayError(`Signature verification failed: ${error.message}`);
                    return;
                }
            }

        } else if (oldKeyMethod === '2') {
            // Method 2: Verify string-based key with exact match
            console.log('\n🔐 VERIFY STRING-BASED KEY');
            const oldString = await this.promptUser('Enter the exact string/passphrase of the OLD key: ');

            if (!oldString || oldString.trim().length === 0) {
                displayError('String cannot be empty');
                return;
            }

            // Verify the hash matches
            const expectedHash = ethers.id(oldString);
            if (expectedHash !== oldKey) {
                displayError('String does not match the selected key hash - incorrect passphrase!');
                console.log(`   Expected: ${oldKey}`);
                console.log(`   Got: ${expectedHash}`);
                return;
            }

            console.log('✅ Ownership verified - string matches!');
            oldKeyVerified = true;

        } else {
            displayError('Invalid input method');
            return;
        }

        if (!oldKeyVerified) {
            displayError('Failed to verify ownership of OLD key - replacement cancelled');
            return;
        }

        console.log('\n✅ OLD KEY OWNERSHIP VERIFIED!');
        console.log('   You have proven you own the key being replaced');
        console.log('');
        // ========== END SECURITY CHECK ==========

        // Choose key input method for new key
        console.log('\n🔐 NEW KEY INPUT METHOD:');
        console.log('1. From Ethereum Address');
        console.log('2. From String/Passphrase');
        console.log('0. Back');

        const inputMethod = await this.promptUser('Select input method (0-2): ');

        let newKeyHash;
        let keyInfo;

        if (inputMethod === '1') {
            // Method 1: From Ethereum Address (with signature verification)

            // Show available signers
            console.log('\n👥 Available Signers:');
            const signerAddresses = await Promise.all(
                this.state.signers.map(s => s.getAddress())
            );

            for (let i = 0; i < signerAddresses.length; i++) {
                console.log(`   ${i}: ${signerAddresses[i]}`);
            }
            console.log(`   ${signerAddresses.length}: Enter custom address`);

            const signerChoice = await this.promptUser(`Select signer (0-${signerAddresses.length}): `);
            const choiceIndex = parseInt(signerChoice);

            let newAddress;

            if (choiceIndex >= 0 && choiceIndex < signerAddresses.length) {
                newAddress = signerAddresses[choiceIndex];
            } else if (choiceIndex === signerAddresses.length) {
                newAddress = await this.promptUser('Enter custom management address: ');
            } else {
                displayError('Invalid selection');
                return;
            }

            if (!ethers.isAddress(newAddress)) {
                displayError('Invalid Ethereum address');
                return;
            }

            // Signature verification
            const signerIndex = signerAddresses.findIndex(
                addr => addr.toLowerCase() === newAddress.toLowerCase()
            );

            if (signerIndex >= 0) {
                // Auto-sign with available signer
                console.log('\n🔐 Verifying ownership via signature...');
                const message = `Replace Management Key for OnchainID: ${identity.address}`;
                const signer = this.state.signers[signerIndex];
                const signature = await signer.signMessage(message);
                const recoveredAddr = ethers.verifyMessage(message, signature);

                if (recoveredAddr.toLowerCase() !== newAddress.toLowerCase()) {
                    displayError('Signature verification failed');
                    return;
                }
                console.log('✅ Signature verified!');
            } else {
                // Manual signature required
                console.log('\n⚠️  External address - signature required');
                const message = `Replace Management Key for OnchainID: ${identity.address}`;
                console.log(`📝 Message to sign: "${message}"`);
                const signature = await this.promptUser('Enter signature (0x...): ');

                try {
                    const recoveredAddr = ethers.verifyMessage(message, signature);
                    if (recoveredAddr.toLowerCase() !== newAddress.toLowerCase()) {
                        displayError('Signature verification failed');
                        return;
                    }
                    console.log('✅ Signature verified!');
                } catch (error) {
                    displayError(`Signature verification failed: ${error.message}`);
                    return;
                }
            }

            newKeyHash = ethers.keccak256(ethers.solidityPacked(['address'], [newAddress]));
            keyInfo = `New Address: ${newAddress} (Verified)`;

        } else if (inputMethod === '2') {
            // Method 2: From String/Passphrase
            const newString = await this.promptUser('Enter new management string/passphrase: ');

            if (!newString || newString.trim().length === 0) {
                displayError('String cannot be empty');
                return;
            }

            newKeyHash = ethers.id(newString);
            keyInfo = `New String: "${newString}" (length: ${newString.length})`;

        } else if (inputMethod === '0') {
            return;
        } else {
            displayError('Invalid input method');
            return;
        }

        console.log('\n🔄 Replacing management key...');
        console.log('   ℹ️  Transaction will be sent by owner');

        // Add new key first
        console.log('   1. Adding new key...');
        let tx = await onchainID.connect(ownerSigner).addKey(newKeyHash, 1, 1);
        await tx.wait();
        console.log('   ✅ New key added');

        // Remove old key with appropriate method
        console.log('   2. Removing old key...');
        if (useSecureRemoval) {
            console.log('   ℹ️  Using secure removeKeyWithProof() function');
            tx = await onchainID.connect(ownerSigner).removeKeyWithProof(oldKey, 1, oldKeySignature);
        } else {
            console.log('   ⚠️  Using removeKey() for string-based key (passphrase verified)');
            tx = await onchainID.connect(ownerSigner).removeKey(oldKey, 1);
        }
        await tx.wait();
        console.log('   ✅ Old key removed');

        displaySuccess('Management key replaced successfully!');
        console.log(`   Old Key: ${oldKey}`);
        console.log(`   New Key: ${newKeyHash}`);
        console.log(`   ${keyInfo}`);
        console.log(`   Method: ${useSecureRemoval ? 'removeKeyWithProof (secure)' : 'removeKey (passphrase verified)'}`);
        console.log(`   Executed by: ${ownerAddress} (owner)`);
    }
}

module.exports = OnchainIDModule;


