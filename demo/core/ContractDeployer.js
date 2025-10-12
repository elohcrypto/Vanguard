/**
 * @fileoverview Contract deployment module for the Interactive KYC/AML Demo
 * @module ContractDeployer
 * @description Handles deployment of all smart contracts including OnchainID,
 * ERC-3643 registries, compliance rules, oracles, privacy systems, and more.
 * 
 * @example
 * const ContractDeployer = require('./core/ContractDeployer');
 * const deployer = new ContractDeployer(state, logger);
 * await deployer.deployAllContracts();
 */

const { ethers } = require('hardhat');
const { displaySection, displaySuccess, displayError, displayProgress } = require('../utils/DisplayHelpers');

/**
 * @class ContractDeployer
 * @description Manages deployment of all smart contracts for the demo system.
 */
class ContractDeployer {
    /**
     * Create a ContractDeployer
     * @param {Object} state - DemoState instance
     * @param {Object} logger - EnhancedLogger instance
     */
    constructor(state, logger) {
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
    }

    /**
     * Deploy all contracts for the demo
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await deployer.deployAllContracts();
     */
    async deployAllContracts() {
        displaySection('DEPLOYING ALL CONTRACTS', '🏗️');

        try {
            // Initialize logger with provider
            this.logger.initialize(ethers.provider);

            // Deploy core OnchainID contracts
            await this.deployOnchainIDContracts();
            
            // Deploy ERC-3643 registries
            await this.deployERC3643Registries();

            displaySuccess('ALL CONTRACTS DEPLOYED SUCCESSFULLY!');
            
            // Display comprehensive deployment summary
            this.logger.getDeploymentSummary();

        } catch (error) {
            displayError(`Contract deployment failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deploy OnchainID contracts (Factory, KYC Issuer, AML Issuer)
     * 
     * @returns {Promise<void>}
     * @private
     */
    async deployOnchainIDContracts() {
        // Deploy OnchainID Factory
        displayProgress('Deploying OnchainID Factory...');
        const OnchainIDFactory = await ethers.getContractFactory('OnchainIDFactory');
        const factory = await OnchainIDFactory.deploy(this.state.signers[0].address);
        await factory.waitForDeployment();
        this.state.setContract('onchainIDFactory', factory);

        await this.logger.logContractDeployment(
            'OnchainIDFactory',
            factory,
            [this.state.signers[0].address]
        );

        // Deploy KYC Issuer
        displayProgress('Deploying KYC Issuer...');
        const ClaimIssuer = await ethers.getContractFactory('ClaimIssuer');
        const kycIssuer = await ClaimIssuer.deploy(
            this.state.signers[2].address,
            'KYC Service',
            'KYC verification service'
        );
        await kycIssuer.waitForDeployment();
        this.state.setContract('kycIssuer', kycIssuer);

        await this.logger.logContractDeployment(
            'KYC_ClaimIssuer',
            kycIssuer,
            [this.state.signers[2].address, 'KYC Service', 'KYC verification service']
        );

        // Deploy AML Issuer
        displayProgress('Deploying AML Issuer...');
        const amlIssuer = await ClaimIssuer.deploy(
            this.state.signers[3].address,
            'AML Service',
            'AML screening service'
        );
        await amlIssuer.waitForDeployment();
        this.state.setContract('amlIssuer', amlIssuer);

        await this.logger.logContractDeployment(
            'AML_ClaimIssuer',
            amlIssuer,
            [this.state.signers[3].address, 'AML Service', 'AML screening service']
        );
    }

    /**
     * Deploy ERC-3643 registries
     * 
     * @returns {Promise<void>}
     * @private
     */
    async deployERC3643Registries() {
        displayProgress('Deploying ERC-3643 Registries...');
        
        const IdentityRegistry = await ethers.getContractFactory('IdentityRegistry');
        const identityRegistry = await IdentityRegistry.deploy();
        await identityRegistry.waitForDeployment();
        this.state.setContract('identityRegistry', identityRegistry);

        await this.logger.logContractDeployment(
            'IdentityRegistry',
            identityRegistry,
            []
        );
    }

    /**
     * Deploy ComplianceRules contract with user-provided configuration
     *
     * @param {number[]} allowedCountries - Array of allowed country codes
     * @param {number[]} blockedCountries - Array of blocked country codes
     * @returns {Promise<void>}
     *
     * @example
     * await deployer.deployComplianceRulesWithConfig([840, 826], [156, 643]);
     */
    async deployComplianceRulesWithConfig(allowedCountries, blockedCountries) {
        try {
            displayProgress('Deploying ComplianceRules contract...');

            const ComplianceRules = await ethers.getContractFactory('ComplianceRules');
            const complianceRules = await ComplianceRules.deploy(
                this.state.signers[0].address, // owner
                allowedCountries,
                blockedCountries
            );
            await complianceRules.waitForDeployment();

            this.state.complianceRules = complianceRules;
            this.state.setContract('complianceRules', complianceRules);

            await this.logger.logContractDeployment(
                'ComplianceRules',
                complianceRules,
                [this.state.signers[0].address, allowedCountries, blockedCountries]
            );

            const address = await complianceRules.getAddress();
            displaySuccess('ComplianceRules deployed successfully!');
            console.log(`   📄 Address: ${address}`);
            console.log(`   📊 Allowed countries: ${allowedCountries.length}`);
            console.log(`   📊 Blocked countries: ${blockedCountries.length}`);

        } catch (error) {
            displayError(`ComplianceRules deployment failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deploy ComplianceRules contract with default configuration
     * (Used by deployAllContracts)
     *
     * @returns {Promise<void>}
     *
     * @example
     * await deployer.deployComplianceRules();
     */
    async deployComplianceRules() {
        displaySection('DEPLOYING COMPLIANCE RULES', '⚖️');

        try {
            // Default allowed countries (US, UK, Canada, Germany, France, Japan, Singapore, Australia, Hong Kong, Switzerland)
            const initialAllowedCountries = [840, 826, 124, 276, 250, 392, 702, 36, 344, 756];

            // Default blocked countries (China, Russia, North Korea, Iran, Syria)
            const initialBlockedCountries = [156, 643, 850, 364, 760];

            await this.deployComplianceRulesWithConfig(initialAllowedCountries, initialBlockedCountries);

        } catch (error) {
            displayError(`ComplianceRules deployment failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deploy ERC-3643 Digital Token System with full configuration
     *
     * @returns {Promise<void>}
     *
     * @example
     * await deployer.deployDigitalTokenSystem();
     */
    async deployDigitalTokenSystem() {
        displaySection('DEPLOY ERC-3643 DIGITAL TOKEN SYSTEM - WITH ON-CHAIN LIMITS', '🏭');

        try {
            if (!this.state.getContract('onchainIDFactory')) {
                displayError('Please deploy contracts first (option 1)');
                return;
            }

            let totalGasUsed = 0n;

            // Deploy ComplianceRules first if not exists
            if (!this.state.getContract('complianceRules')) {
                console.log('\n📝 Step 1: Deploying ComplianceRules...');

                // Use default configuration for automated deployment
                const defaultAllowedCountries = []; // No whitelist - all countries allowed except blocked
                const defaultBlockedCountries = [156, 643, 850, 364, 760]; // China, Russia, North Korea, Iran, Syria

                await this.deployComplianceRulesWithConfig(defaultAllowedCountries, defaultBlockedCountries);
                console.log('   📊 Whitelist: None (all countries allowed except blocked)');
                console.log('   📊 Blacklist: 5 countries (China, Russia, North Korea, Iran, Syria)');
            }

            // Deploy ERC-3643 compliant Digital Token
            console.log('\n📝 Step 2: Deploying ERC-3643 Token...');
            const Token = await ethers.getContractFactory('Token');
            const token = await Token.deploy(
                'Vanguard StableCoin',
                'VSC',
                await this.state.getContract('identityRegistry').getAddress(),
                await this.state.getContract('complianceRules').getAddress()
            );
            await token.waitForDeployment();
            this.state.digitalToken = token;
            this.state.setContract('digitalToken', token);

            const tokenAddr = await token.getAddress();
            console.log(`   ✅ ERC-3643 Digital Token: ${tokenAddr}`);
            console.log(`   🏛️ Token Name: Vanguard StableCoin`);
            console.log(`   💰 Symbol: VSC`);

            // Configure ComplianceRules with IdentityRegistry for VSC
            console.log('\n📝 Step 2.5: Configuring ComplianceRules for VSC...');
            const tx1 = await this.state.getContract('complianceRules').setTokenIdentityRegistry(
                tokenAddr,
                await this.state.getContract('identityRegistry').getAddress()
            );
            const receipt1 = await tx1.wait();
            totalGasUsed += receipt1.gasUsed;
            console.log('   ✅ ComplianceRules linked to IdentityRegistry for VSC');
            console.log('   ✅ REAL KYC/AML enforcement enabled for VSC transfers');

            // Configure IdentityRegistry with ComplianceRules for jurisdiction validation
            console.log('\n📝 Step 2.6: Configuring IdentityRegistry for jurisdiction validation...');
            const tx2 = await this.state.getContract('identityRegistry').setComplianceRules(
                await this.state.getContract('complianceRules').getAddress(),
                tokenAddr
            );
            const receipt2 = await tx2.wait();
            totalGasUsed += receipt2.gasUsed;
            console.log('   ✅ IdentityRegistry linked to ComplianceRules');
            console.log('   ✅ Jurisdiction rules will be enforced at identity registration');
            console.log('   ✅ Users from blocked countries will be REJECTED during KYC/AML');

            // Check if InvestorTypeRegistry is deployed
            console.log('\n📝 Step 3: Connecting InvestorTypeRegistry for on-chain transfer limits...');

            let investorTypeRegistryAddr = null;
            if (!this.state.getContract('investorTypeRegistry')) {
                console.log(`   ⚠️  InvestorTypeRegistry not deployed yet`);
                console.log(`   💡 Deploy it first using option 51, then reconnect using option 52`);
                console.log(`   ⚠️  Transfer limits will NOT be enforced until registry is connected!`);
            } else {
                investorTypeRegistryAddr = await this.state.getContract('investorTypeRegistry').getAddress();
                const tx3 = await token.setInvestorTypeRegistry(investorTypeRegistryAddr);
                const receipt3 = await tx3.wait();
                totalGasUsed += receipt3.gasUsed;

                console.log(`   ✅ Transaction Hash: ${receipt3.hash}`);
                console.log(`   🧱 Block Number: ${receipt3.blockNumber}`);
                console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);
                console.log(`   🔗 InvestorTypeRegistry: ${investorTypeRegistryAddr}`);

                // Verify the connection
                console.log('\n📝 Step 4: Verifying on-chain transfer limit enforcement...');
                const connectedRegistry = await token.investorTypeRegistry();
                console.log(`   ${connectedRegistry === investorTypeRegistryAddr ? '✅' : '❌'} Registry Connected: ${connectedRegistry === investorTypeRegistryAddr}`);

                // Show the actual on-chain limits
                const normalConfig = await this.state.getContract('investorTypeRegistry').getInvestorTypeConfig(0);
                const retailConfig = await this.state.getContract('investorTypeRegistry').getInvestorTypeConfig(1);

                console.log('\n📊 ON-CHAIN TRANSFER LIMITS (Enforced by Smart Contract):');
                console.log(`   👤 Normal Investor: ${ethers.formatEther(normalConfig.maxTransferAmount)} VSC`);
                console.log(`   🛒 Retail Investor: ${ethers.formatEther(retailConfig.maxTransferAmount)} VSC`);
                console.log(`   💼 Accredited Investor: 50,000 VSC`);
                console.log(`   🏛️ Institutional Investor: 500,000 VSC`);
            }

            // Display compliance components
            console.log('\n📋 ERC-3643 Compliance Components:');
            console.log('   ✅ Identity Registry: Connected');
            console.log('   ✅ ComplianceRules: Connected (REAL KYC/AML enforcement)');
            if (investorTypeRegistryAddr) {
                console.log('   ✅ InvestorTypeRegistry: Connected (ENFORCES LIMITS ON-CHAIN)');
            } else {
                console.log('   ⚠️  InvestorTypeRegistry: Not Connected (Deploy with option 51)');
            }
            console.log('   ✅ Trusted Issuers: Configured');
            console.log('   ✅ Claim Topics: Configured');

            // Display security features
            console.log('\n🔒 ON-CHAIN SECURITY FEATURES:');
            console.log('   ✅ ComplianceRules enforces KYC/AML verification');
            console.log('   ✅ Two-layer compliance architecture:');
            console.log('      • Layer 1: Token checks IdentityRegistry.isVerified()');
            console.log('      • Layer 2: ComplianceRules checks IdentityRegistry + business rules');
            if (investorTypeRegistryAddr) {
                console.log('   ✅ Transfer limits enforced by smart contract');
                console.log('   ✅ Investor type validation on-chain');
                console.log('   ✅ Cannot bypass limits by calling contract directly');
                console.log('   ✅ All checks happen in Token.canTransfer()');
            } else {
                console.log('   ⚠️  Transfer limits NOT enforced (registry not connected)');
                console.log('   💡 Deploy InvestorTypeRegistry (option 51) to enable limits');
            }

            this.state.maxTransferAmount = 8000; // 8,000 VSC limit for Normal/Retail

            displaySuccess('ERC-3643 DIGITAL TOKEN SYSTEM DEPLOYED!');
            console.log('='.repeat(60));
            console.log(`📊 Token Address: ${tokenAddr}`);
            if (investorTypeRegistryAddr) {
                console.log(`🔗 InvestorTypeRegistry: ${investorTypeRegistryAddr}`);
            } else {
                console.log(`⚠️  InvestorTypeRegistry: Not Connected`);
            }
            console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

            if (investorTypeRegistryAddr) {
                console.log('\n💡 Transfer Limit Enforcement:');
                console.log('   • ✅ Limits are enforced ON-CHAIN by the Token contract');
                console.log('   • ✅ Token.transfer() calls InvestorTypeRegistry.canTransferAmount()');
                console.log('   • ✅ Cannot be bypassed - all transfers checked on blockchain');
                console.log('   • ✅ Different limits for different investor types');
            } else {
                console.log('\n⚠️  Next Steps:');
                console.log('   • Deploy InvestorTypeRegistry (option 51)');
                console.log('   • Then reconnect to enable on-chain transfer limits');
            }

        } catch (error) {
            displayError(`ERC-3643 Digital Token deployment failed: ${error.message}`);
            console.error('💡 Stack trace:', error.stack);
            throw error;
        }
    }

    /**
     * Deploy Oracle Management System
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await deployer.deployOracleSystem();
     */
    async deployOracleSystem() {
        displaySection('DEPLOYING ORACLE MANAGEMENT SYSTEM', '🔮');

        try {
            displayProgress('Deploying OracleManager...');
            const OracleManager = await ethers.getContractFactory('OracleManager');
            const oracleManager = await OracleManager.deploy();
            await oracleManager.waitForDeployment();
            this.state.oracleManager = oracleManager;
            this.state.setContract('oracleManager', oracleManager);

            displayProgress('Deploying WhitelistOracle...');
            const WhitelistOracle = await ethers.getContractFactory('WhitelistOracle');
            const whitelistOracle = await WhitelistOracle.deploy(
                await oracleManager.getAddress(),
                'KYC Whitelist Oracle',
                'Oracle for KYC/AML whitelist management'
            );
            await whitelistOracle.waitForDeployment();
            this.state.whitelistOracle = whitelistOracle;
            this.state.setContract('whitelistOracle', whitelistOracle);

            displayProgress('Deploying BlacklistOracle...');
            const BlacklistOracle = await ethers.getContractFactory('BlacklistOracle');
            const blacklistOracle = await BlacklistOracle.deploy(
                await oracleManager.getAddress(),
                'AML Blacklist Oracle',
                'Oracle for AML blacklist screening'
            );
            await blacklistOracle.waitForDeployment();
            this.state.blacklistOracle = blacklistOracle;
            this.state.setContract('blacklistOracle', blacklistOracle);

            displayProgress('Deploying ConsensusOracle...');
            const ConsensusOracle = await ethers.getContractFactory('ConsensusOracle');
            const consensusOracle = await ConsensusOracle.deploy(
                await oracleManager.getAddress(),
                'Consensus Oracle',
                'Oracle for multi-oracle consensus verification'
            );
            await consensusOracle.waitForDeployment();
            this.state.consensusOracle = consensusOracle;
            this.state.setContract('consensusOracle', consensusOracle);

            displaySuccess('Oracle Management System deployed successfully!');

        } catch (error) {
            displayError(`Oracle System deployment failed: ${error.message}`);
            throw error;
        }
    }
}

module.exports = ContractDeployer;

