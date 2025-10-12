/**
 * @fileoverview Enhanced escrow system module
 * @module EscrowModule
 * @description Handles escrow operations including wallet creation, payment workflows,
 * dispute resolution, and investor mediation.
 * Covers menu options 61-73.
 */

const { displaySection, displaySuccess, displayError, displayWarning } = require('../utils/DisplayHelpers');
const { ethers } = require('hardhat');

/**
 * @class EscrowModule
 * @description Manages enhanced escrow operations.
 */
class EscrowModule {
    constructor(state, logger, promptUser) {
        this.state = state;
        this.logger = logger;
        this.promptUser = promptUser;
    }

    /** Option 61: Deploy Enhanced Escrow System */
    async deployEscrowSystem() {
        displaySection('DEPLOYING ENHANCED ESCROW SYSTEM', '🏗️');
        console.log('One-time-use multi-signature escrow wallets');
        console.log('');

        try {
            const digitalToken = this.state.getContract('digitalToken');
            if (!digitalToken) {
                displayError('VSC Token not deployed. Please deploy ERC-3643 system first (option 21)');
                return;
            }

            const identityRegistry = this.state.getContract('identityRegistry');
            if (!identityRegistry) {
                displayError('IdentityRegistry not deployed. Please deploy ERC-3643 system first (option 21)');
                return;
            }

            const signers = this.state.signers;
            const owner = signers[0];
            const ownerWallet = signers[1]; // Owner's wallet for receiving fees

            console.log('📋 Deploying EscrowWalletFactory...');
            console.log(`   VSC Token: ${await digitalToken.getAddress()}`);
            console.log(`   Identity Registry: ${await identityRegistry.getAddress()}`);
            console.log(`   Compliance Rules: ${await this.state.getContract('complianceRules').getAddress()}`);
            console.log(`   Owner Wallet: ${ownerWallet.address}`);
            console.log('');

            const EscrowWalletFactory = await ethers.getContractFactory('EscrowWalletFactory');
            const escrowFactory = await EscrowWalletFactory.deploy(
                await digitalToken.getAddress(),
                ownerWallet.address,
                await identityRegistry.getAddress(),
                await this.state.getContract('complianceRules').getAddress()
            );
            await escrowFactory.waitForDeployment();

            this.state.setContract('escrowFactory', escrowFactory);
            this.state.escrowFactory = escrowFactory; // Alias
            console.log(`✅ EscrowWalletFactory: ${await escrowFactory.getAddress()}`);

            // Grant factory permission to add trusted contracts
            console.log('');
            console.log('🔐 Granting factory permission to add trusted contracts...');
            const factoryAddress = await escrowFactory.getAddress();

            // Note that the owner (signers[0]) will add wallets
            console.log('   ℹ️  Factory will request owner to add wallets to trusted contracts');
            console.log('   ℹ️  Owner address: ' + owner.address);

            // ADD OWNER WALLET TO TRUSTED CONTRACTS
            // This is needed because escrow wallets transfer fees to the owner wallet
            console.log('');
            console.log('🔐 Adding owner wallet to trusted contracts...');
            const addOwnerTx = await this.state.getContract('complianceRules').connect(owner).addTrustedContract(ownerWallet.address);
            await addOwnerTx.wait();
            console.log(`   ✅ Owner wallet (${ownerWallet.address}) added to trusted contracts`);
            console.log('   💡 This allows escrow wallets to transfer service fees to owner');

            console.log('');
            displaySuccess('ENHANCED ESCROW SYSTEM DEPLOYED SUCCESSFULLY!');
            console.log('');
            console.log('📊 SYSTEM OVERVIEW:');
            console.log(`   Factory: ${await escrowFactory.getAddress()}`);
            console.log(`   VSC Token: ${await digitalToken.getAddress()}`);
            console.log(`   Identity Registry: ${await identityRegistry.getAddress()}`);
            console.log(`   Compliance Rules: ${await this.state.getContract('complianceRules').getAddress()}`);
            console.log(`   Owner Wallet: ${ownerWallet.address}`);
            console.log('');
            console.log('🔐 SECURITY MODEL:');
            console.log('   ✅ Payer must have valid OnchainID + KYC/AML');
            console.log('   ✅ Payee must have valid OnchainID + KYC/AML');
            console.log('   ✅ Escrow wallets added to trusted contracts (owner-only)');
            console.log('   ✅ Jurisdiction rules enforced for all parties');
            console.log('   ✅ No KYC/AML bypass - secure compliance!');
            console.log('');
            console.log('⚠️  IMPORTANT:');
            console.log('   Each escrow wallet will be automatically added to trusted contracts');
            console.log('   when created. This requires ComplianceRules owner permission.');
            console.log('');
            console.log('💡 NEXT STEPS:');
            console.log('   1. Register investors (Option 62)');
            console.log('   2. Create escrow wallets (Option 63)');
            console.log('   3. Fund and use the system');

        } catch (error) {
            displayError(`Deployment failed: ${error.message}`);
        }
    }

    /**
     * Helper: Get signer for a specific address
     */
    async getSignerForAddress(address) {
        const signer = this.state.signers.find(s => s.address.toLowerCase() === address.toLowerCase());
        if (!signer) {
            throw new Error(`No signer found for address ${address}`);
        }
        return signer;
    }

    /** Option 62: Register Investor (from Option 23) */
    async registerInvestor() {
        displaySection('REGISTER INVESTOR FOR ENHANCED ESCROW', '👤');

        const escrowFactory = this.state.getContract('escrowFactory');
        if (!escrowFactory) {
            displayError('Enhanced Escrow not deployed. Please deploy first (option 61)');
            return;
        }

        if (!this.state.investors || this.state.investors.size === 0) {
            displayError('No investors found. Please create investors first (Option 23)');
            return;
        }

        // Initialize registeredInvestors if not exists
        if (!this.state.registeredInvestors) {
            this.state.registeredInvestors = new Map();
        }

        try {
            const investorArray = Array.from(this.state.investors.values());
            console.log('\n📋 AVAILABLE INVESTORS:');
            investorArray.forEach((inv, index) => {
                const displayName = inv.name || 'Unknown';
                const displayAddress = inv.user || inv.address || 'Unknown';
                console.log(`${index}. ${displayName} (${displayAddress})`);
            });

            const choice = await this.promptUser('\nSelect investor to register (number): ');
            const selectedInvestor = investorArray[parseInt(choice)];

            if (!selectedInvestor) {
                displayError('Invalid selection');
                return;
            }

            // Get the actual investor address (handle different structures)
            const investorAddress = selectedInvestor.user || selectedInvestor.address;

            // ✅ FIX: Use investor's multi-sig wallet as fee wallet if available
            // Otherwise, use the investor's bank address (separate from investor address)
            // This ensures fee wallet is DIFFERENT from investor address
            let investorWallet;

            if (selectedInvestor.multiSigWallet && selectedInvestor.multiSigWallet.address) {
                // Use multi-sig wallet if available
                investorWallet = selectedInvestor.multiSigWallet.address;
                console.log(`\n💡 Using investor's multi-sig wallet as fee wallet`);
            } else if (selectedInvestor.bank && selectedInvestor.bank !== investorAddress) {
                // Use bank address if available and different from investor
                investorWallet = selectedInvestor.bank;
                console.log(`\n💡 Using investor's bank address as fee wallet`);
            } else {
                // Create a new wallet for fees (use next available signer)
                // Use signer[3] as default fee wallet (different from investor)
                investorWallet = this.state.signers[3].address;
                console.log(`\n💡 Creating new fee wallet for investor`);
            }

            console.log(`\n📝 Registering investor...`);
            console.log(`   Investor Address: ${investorAddress}`);
            console.log(`   Fee Wallet: ${investorWallet}`);

            const tx = await escrowFactory.registerInvestor(
                investorAddress,
                investorWallet
            );
            await tx.wait();

            this.state.registeredInvestors.set(investorAddress, {
                ...selectedInvestor,
                investorAddress: investorAddress,
                walletAddress: investorWallet,
                registeredAt: new Date().toISOString()
            });

            displaySuccess('Investor registered successfully!');
            console.log(`   Investor Address: ${investorAddress}`);
            console.log(`   Fee Wallet: ${investorWallet}`);

        } catch (error) {
            displayError(`Registration failed: ${error.message}`);
        }
    }

    /** Option 63: Investor: Create Escrow Wallet */
    async createEscrowWallet() {
        displaySection('INVESTOR: CREATE ESCROW WALLET', '💼');

        const escrowFactory = this.state.getContract('escrowFactory');
        if (!escrowFactory) {
            displayError('Enhanced Escrow not deployed. Please deploy first (option 61)');
            return;
        }

        if (!this.state.registeredInvestors || this.state.registeredInvestors.size === 0) {
            displayError('No registered investors. Please register first (Option 62)');
            return;
        }

        // Initialize enhancedEscrowWallets if not exists
        if (!this.state.enhancedEscrowWallets) {
            this.state.enhancedEscrowWallets = new Map();
        }
        if (!this.state.enhancedPaymentCounter) {
            this.state.enhancedPaymentCounter = 0;
        }

        try {
            // Select investor
            const investorArray = Array.from(this.state.registeredInvestors.values());
            console.log('\n📋 REGISTERED INVESTORS:');
            investorArray.forEach((inv, index) => {
                const displayName = inv.name || 'Unknown';
                const displayAddress = inv.investorAddress || inv.user || inv.address || 'Unknown';
                console.log(`${index}. ${displayName} (${displayAddress})`);
            });

            const invChoice = await this.promptUser('\nSelect investor (number): ');
            const investor = investorArray[parseInt(invChoice)];

            if (!investor) {
                displayError('Invalid selection');
                return;
            }

            // Get the actual investor address
            const investorAddress = investor.investorAddress || investor.user || investor.address;

            // Get payer from normal users
            let payerAddress = null;
            let payerName = null;
            if (this.state.normalUsers && this.state.normalUsers.size > 0) {
                console.log('\n👤 SELECT PAYER (Normal User with KYC/AML):');
                const normalUsersArray = Array.from(this.state.normalUsers.values()).filter(u => u.tokenEligible);

                if (normalUsersArray.length === 0) {
                    displayError('No compliant normal users found!');
                    console.log('💡 Create a compliant user first (Option 24 → 1)');
                    return;
                }

                normalUsersArray.forEach((user, index) => {
                    console.log(`${index}. ${user.name} (${user.address.substring(0, 10)}...) ✅`);
                });
                console.log(`${normalUsersArray.length}. Unknown Payer (Marketplace Mode)`);

                const payerChoice = await this.promptUser(`\nSelect payer (0-${normalUsersArray.length}): `);
                const payerIndex = parseInt(payerChoice);

                if (payerIndex === normalUsersArray.length) {
                    // Unknown payer (marketplace mode)
                    payerAddress = ethers.ZeroAddress;
                    payerName = 'Unknown (Marketplace)';
                } else if (payerIndex >= 0 && payerIndex < normalUsersArray.length) {
                    const selectedPayer = normalUsersArray[payerIndex];
                    payerAddress = selectedPayer.address;
                    payerName = selectedPayer.name;
                } else {
                    displayError('Invalid selection');
                    return;
                }
            } else {
                displayError('No normal users found!');
                console.log('💡 Create normal users first (Option 24)');
                return;
            }

            // Get payee from normal users
            let payeeAddress = null;
            let payeeName = null;
            if (this.state.normalUsers && this.state.normalUsers.size > 0) {
                console.log('\n👤 SELECT PAYEE (Normal User with KYC/AML):');
                const normalUsersArray = Array.from(this.state.normalUsers.values()).filter(u => u.tokenEligible);

                normalUsersArray.forEach((user, index) => {
                    console.log(`${index}. ${user.name} (${user.address.substring(0, 10)}...) ✅`);
                });

                const payeeChoice = await this.promptUser(`\nSelect payee (0-${normalUsersArray.length - 1}): `);
                const payeeIndex = parseInt(payeeChoice);

                if (payeeIndex >= 0 && payeeIndex < normalUsersArray.length) {
                    const selectedPayee = normalUsersArray[payeeIndex];
                    payeeAddress = selectedPayee.address;
                    payeeName = selectedPayee.name;
                } else {
                    displayError('Invalid selection');
                    return;
                }
            }

            // Get amount
            const amountInput = await this.promptUser('\nEnter payment amount (VSC): ');
            const amount = ethers.parseEther(amountInput);

            console.log('\n📝 Creating escrow wallet...');
            console.log(`   Investor: ${investorAddress}`);
            console.log(`   Payer: ${payerName} (${payerAddress === ethers.ZeroAddress ? 'Unknown' : payerAddress})`);
            console.log(`   Payee: ${payeeName} (${payeeAddress})`);
            console.log(`   Amount: ${amountInput} VSC`);

            // Get investor signer
            const investorSigner = await this.getSignerForAddress(investorAddress);

            const tx = await escrowFactory.connect(investorSigner).createEscrowWallet(
                payerAddress,
                payeeAddress,
                amount
            );
            const receipt = await tx.wait();

            // Get payment ID from event
            const event = receipt.logs.find(log => {
                try {
                    return escrowFactory.interface.parseLog(log).name === 'EscrowWalletCreated';
                } catch (e) {
                    return false;
                }
            });

            if (event) {
                const parsedEvent = escrowFactory.interface.parseLog(event);
                const paymentId = parsedEvent.args.paymentId;
                const walletAddress = parsedEvent.args.walletAddress;

                // ✅ Add wallet to trusted contracts (owner must do this)
                console.log('\n🔐 Adding wallet to trusted contracts...');
                const owner = this.state.signers[0]; // Platform owner
                const complianceRules = this.state.getContract('complianceRules');
                const addTrustedTx = await complianceRules.connect(owner).addTrustedContract(walletAddress);
                await addTrustedTx.wait();
                console.log('   ✅ Wallet added to trusted contracts');

                // ✅ CRITICAL FIX: Add both payer AND payee to trusted contracts
                // This allows refunds when payer wins disputes
                if (payerAddress !== ethers.ZeroAddress) {
                    console.log('\n🔐 Adding payer to trusted contracts (for refunds)...');
                    const addPayerTx = await complianceRules.connect(owner).addTrustedContract(payerAddress);
                    await addPayerTx.wait();
                    console.log('   ✅ Payer added to trusted contracts');
                }

                console.log('\n🔐 Adding payee to trusted contracts (for payments)...');
                const addPayeeTx = await complianceRules.connect(owner).addTrustedContract(payeeAddress);
                await addPayeeTx.wait();
                console.log('   ✅ Payee added to trusted contracts');

                this.state.enhancedEscrowWallets.set(paymentId.toString(), {
                    paymentId: paymentId.toString(),
                    walletAddress,
                    payer: payerAddress,
                    payee: payeeAddress,
                    payerName: payerName,
                    payeeName: payeeName,
                    investor: investorAddress,
                    amount: amountInput,
                    createdAt: new Date().toISOString(),
                    state: 'Active'
                });

                this.state.enhancedPaymentCounter++;

                displaySuccess('Escrow wallet created successfully!');
                console.log(`   Payment ID: ${paymentId}`);
                console.log(`   Wallet Address: ${walletAddress}`);
                console.log(`   Payer: ${payerName}`);
                console.log(`   Payee: ${payeeName}`);
                console.log(`   Investor Fee (3%): ${parseFloat(amountInput) * 0.03} VSC`);
                console.log(`   Owner Fee (2%): ${parseFloat(amountInput) * 0.02} VSC`);
                console.log(`   Total Required: ${parseFloat(amountInput) * 1.05} VSC`);
            }

        } catch (error) {
            displayError(`Wallet creation failed: ${error.message}`);
        }
    }

    /** Option 64: Payer: Fund Escrow Wallet */
    async fundEscrowWallet() {
        displaySection('PAYER: FUND ESCROW WALLET', '💰');

        const escrowFactory = this.state.getContract('escrowFactory');
        if (!escrowFactory) {
            displayError('Enhanced Escrow not deployed. Please deploy first (option 61)');
            return;
        }

        if (!this.state.enhancedEscrowWallets || this.state.enhancedEscrowWallets.size === 0) {
            displayError('No escrow wallets created. Please create one first (Option 63)');
            return;
        }

        // List available wallets (only Active and not yet funded)
        console.log('\n📋 AVAILABLE ESCROW WALLETS:');
        const allWallets = Array.from(this.state.enhancedEscrowWallets.values());
        const wallets = allWallets.filter(w => w.state === 'Active' || w.state === 'ProofSubmitted');

        if (wallets.length === 0) {
            displayError('No active wallets available for funding');
            console.log('💡 All wallets are either funded, released, or refunded');
            return;
        }

        wallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName || 'Unknown Payer'} → ${wallet.payeeName} (${wallet.amount} VSC)`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet to fund (number): ');
        const selectedWallet = wallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;

            if (!walletAddress) {
                displayError('Wallet address not found');
                console.log('💡 Wallet data:', selectedWallet);
                return;
            }

            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            // Check if payer is set
            const payerSet = await wallet.payerSet();
            let payerAddress;

            if (!payerSet) {
                console.log('\n🛒 MARKETPLACE MODE: Payer unknown');
                console.log('First person to fund becomes the payer!');

                // List available signers
                console.log('\n📋 AVAILABLE SIGNERS:');
                this.state.signers.slice(0, 10).forEach((signer, index) => {
                    console.log(`${index}. ${signer.address}`);
                });

                const signerIndex = await this.promptUser('\nSelect signer to fund as payer (number): ');
                const payer = this.state.signers[parseInt(signerIndex)];
                payerAddress = payer.address;

                console.log(`\n📝 Funding as payer: ${payerAddress}`);
            } else {
                payerAddress = await wallet.payer();
                console.log(`\n📝 Payer: ${payerAddress}`);
            }

            const payer = await this.getSignerForAddress(payerAddress);
            const totalAmount = ethers.parseEther((parseFloat(selectedWallet.amount) * 1.05).toString());

            console.log(`\n💰 Approving ${ethers.formatEther(totalAmount)} VSC...`);
            const digitalToken = this.state.getContract('digitalToken');
            const approveTx = await digitalToken.connect(payer).approve(
                await escrowFactory.getAddress(),
                totalAmount
            );
            await approveTx.wait();

            // ✅ DEBUG: Check compliance before funding
            console.log('\n🔍 COMPLIANCE CHECK:');
            console.log(`   Payer: ${payerAddress}`);
            console.log(`   Wallet: ${walletAddress}`);

            const identityRegistry = this.state.getContract('identityRegistry');
            const complianceRules = this.state.getContract('complianceRules');

            const payerVerified = await identityRegistry.isVerified(payerAddress);
            console.log(`   Payer Verified: ${payerVerified}`);

            const walletTrusted = await complianceRules.isTrustedContract(walletAddress);
            console.log(`   Wallet Trusted: ${walletTrusted}`);

            const payerCountry = await identityRegistry.investorCountry(payerAddress);
            console.log(`   Payer Country: ${payerCountry}`);

            // Check payer's balance
            const payerBalance = await digitalToken.balanceOf(payerAddress);
            console.log(`   Payer Balance: ${ethers.formatEther(payerBalance)} VSC`);
            console.log(`   Required: ${ethers.formatEther(totalAmount)} VSC`);

            if (payerBalance < totalAmount) {
                displayError('Insufficient balance!');
                console.log('💡 Use Option 25 to mint tokens to payer');
                return;
            }

            console.log('💸 Funding escrow wallet...');
            const fundTx = await escrowFactory.connect(payer).fundEscrowWallet(selectedWallet.paymentId);
            await fundTx.wait();

            selectedWallet.state = 'Funded';
            if (!payerSet) {
                selectedWallet.payer = payerAddress;
                selectedWallet.payerName = payerAddress; // Update with actual address
            }

            displaySuccess('Escrow wallet funded successfully!');
            console.log(`   Payment ID: ${selectedWallet.paymentId}`);
            console.log(`   Payer: ${payerAddress}`);
            console.log(`   Amount: ${ethers.formatEther(totalAmount)} VSC`);

        } catch (error) {
            displayError(`Funding failed: ${error.message}`);
        }
    }

    /** Option 65: Payee: Submit Shipment Proof */
    async submitShipmentProof() {
        displaySection('PAYEE: SUBMIT SHIPMENT PROOF', '📦');

        if (!this.state.enhancedEscrowWallets || this.state.enhancedEscrowWallets.size === 0) {
            displayError('No escrow wallets. Please create and fund one first');
            return;
        }

        // List funded wallets
        const fundedWallets = Array.from(this.state.enhancedEscrowWallets.values()).filter(w => w.state === 'Funded');
        if (fundedWallets.length === 0) {
            displayError('No funded wallets. Please fund a wallet first (Option 64)');
            return;
        }

        console.log('\n📋 FUNDED WALLETS:');
        fundedWallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName} (${wallet.amount} VSC)`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = fundedWallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const payee = await this.getSignerForAddress(selectedWallet.payee);
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            // Create shipment proof
            const proofData = JSON.stringify({
                trackingNumber: `TRK${Date.now()}`,
                carrier: 'DHL Express',
                shipDate: new Date().toISOString(),
                estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                photos: ['photo1.jpg', 'photo2.jpg']
            });

            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));

            console.log('\n📝 Submitting shipment proof...');
            console.log(`   Tracking: TRK${Date.now()}`);
            console.log(`   Carrier: DHL Express`);

            const tx = await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);
            await tx.wait();

            selectedWallet.state = 'ProofSubmitted';

            displaySuccess('Shipment proof submitted successfully!');
            console.log('   14-day dispute window started');

        } catch (error) {
            displayError(`Proof submission failed: ${error.message}`);
        }
    }

    /** Option 66: Payer: Raise Dispute */
    async raiseDispute() {
        displaySection('PAYER: RAISE DISPUTE', '⚠️');

        const proofWallets = Array.from(this.state.enhancedEscrowWallets.values()).filter(w => w.state === 'ProofSubmitted');
        if (proofWallets.length === 0) {
            displayError('No wallets with submitted proof');
            return;
        }

        console.log('\n📋 WALLETS WITH PROOF:');
        proofWallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = proofWallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const payer = await this.getSignerForAddress(selectedWallet.payer);
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            console.log('\n⚠️ Raising dispute...');
            const tx = await wallet.connect(payer).raiseDispute();
            await tx.wait();

            selectedWallet.state = 'Disputed';

            displaySuccess('Dispute raised successfully!');
            console.log('   Investor will review and decide');

        } catch (error) {
            displayError(`Dispute failed: ${error.message}`);
        }
    }

    /** Option 67: Investor: Resolve Dispute */
    async resolveDispute() {
        displaySection('INVESTOR: RESOLVE DISPUTE', '⚖️');

        const disputedWallets = Array.from(this.state.enhancedEscrowWallets.values()).filter(w => w.state === 'Disputed');
        if (disputedWallets.length === 0) {
            displayError('No disputed wallets');
            return;
        }

        console.log('\n📋 DISPUTED WALLETS:');
        disputedWallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = disputedWallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        const decision = await this.promptUser('\nRefund to payer? (yes/no): ');
        const refund = decision.toLowerCase() === 'yes';

        try {
            const investor = await this.getSignerForAddress(selectedWallet.investor);
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            console.log(`\n⚖️ Resolving dispute (${refund ? 'REFUND' : 'RELEASE'})...`);
            const tx = await wallet.connect(investor).resolveDispute(refund);
            await tx.wait();

            selectedWallet.state = refund ? 'Refunded' : 'ProofSubmitted';

            displaySuccess('Dispute resolved!');
            console.log(`   Decision: ${refund ? 'Refund to payer' : 'Continue to release'}`);

        } catch (error) {
            displayError(`Resolution failed: ${error.message}`);
        }
    }

    /** Option 68: Payee: Sign Release */
    async payeeSignRelease() {
        displaySection('PAYEE: SIGN RELEASE', '✍️');

        const readyWallets = Array.from(this.state.enhancedEscrowWallets.values()).filter(w => w.state === 'ProofSubmitted');
        if (readyWallets.length === 0) {
            displayError('No wallets ready for signing');
            return;
        }

        console.log('\n📋 WALLETS READY FOR SIGNING:');
        readyWallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = readyWallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const payee = await this.getSignerForAddress(selectedWallet.payee);
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            console.log('\n✍️ Payee signing...');
            const tx = await wallet.connect(payee).signAsPayee();
            await tx.wait();

            displaySuccess('Payee signed successfully!');
            console.log('   Waiting for investor signature to release funds');

        } catch (error) {
            displayError(`Signing failed: ${error.message}`);
        }
    }

    /** Option 69: Investor: Sign Release */
    async investorSignRelease() {
        displaySection('INVESTOR: SIGN RELEASE/REFUND', '✍️');

        const readyWallets = Array.from(this.state.enhancedEscrowWallets.values()).filter(w =>
            (w.state === 'ProofSubmitted' || w.state === 'Funded') &&
            w.state !== 'Released' && w.state !== 'Refunded'
        );
        if (readyWallets.length === 0) {
            displayError('No wallets ready for investor signature');
            console.log('💡 All wallets are either not ready or already completed');
            return;
        }

        console.log('\n📋 WALLETS READY FOR INVESTOR SIGNATURE:');
        readyWallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = readyWallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const investor = await this.getSignerForAddress(selectedWallet.investor);
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            // ✅ DEBUG: Check trusted contracts before signing
            console.log('\n🔍 PRE-RELEASE COMPLIANCE CHECK:');
            const payee = await wallet.payee();
            const ownerWalletAddr = this.state.signers[1].address;
            const investorWallet = await wallet.investorWallet();

            const complianceRules = this.state.getContract('complianceRules');
            const identityRegistry = this.state.getContract('identityRegistry');

            const isWalletTrusted = await complianceRules.isTrustedContract(walletAddress);
            const isPayeeTrusted = await complianceRules.isTrustedContract(payee);
            const isOwnerTrusted = await complianceRules.isTrustedContract(ownerWalletAddr);
            const isInvestorWalletTrusted = await complianceRules.isTrustedContract(investorWallet);

            console.log(`   Escrow Wallet (${walletAddress.substring(0, 10)}...): ${isWalletTrusted ? '✅ TRUSTED' : '❌ NOT TRUSTED'}`);
            console.log(`   Payee (${payee.substring(0, 10)}...): ${isPayeeTrusted ? '✅ TRUSTED' : '❌ NOT TRUSTED'}`);
            console.log(`   Investor Fee Wallet (${investorWallet.substring(0, 10)}...): ${isInvestorWalletTrusted ? '✅ TRUSTED' : '❌ NOT TRUSTED'}`);
            console.log(`   Owner Wallet (${ownerWalletAddr.substring(0, 10)}...): ${isOwnerTrusted ? '✅ TRUSTED' : '❌ NOT TRUSTED'}`);

            const isPayeeVerified = await identityRegistry.isVerified(payee);
            console.log(`   Payee Verified: ${isPayeeVerified ? '✅ YES' : '❌ NO'}`);

            console.log('\n✍️ Investor signing...');
            const tx = await wallet.connect(investor).signAsInvestor();
            const receipt = await tx.wait();

            // Check if funds were released or refunded
            const releasedEvent = receipt.logs.find(log => {
                try {
                    const parsed = wallet.interface.parseLog(log);
                    return parsed && parsed.name === 'FundsReleased';
                } catch (e) {
                    return false;
                }
            });

            const refundedEvent = receipt.logs.find(log => {
                try {
                    const parsed = wallet.interface.parseLog(log);
                    return parsed && parsed.name === 'FundsRefunded';
                } catch (e) {
                    return false;
                }
            });

            if (releasedEvent) {
                selectedWallet.state = 'Released';
                displaySuccess('Funds released to payee!');
                console.log('   Payment completed successfully');
            } else if (refundedEvent) {
                selectedWallet.state = 'Refunded';
                displaySuccess('Funds refunded to payer!');
                console.log('   Refund completed successfully');
            } else {
                displaySuccess('Investor signed successfully!');
                console.log('   Waiting for payee/payer signature');
            }

        } catch (error) {
            displayError(`Signing failed: ${error.message}`);
        }
    }

    /** Option 70: Investor: Manual Refund */
    async manualRefund() {
        displaySection('INVESTOR: MANUAL REFUND', '🔄');

        const activeWallets = Array.from(this.state.enhancedEscrowWallets.values()).filter(w =>
            w.state === 'Funded' || w.state === 'ProofSubmitted'
        );
        if (activeWallets.length === 0) {
            displayError('No active wallets');
            return;
        }

        console.log('\n📋 ACTIVE WALLETS:');
        activeWallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = activeWallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        const confirm = await this.promptUser('\n⚠️ Confirm manual refund? (yes/no): ');
        if (confirm.toLowerCase() !== 'yes') {
            displayError('Refund cancelled');
            return;
        }

        try {
            const investor = await this.getSignerForAddress(selectedWallet.investor);
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.walletAddress || selectedWallet.address;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            console.log('\n🔄 Processing manual refund...');
            const tx = await wallet.connect(investor).manualRefund();
            await tx.wait();

            selectedWallet.state = 'Refunded';

            displaySuccess('Manual refund completed!');
            console.log('   Funds returned to payer');

        } catch (error) {
            displayError(`Refund failed: ${error.message}`);
        }
    }

    /**
     * Helper: Get state emoji
     */
    getStateEmoji(state) {
        const emojis = ['⏳', '✅', '💰', '⚠️'];
        return emojis[Number(state)] || '❓';
    }

    /** Option 71: View Escrow Wallet Status */
    async viewEscrowStatus() {
        displaySection('VIEW ESCROW WALLET STATUS - COMPREHENSIVE DETAILS', '📊');

        if (!this.state.enhancedEscrowWallets || this.state.enhancedEscrowWallets.size === 0) {
            displayError('No escrow wallets');
            return;
        }

        console.log('\n📋 ESCROW WALLETS:');
        const wallets = Array.from(this.state.enhancedEscrowWallets.values());
        wallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.state}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = wallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const walletAddress = selectedWallet.address || selectedWallet.walletAddress;
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            // ✅ CHECK: Is wallet in trusted contracts?
            console.log('\n🔍 TRUSTED CONTRACT CHECK:');
            const complianceRules = this.state.getContract('complianceRules');
            const isTrusted = await complianceRules.isTrustedContract(walletAddress);
            console.log(`   Escrow Wallet (${walletAddress}): ${isTrusted ? '✅ TRUSTED' : '❌ NOT TRUSTED'}`);

            // Check owner wallet too
            const ownerWalletAddress = this.state.signers[1].address;
            const isOwnerTrusted = await complianceRules.isTrustedContract(ownerWalletAddress);
            console.log(`   Owner Wallet (${ownerWalletAddress}): ${isOwnerTrusted ? '✅ TRUSTED' : '❌ NOT TRUSTED'}`);

            // Get all wallet data
            const status = await wallet.getWalletStatus();
            const payer = await wallet.payer();
            const payee = await wallet.payee();
            const investor = await wallet.investor();
            const amount = await wallet.amount();
            const token = await wallet.vscToken();
            const owner = await wallet.owner();
            const shipmentProof = await wallet.shipmentProof();

            // Get balances
            const ownerWallet = this.state.signers[1];
            const tokenContract = await ethers.getContractAt('Token', token);

            const payerBalance = payer !== ethers.ZeroAddress ? await tokenContract.balanceOf(payer) : 0n;
            const payeeBalance = await tokenContract.balanceOf(payee);
            const investorBalance = await tokenContract.balanceOf(investor);
            const ownerBalance = await tokenContract.balanceOf(ownerWallet.address);
            const walletBalance = await tokenContract.balanceOf(walletAddress);

            // Calculate fees
            const investorFee = amount * 3n / 100n;
            const ownerFee = amount * 2n / 100n;
            const totalFees = investorFee + ownerFee;
            const totalRequired = amount + totalFees;

            console.log('\n' + '='.repeat(80));
            console.log('📄 INVOICE & PAYMENT DETAILS');
            console.log('='.repeat(80));

            console.log('\n🆔 PAYMENT IDENTIFICATION:');
            console.log(`   Payment ID: #${selectedWallet.paymentId}`);
            console.log(`   Invoice Number: INV-${selectedWallet.paymentId.toString().padStart(6, '0')}`);
            console.log(`   Escrow Wallet: ${walletAddress}`);
            console.log(`   Creation Date: ${selectedWallet.createdAt || 'N/A'}`);
            console.log(`   Current State: ${['Active', 'Released', 'Refunded', 'Disputed'][Number(status.currentState)]} ${this.getStateEmoji(status.currentState)}`);

            console.log('\n' + '='.repeat(80));
            console.log('👥 PARTIES INFORMATION');
            console.log('='.repeat(80));

            console.log('\n💼 PAYER (Buyer):');
            if (payer === ethers.ZeroAddress) {
                console.log(`   Address: Unknown (Marketplace Mode)`);
                console.log(`   Status: ⏳ Waiting for first funder`);
                console.log(`   Name: N/A`);
            } else {
                console.log(`   Address: ${payer}`);
                console.log(`   Name: ${selectedWallet.payerName || 'N/A'}`);
                console.log(`   Status: ${status.payerIsSet ? '✅ Confirmed' : '⏳ Pending'}`);
                console.log(`   Current Balance: ${ethers.formatEther(payerBalance)} VSC`);
                console.log(`   Signature Status: ${status.payerHasSigned ? '✅ Signed' : '❌ Not Signed'}`);
            }

            console.log('\n📦 PAYEE (Seller):');
            console.log(`   Address: ${payee}`);
            console.log(`   Name: ${selectedWallet.payeeName || 'N/A'}`);
            console.log(`   Current Balance: ${ethers.formatEther(payeeBalance)} VSC`);
            console.log(`   Signature Status: ${status.payeeHasSigned ? '✅ Signed' : '❌ Not Signed'}`);
            console.log(`   Can Sign: ${status.readyForSignatures ? '✅ Yes (dispute window closed)' : '❌ No (dispute window open)'}`);

            console.log('\n🏦 INVESTOR (Escrow Manager):');
            console.log(`   Address: ${investor}`);
            console.log(`   Current Balance: ${ethers.formatEther(investorBalance)} VSC`);
            console.log(`   Signature Status: ${status.investorHasSigned ? '✅ Signed' : '❌ Not Signed'}`);
            console.log(`   Fee Earned: ${ethers.formatEther(investorFee)} VSC (3%)`);

            console.log('\n👑 OWNER (Platform):');
            console.log(`   Address: ${owner}`);
            console.log(`   Wallet Address: ${ownerWallet.address}`);
            console.log(`   Current Balance: ${ethers.formatEther(ownerBalance)} VSC`);
            console.log(`   Fee Earned: ${ethers.formatEther(ownerFee)} VSC (2%)`);

            console.log('\n' + '='.repeat(80));
            console.log('💰 FINANCIAL BREAKDOWN');
            console.log('='.repeat(80));

            console.log('\n📊 PAYMENT STRUCTURE:');
            console.log(`   Base Payment Amount: ${ethers.formatEther(amount)} VSC`);
            console.log(`   Investor Fee (3%): ${ethers.formatEther(investorFee)} VSC`);
            console.log(`   Owner Fee (2%): ${ethers.formatEther(ownerFee)} VSC`);
            console.log(`   Total Fees (5%): ${ethers.formatEther(totalFees)} VSC`);
            console.log(`   ─────────────────────────────────────`);
            console.log(`   TOTAL REQUIRED: ${ethers.formatEther(totalRequired)} VSC`);

            console.log('\n💳 ESCROW WALLET BALANCE:');
            console.log(`   Current Balance: ${ethers.formatEther(walletBalance)} VSC`);
            console.log(`   Funded: ${walletBalance >= totalRequired ? '✅ Yes' : '❌ No'}`);
            if (walletBalance < totalRequired) {
                console.log(`   Remaining: ${ethers.formatEther(totalRequired - walletBalance)} VSC`);
            }

            // Continue in next part due to 150-line limit...
            await this._viewEscrowStatusPart2(wallet, status, shipmentProof, amount, investorFee, ownerFee, selectedWallet, payer, payee, investor, token);

        } catch (error) {
            displayError(`Status check failed: ${error.message}`);
        }
    }

    /** Helper: View Escrow Status Part 2 (continuation) */
    async _viewEscrowStatusPart2(wallet, status, shipmentProof, amount, investorFee, ownerFee, selectedWallet, payer, payee, investor, token) {
        console.log('\n' + '='.repeat(80));
        console.log('📦 SHIPMENT PROOF & DISPUTE STATUS');
        console.log('='.repeat(80));

        console.log('\n📋 PROOF DETAILS:');
        console.log(`   Submitted: ${status.proofSubmitted ? '✅ Yes' : '❌ No'}`);
        if (status.proofSubmitted) {
            const proofDate = new Date(Number(shipmentProof.submittedAt) * 1000);
            const windowEnd = new Date((Number(shipmentProof.submittedAt) + 14 * 24 * 60 * 60) * 1000);

            console.log(`   Submission Date: ${proofDate.toISOString()}`);
            console.log(`   Data Hash: ${shipmentProof.dataHash}`);
            console.log(`   Signature: ${shipmentProof.signature.slice(0, 20)}...`);

            try {
                const proofData = JSON.parse(shipmentProof.data);
                console.log(`   Tracking Number: ${proofData.trackingNumber || 'N/A'}`);
                console.log(`   Carrier: ${proofData.carrier || 'N/A'}`);
            } catch (e) {
                console.log(`   Raw Data: ${shipmentProof.data.slice(0, 50)}...`);
            }

            console.log('\n⏰ DISPUTE WINDOW (14 Days):');
            console.log(`   Window Closes: ${windowEnd.toISOString()}`);
            console.log(`   Status: ${status.disputeWindowOpen ? '⚠️  OPEN' : '✅ CLOSED'}`);

            if (status.disputeWindowOpen) {
                const hoursLeft = Math.floor(Number(status.timeUntilSignatures) / 3600);
                const daysLeft = Math.floor(hoursLeft / 24);
                console.log(`   Time Remaining: ${daysLeft} days, ${hoursLeft % 24} hours`);
                console.log(`   Payer Can Dispute: ✅ Yes`);
                console.log(`   Payee Can Sign: ❌ No`);
            } else {
                console.log(`   Time Remaining: 0 (Closed)`);
                console.log(`   Payer Can Dispute: ❌ No`);
                console.log(`   Payee Can Sign: ✅ Yes`);
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('✍️  MULTI-SIGNATURE STATUS (2-of-3)');
        console.log('='.repeat(80));

        console.log('\n📝 SIGNATURE REQUIREMENTS:');
        console.log(`   Required Signatures: 2 of 3`);
        console.log(`   Investor MUST Sign: ✅ (Always Required)`);
        console.log(`   Plus ONE of: Payer OR Payee`);

        console.log('\n✅ CURRENT SIGNATURES:');
        console.log(`   ${status.payerHasSigned ? '✅' : '❌'} Payer (${payer === ethers.ZeroAddress ? 'Unknown' : payer.slice(0, 10)}...)`);
        console.log(`   ${status.payeeHasSigned ? '✅' : '❌'} Payee (${payee.slice(0, 10)}...)`);
        console.log(`   ${status.investorHasSigned ? '✅' : '❌'} Investor (${investor.slice(0, 10)}...)`);

        const sigCount = (status.payerHasSigned ? 1 : 0) + (status.payeeHasSigned ? 1 : 0) + (status.investorHasSigned ? 1 : 0);
        console.log(`\n   Total Signatures: ${sigCount} / 2`);

        console.log('\n🔀 RELEASE PATHS:');
        console.log(`   Investor + Payee → Release to Payee (Normal)`);
        console.log(`   Investor + Payer → Refund to Payer (Dispute/Refund)`);

        // Show detailed transaction information based on state and signatures
        const stateNames = ['Active', 'Released', 'Refunded', 'Disputed'];
        const currentStateName = stateNames[Number(status.currentState)] || 'Unknown';

        if (currentStateName === 'Released') {
            console.log(`\n   🎉 PAYMENT RELEASED TO PAYEE!`);
            console.log(`\n   💰 RELEASE TRANSACTION DETAILS:`);
            console.log(`   ✅ Investor + Payee signed → Normal release`);
            console.log(`   📤 Payee received: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC`);
            console.log(`   📤 Investor fee: ${parseFloat(ethers.formatEther(investorFee)).toLocaleString()} VSC`);
            console.log(`   📤 Owner fee: ${parseFloat(ethers.formatEther(ownerFee)).toLocaleString()} VSC`);
        } else if (currentStateName === 'Refunded') {
            console.log(`\n   💰 PAYMENT REFUNDED TO PAYER!`);
            console.log(`\n   💰 REFUND TRANSACTION DETAILS:`);
            if (status.investorHasSigned && status.payerHasSigned) {
                console.log(`   ✅ Investor + Payer signed → Refund approved`);
            } else if (status.investorHasSigned) {
                console.log(`   ✅ Investor initiated manual refund`);
            }
            const totalRefund = parseFloat(ethers.formatEther(amount)) +
                               parseFloat(ethers.formatEther(investorFee)) +
                               parseFloat(ethers.formatEther(ownerFee));
            console.log(`   📤 Payer received full refund: ${totalRefund.toLocaleString()} VSC`);
            console.log(`   💡 Includes: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC payment + ${parseFloat(ethers.formatEther(investorFee + ownerFee)).toLocaleString()} VSC fees`);
        } else if (status.investorHasSigned && status.payeeHasSigned) {
            console.log(`\n   🎉 READY TO RELEASE TO PAYEE!`);
            console.log(`   💡 Execute release to complete transaction`);
        } else if (status.investorHasSigned && status.payerHasSigned) {
            console.log(`\n   💰 READY TO REFUND TO PAYER!`);
            console.log(`   💡 Execute refund to complete transaction`);
        } else if (sigCount >= 1) {
            console.log(`\n   ⏳ Waiting for ${2 - sigCount} more signature(s)`);
        }

        console.log('\n' + '='.repeat(80));
        console.log('📊 TRANSACTION SUMMARY');
        console.log('='.repeat(80));

        const escrowFactory = this.state.getContract('escrowFactory');
        console.log('\n🔗 BLOCKCHAIN TRANSACTIONS:');
        console.log(`   Token Contract: ${token}`);
        console.log(`   Escrow Factory: ${await escrowFactory.getAddress()}`);

        console.log('\n📈 NEXT STEPS:');
        if (!status.proofSubmitted) {
            console.log(`   1. ⏳ Waiting for payee to submit shipment proof (Option 65)`);
        } else if (status.disputeWindowOpen) {
            console.log(`   1. ⏰ Dispute window open (${Math.floor(Number(status.timeUntilSignatures) / 86400)} days left)`);
            console.log(`   2. 🚨 Payer can raise dispute (Option 66)`);
            console.log(`   3. ⏰ Or wait for window to close (Option 73b)`);
        } else if (!status.payeeHasSigned && !status.investorHasSigned) {
            console.log(`   1. ✍️  Payee should sign release (Option 68)`);
            console.log(`   2. ✍️  Investor should sign release (Option 69)`);
            console.log(`   3. 🎉 Payment will auto-release!`);
        } else if (status.payeeHasSigned && !status.investorHasSigned) {
            console.log(`   1. ✍️  Investor should sign release (Option 69)`);
            console.log(`   2. 🎉 Payment will auto-release!`);
        } else if (status.investorHasSigned && !status.payeeHasSigned) {
            console.log(`   1. ✍️  Payee should sign release (Option 68)`);
            console.log(`   2. 🎉 Payment will auto-release!`);
        } else if (Number(status.currentState) === 1) {
            console.log(`   ✅ Payment completed and released to payee!`);
        } else if (Number(status.currentState) === 2) {
            console.log(`   ✅ Payment refunded to payer!`);
        }

        console.log('\n' + '='.repeat(80));
    }

    /** Option 71a: View All Parties Balances */
    async viewAllPartiesBalances() {
        displaySection('ESCROW WALLET - ALL PARTIES BALANCES', '💰');

        if (!this.state.enhancedEscrowWallets || this.state.enhancedEscrowWallets.size === 0) {
            displayError('No escrow wallets');
            return;
        }

        console.log('\n📋 ESCROW WALLETS:');
        const wallets = Array.from(this.state.enhancedEscrowWallets.values());
        wallets.forEach((wallet, index) => {
            console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.state}`);
        });

        const walletIndex = await this.promptUser('\nSelect wallet (number): ');
        const selectedWallet = wallets[parseInt(walletIndex)];

        if (!selectedWallet) {
            displayError('Invalid selection');
            return;
        }

        try {
            const MultiSigEscrowWallet = await ethers.getContractFactory('MultiSigEscrowWallet');
            const wallet = MultiSigEscrowWallet.attach(selectedWallet.address || selectedWallet.walletAddress);

            // Get all wallet data
            const statusResult = await wallet.getWalletStatus();
            const status = {
                state: statusResult[0],
                payerIsSet: statusResult[1],
                proofSubmitted: statusResult[2],
                disputeWindowOpen: statusResult[3],
                readyForSignatures: statusResult[4],
                payerSigned: statusResult[5],
                payeeSigned: statusResult[6],
                investorSigned: statusResult[7],
                timeUntilSignatures: statusResult[8]
            };

            const payer = await wallet.payer();
            const payee = await wallet.payee();
            const investor = await wallet.investor();
            const amount = await wallet.amount();
            const investorFee = await wallet.investorFee();
            const ownerFee = await wallet.ownerFee();
            const vscToken = await wallet.vscToken();
            const owner = await wallet.owner();
            const investorWallet = await wallet.investorWallet();
            const ownerWallet = await wallet.ownerWallet();
            const walletAddress = selectedWallet.address || selectedWallet.walletAddress;

            // Get token contract
            const Token = await ethers.getContractFactory('Token');
            const tokenContract = Token.attach(vscToken);

            console.log('\n' + '='.repeat(80));
            console.log('💰 ALL PARTIES BALANCES');
            console.log('='.repeat(80));

            // 1. ESCROW WALLET
            const escrowBalance = await tokenContract.balanceOf(walletAddress);
            const escrowBalanceVSC = parseFloat(ethers.formatEther(escrowBalance));

            console.log('\n🏦 ESCROW WALLET:');
            console.log(`   Address: ${walletAddress}`);
            console.log(`   Balance: ${escrowBalanceVSC.toLocaleString()} VSC`);
            console.log(`   State: ${['Active', 'Released', 'Refunded', 'Disputed'][Number(status.state)]}`);
            console.log(`   Payment Amount: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC`);
            console.log(`   Investor Fee (3%): ${parseFloat(ethers.formatEther(investorFee)).toLocaleString()} VSC`);
            console.log(`   Owner Fee (2%): ${parseFloat(ethers.formatEther(ownerFee)).toLocaleString()} VSC`);
            const totalAmount = parseFloat(ethers.formatEther(amount)) +
                               parseFloat(ethers.formatEther(investorFee)) +
                               parseFloat(ethers.formatEther(ownerFee));
            console.log(`   Total Required: ${totalAmount.toLocaleString()} VSC`);

            // 2. PAYER
            const payerBalance = await tokenContract.balanceOf(payer);
            const payerBalanceVSC = parseFloat(ethers.formatEther(payerBalance));
            const payerFreeBalance = await tokenContract.getFreeBalance(payer);
            const payerFreeBalanceVSC = parseFloat(ethers.formatEther(payerFreeBalance));
            const payerFrozen = await tokenContract.frozenTokens(payer);
            const payerFrozenVSC = parseFloat(ethers.formatEther(payerFrozen));

            console.log('\n👤 PAYER:');
            console.log(`   Address: ${payer}`);
            console.log(`   Total Balance: ${payerBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Free Balance: ${payerFreeBalanceVSC.toLocaleString()} VSC`);
            if (payerFrozenVSC > 0) {
                console.log(`   Frozen: ${payerFrozenVSC.toLocaleString()} VSC`);
            }
            console.log(`   Signed: ${status.payerSigned ? '✅ Yes' : '❌ No'}`);

            // 3. PAYEE
            const payeeBalance = await tokenContract.balanceOf(payee);
            const payeeBalanceVSC = parseFloat(ethers.formatEther(payeeBalance));
            const payeeFreeBalance = await tokenContract.getFreeBalance(payee);
            const payeeFreeBalanceVSC = parseFloat(ethers.formatEther(payeeFreeBalance));
            const payeeFrozen = await tokenContract.frozenTokens(payee);
            const payeeFrozenVSC = parseFloat(ethers.formatEther(payeeFrozen));

            console.log('\n👥 PAYEE:');
            console.log(`   Address: ${payee}`);
            console.log(`   Total Balance: ${payeeBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Free Balance: ${payeeFreeBalanceVSC.toLocaleString()} VSC`);
            if (payeeFrozenVSC > 0) {
                console.log(`   Frozen: ${payeeFrozenVSC.toLocaleString()} VSC`);
            }
            console.log(`   Signed: ${status.payeeSigned ? '✅ Yes' : '❌ No'}`);
            console.log(`   Will Receive: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC (if released)`);

            // 4. INVESTOR
            const investorBalance = await tokenContract.balanceOf(investor);
            const investorBalanceVSC = parseFloat(ethers.formatEther(investorBalance));
            const investorFreeBalance = await tokenContract.getFreeBalance(investor);
            const investorFreeBalanceVSC = parseFloat(ethers.formatEther(investorFreeBalance));
            const investorFrozen = await tokenContract.frozenTokens(investor);
            const investorFrozenVSC = parseFloat(ethers.formatEther(investorFrozen));

            console.log('\n💼 INVESTOR:');
            console.log(`   Address: ${investor}`);
            console.log(`   Total Balance: ${investorBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Free Balance: ${investorFreeBalanceVSC.toLocaleString()} VSC`);
            if (investorFrozenVSC > 0) {
                console.log(`   Frozen: ${investorFrozenVSC.toLocaleString()} VSC`);
            }
            console.log(`   Signed: ${status.investorSigned ? '✅ Yes' : '❌ No'}`);
            console.log(`   Fee Wallet: ${investorWallet}`);

            // Get investor fee wallet balance
            const investorFeeWalletBalance = await tokenContract.balanceOf(investorWallet);
            const investorFeeWalletVSC = parseFloat(ethers.formatEther(investorFeeWalletBalance));
            console.log(`   Fee Wallet Balance: ${investorFeeWalletVSC.toLocaleString()} VSC`);
            console.log(`   Will Receive: ${parseFloat(ethers.formatEther(investorFee)).toLocaleString()} VSC (if released)`);

            // 5. PLATFORM OWNER
            const ownerBalance = await tokenContract.balanceOf(owner);
            const ownerBalanceVSC = parseFloat(ethers.formatEther(ownerBalance));

            console.log('\n🏢 PLATFORM OWNER:');
            console.log(`   Address: ${owner}`);
            console.log(`   Total Balance: ${ownerBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Fee Wallet: ${ownerWallet}`);

            // Get owner fee wallet balance
            const ownerFeeWalletBalance = await tokenContract.balanceOf(ownerWallet);
            const ownerFeeWalletVSC = parseFloat(ethers.formatEther(ownerFeeWalletBalance));
            console.log(`   Fee Wallet Balance: ${ownerFeeWalletVSC.toLocaleString()} VSC`);
            console.log(`   Will Receive: ${parseFloat(ethers.formatEther(ownerFee)).toLocaleString()} VSC (if released)`);

            // SUMMARY
            console.log('\n' + '='.repeat(80));
            console.log('📊 SUMMARY');
            console.log('='.repeat(80));

            const totalInSystem = escrowBalanceVSC + payerBalanceVSC + payeeBalanceVSC +
                                 investorBalanceVSC + investorFeeWalletVSC + ownerBalanceVSC + ownerFeeWalletVSC;

            console.log(`\n💰 Total VSC in System: ${totalInSystem.toLocaleString()} VSC`);
            console.log(`   Escrow Wallet: ${escrowBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Payer: ${payerBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Payee: ${payeeBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Investor: ${investorBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Investor Fee Wallet: ${investorFeeWalletVSC.toLocaleString()} VSC`);
            console.log(`   Platform Owner: ${ownerBalanceVSC.toLocaleString()} VSC`);
            console.log(`   Owner Fee Wallet: ${ownerFeeWalletVSC.toLocaleString()} VSC`);

            console.log(`\n🔐 Multi-Sig Status:`);
            console.log(`   Payer Signed: ${status.payerSigned ? '✅' : '❌'}`);
            console.log(`   Payee Signed: ${status.payeeSigned ? '✅' : '❌'}`);
            console.log(`   Investor Signed: ${status.investorSigned ? '✅' : '❌'}`);
            console.log(`   Required: Investor + (Payer OR Payee)`);

        } catch (error) {
            displayError(`Balance check failed: ${error.message}`);
        }
    }

    /** Option 72: Enhanced Escrow Dashboard */
    async showDashboard() {
        displaySection('ENHANCED ESCROW DASHBOARD', '💳');

        const escrowFactory = this.state.getContract('escrowFactory');
        if (!escrowFactory) {
            displayError('Enhanced Escrow not deployed');
            return;
        }

        try {
            console.log('\n📊 SYSTEM OVERVIEW:');
            console.log(`Factory: ${await escrowFactory.getAddress()}`);
            console.log(`Total Wallets: ${this.state.enhancedEscrowWallets ? this.state.enhancedEscrowWallets.size : 0}`);
            console.log(`Registered Investors: ${this.state.registeredInvestors ? this.state.registeredInvestors.size : 0}`);
            console.log('');

            if (this.state.enhancedEscrowWallets && this.state.enhancedEscrowWallets.size > 0) {
                console.log('📋 WALLET SUMMARY:');
                const states = { Active: 0, Funded: 0, ProofSubmitted: 0, Disputed: 0, Released: 0, Refunded: 0 };

                for (const wallet of this.state.enhancedEscrowWallets.values()) {
                    states[wallet.state] = (states[wallet.state] || 0) + 1;
                }

                console.log(`   Active: ${states.Active || 0}`);
                console.log(`   Funded: ${states.Funded || 0}`);
                console.log(`   Proof Submitted: ${states.ProofSubmitted || 0}`);
                console.log(`   Disputed: ${states.Disputed || 0}`);
                console.log(`   Released: ${states.Released || 0}`);
                console.log(`   Refunded: ${states.Refunded || 0}`);
                console.log('');

                console.log('📜 RECENT WALLETS:');
                const wallets = Array.from(this.state.enhancedEscrowWallets.values()).slice(-5);
                wallets.forEach(wallet => {
                    console.log(`   Payment ${wallet.paymentId}: ${wallet.payerName || 'Unknown'} → ${wallet.payeeName} (${wallet.state})`);
                });
            }

        } catch (error) {
            displayError(`Dashboard failed: ${error.message}`);
        }
    }

    /** Option 73: Demo Complete Enhanced Escrow Workflow */
    async demoCompleteWorkflow() {
        displaySection('DEMO: COMPLETE ENHANCED ESCROW WORKFLOW', '🧪');
        console.log('This demo will showcase both normal and dispute scenarios');
        console.log('');

        displayWarning('This is a placeholder for the complete workflow demo');
        console.log('💡 Use individual options (62-71) to test the escrow system manually');
        console.log('');
        console.log('📋 RECOMMENDED WORKFLOW:');
        console.log('   1. Option 62: Register Investor');
        console.log('   2. Option 63: Create Escrow Wallet');
        console.log('   3. Option 64: Fund Escrow Wallet');
        console.log('   4. Option 65: Submit Shipment Proof');
        console.log('   5. Option 73b: Time Travel 14 Days (close dispute window)');
        console.log('   6. Option 68: Payee Sign Release');
        console.log('   7. Option 69: Investor Sign Release');
        console.log('   8. Option 71: View Status (verify release)');
    }

    /** Option 73a: Time Travel (13 Days) */
    async timeTravel13Days() {
        displaySection('TIME TRAVEL - FAST FORWARD 13 DAYS (TEST DISPUTE WINDOW)', '⏰');

        try {
            console.log('\n📅 Current blockchain time will be advanced by 13 days');
            console.log('   • Dispute window is 14 days');
            console.log('   • After 13 days: Dispute window STILL OPEN ⚠️');
            console.log('   • Payer can still raise disputes');
            console.log('   • Payee CANNOT sign yet');
            console.log('');
            console.log('⚠️  This only works on local blockchain (Hardhat/Ganache)');
            console.log('');

            const confirm = await this.promptUser('Proceed with time travel? (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                displayError('Time travel cancelled');
                return;
            }

            console.log('\n⏰ Advancing time by 13 days...');
            await ethers.provider.send('evm_increaseTime', [13 * 24 * 60 * 60]);
            await ethers.provider.send('evm_mine', []);

            const latestBlock = await ethers.provider.getBlock('latest');
            const currentTime = new Date(latestBlock.timestamp * 1000);

            displaySuccess('Time advanced successfully!');
            console.log(`   Current blockchain time: ${currentTime.toISOString()}`);
            console.log('');
            console.log('📊 DISPUTE WINDOW STATUS:');
            console.log('   ⚠️  STILL OPEN (1 day remaining)');
            console.log('   ✅ Payer CAN raise disputes (Option 66)');
            console.log('   ❌ Payee CANNOT sign yet (Option 68)');
            console.log('');
            console.log('💡 Use Option 73b to advance 1 more day to close dispute window');

        } catch (error) {
            displayError(`Time travel failed: ${error.message}`);
            console.log('💡 Make sure you are running on a local blockchain (Hardhat/Ganache)');
        }
    }

    /** Option 73b: Time Travel (14 Days) */
    async timeTravel14Days() {
        displaySection('TIME TRAVEL - FAST FORWARD 14 DAYS (TEST AUTO SETTLEMENT)', '⏰');

        try {
            console.log('\n📅 Current blockchain time will be advanced by 14 days + 1 hour');
            console.log('   • Dispute window is 14 days');
            console.log('   • After 14 days: Dispute window CLOSED ✅');
            console.log('   • Payer CANNOT raise disputes anymore');
            console.log('   • Payee CAN sign for release');
            console.log('');
            console.log('⚠️  This only works on local blockchain (Hardhat/Ganache)');
            console.log('');

            const confirm = await this.promptUser('Proceed with time travel? (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                displayError('Time travel cancelled');
                return;
            }

            console.log('\n⏰ Advancing time by 14 days + 1 hour...');
            await ethers.provider.send('evm_increaseTime', [14 * 24 * 60 * 60 + 3600]);
            await ethers.provider.send('evm_mine', []);

            const latestBlock = await ethers.provider.getBlock('latest');
            const currentTime = new Date(latestBlock.timestamp * 1000);

            displaySuccess('Time advanced successfully!');
            console.log(`   Current blockchain time: ${currentTime.toISOString()}`);
            console.log('');
            console.log('📊 DISPUTE WINDOW STATUS:');
            console.log('   ✅ CLOSED (14 days passed)');
            console.log('   ❌ Payer CANNOT raise disputes (Option 66)');
            console.log('   ✅ Payee CAN sign for release (Option 68)');
            console.log('');
            console.log('💡 Next steps:');
            console.log('   1. Payee signs release (Option 68)');
            console.log('   2. Investor signs release (Option 69)');
            console.log('   3. Payment automatically released to payee! 🎉');

        } catch (error) {
            displayError(`Time travel failed: ${error.message}`);
            console.log('💡 Make sure you are running on a local blockchain (Hardhat/Ganache)');
        }
    }
}

module.exports = EscrowModule;

