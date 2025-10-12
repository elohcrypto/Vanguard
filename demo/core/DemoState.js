/**
 * @fileoverview Centralized state management for the Interactive KYC/AML Demo
 * @module DemoState
 * @description Manages all shared state across demo modules including contracts,
 * signers, identities, claims, tokens, oracles, privacy settings, and more.
 * 
 * @example
 * const DemoState = require('./core/DemoState');
 * const state = new DemoState();
 * state.setContract('token', tokenContract);
 * const token = state.getContract('token');
 */

/**
 * @class DemoState
 * @description Central state management class that holds all demo state variables.
 * Provides getters and setters for safe state access across modules.
 */
class DemoState {
    constructor() {
        // ========== CORE SYSTEM STATE ==========
        
        /**
         * @property {Object} contracts - Deployed contract instances
         * @type {Object.<string, any>}
         */
        this.contracts = {};
        
        /**
         * @property {Array} signers - Ethereum signers from Hardhat
         * @type {Array<any>}
         */
        this.signers = [];
        
        /**
         * @property {Map} identities - User identities (address => OnchainID)
         * @type {Map<string, any>}
         */
        this.identities = new Map();
        
        /**
         * @property {Map} claims - User claims (address => claims array)
         * @type {Map<string, Array>}
         */
        this.claims = new Map();

        // ========== TOKEN ECOSYSTEM ==========

        /**
         * @property {Map} investors - Investor profiles
         * @type {Map<string, Object>}
         */
        this.investors = new Map();

        /**
         * @property {Map} normalUsers - Normal user profiles (from Option 24)
         * @type {Map<string, Object>}
         */
        this.normalUsers = new Map();

        /**
         * @property {Object|null} tokenSystem - ERC-3643 token system reference
         * @type {Object|null}
         */
        this.tokenSystem = null;
        
        /**
         * @property {Map} tokenBalances - Token balances (address => balance)
         * @type {Map<string, number>}
         */
        this.tokenBalances = new Map();
        
        /**
         * @property {Array} transferHistory - Transfer transaction history
         * @type {Array<Object>}
         */
        this.transferHistory = [];

        // ========== DIGITAL TOKEN SYSTEM ==========
        
        /**
         * @property {Object|null} digitalToken - Digital token contract
         * @type {Object|null}
         */
        this.digitalToken = null;
        
        /**
         * @property {Map} bankingInstitutions - Banking institution profiles
         * @type {Map<string, Object>}
         */
        this.bankingInstitutions = new Map();
        
        /**
         * @property {number} lockedTokens - Total locked tokens
         * @type {number}
         */
        this.lockedTokens = 1000000;
        
        /**
         * @property {number} maxTransferAmount - Maximum transfer amount
         * @type {number}
         */
        this.maxTransferAmount = 8000;

        // ========== COMPLIANCE RULES SYSTEM ==========
        
        /**
         * @property {Object|null} complianceRules - ComplianceRules contract
         * @type {Object|null}
         */
        this.complianceRules = null;
        
        /**
         * @property {Map} complianceRulesConfig - Compliance configuration
         * @type {Map<string, any>}
         */
        this.complianceRulesConfig = new Map();
        
        /**
         * @property {Map} testTokens - Test token instances
         * @type {Map<string, Object>}
         */
        this.testTokens = new Map();

        // ========== ORACLE MANAGEMENT SYSTEM ==========
        
        /**
         * @property {Object|null} oracleManager - OracleManager contract
         * @type {Object|null}
         */
        this.oracleManager = null;
        
        /**
         * @property {Object|null} whitelistOracle - WhitelistOracle contract
         * @type {Object|null}
         */
        this.whitelistOracle = null;
        
        /**
         * @property {Object|null} blacklistOracle - BlacklistOracle contract
         * @type {Object|null}
         */
        this.blacklistOracle = null;
        
        /**
         * @property {Object|null} consensusOracle - ConsensusOracle contract
         * @type {Object|null}
         */
        this.consensusOracle = null;
        
        /**
         * @property {Map} oracleConfig - Oracle configuration settings
         * @type {Map<string, any>}
         */
        this.oracleConfig = new Map();

        // ========== PRIVACY & ZK VERIFICATION SYSTEM ==========
        
        /**
         * @property {Object|null} zkVerifier - ZKVerifier contract
         * @type {Object|null}
         */
        this.zkVerifier = null;
        
        /**
         * @property {Object|null} zkVerifierIntegrated - Integrated ZK verifier
         * @type {Object|null}
         */
        this.zkVerifierIntegrated = null;
        
        /**
         * @property {Object|null} privacyManager - PrivacyManager contract
         * @type {Object|null}
         */
        this.privacyManager = null;
        
        /**
         * @property {Object|null} complianceProofValidator - Compliance proof validator
         * @type {Object|null}
         */
        this.complianceProofValidator = null;
        
        /**
         * @property {Object|null} accreditationProofValidator - Accreditation proof validator
         * @type {Object|null}
         */
        this.accreditationProofValidator = null;
        
        /**
         * @property {Map} privacyConfig - Privacy configuration settings
         * @type {Map<string, any>}
         */
        this.privacyConfig = new Map();
        
        /**
         * @property {Map} userPrivacyProofs - User privacy proofs
         * @type {Map<string, Object>}
         */
        this.userPrivacyProofs = new Map();

        // ========== ZK MODE CONFIGURATION ==========
        
        /**
         * @property {string} zkMode - ZK proof mode ('mock' or 'real')
         * @type {string}
         */
        this.zkMode = 'mock';
        
        /**
         * @property {Object|null} realProofGenerator - Real proof generator instance
         * @type {Object|null}
         */
        this.realProofGenerator = null;
        
        /**
         * @property {Map} gasTracker - Gas cost tracking for proof verifications
         * @type {Map<string, number>}
         */
        this.gasTracker = new Map();
        
        /**
         * @property {Map} proofGenerationTimes - Proof generation time tracking
         * @type {Map<string, number>}
         */
        this.proofGenerationTimes = new Map();

        // ========== PAYMENT PROTOCOL SYSTEM (OLD) ==========
        
        /**
         * @property {Object|null} paymentProtocol - Payment protocol contract
         * @type {Object|null}
         */
        this.paymentProtocol = null;
        
        /**
         * @property {Object|null} paymentEscrow - Payment escrow contract
         * @type {Object|null}
         */
        this.paymentEscrow = null;
        
        /**
         * @property {number} lastPaymentId - Last payment ID
         * @type {number}
         */
        this.lastPaymentId = 0;
        
        /**
         * @property {Object|null} refundManager - Refund manager contract
         * @type {Object|null}
         */
        this.refundManager = null;
        
        /**
         * @property {Map} paymentHistory - Payment transaction history
         * @type {Map<number, Object>}
         */
        this.paymentHistory = new Map();
        
        /**
         * @property {number} paymentCounter - Payment counter
         * @type {number}
         */
        this.paymentCounter = 0;

        // ========== ENHANCED ESCROW SYSTEM (NEW) ==========
        
        /**
         * @property {Object|null} escrowFactory - Escrow wallet factory contract
         * @type {Object|null}
         */
        this.escrowFactory = null;
        
        /**
         * @property {Map} enhancedEscrowWallets - Enhanced escrow wallets (paymentId => address)
         * @type {Map<number, string>}
         */
        this.enhancedEscrowWallets = new Map();
        
        /**
         * @property {number} enhancedPaymentCounter - Enhanced payment counter
         * @type {number}
         */
        this.enhancedPaymentCounter = 0;
        
        /**
         * @property {Map} registeredInvestors - Registered investor profiles
         * @type {Map<string, Object>}
         */
        this.registeredInvestors = new Map();

        // ========== SIGNER ALLOCATION TRACKING ==========
        
        /**
         * @property {Set} reservedSigners - Reserved signer indices (0-3)
         * @description signers[0] = Platform owner, signers[1] = Fee wallet,
         * signers[2] = KYC issuer, signers[3] = AML issuer
         * @type {Set<number>}
         */
        this.reservedSigners = new Set([0, 1, 2, 3]);
        
        /**
         * @property {Map} allocatedSigners - Allocated signers (index => {type, name})
         * @type {Map<number, Object>}
         */
        this.allocatedSigners = new Map();
        
        /**
         * @property {number} nextAvailableSignerIndex - Next available signer index
         * @type {number}
         */
        this.nextAvailableSignerIndex = 4;
    }

    // ========== CONTRACT MANAGEMENT ==========
    
    /**
     * Get a contract by name
     * @param {string} name - Contract name
     * @returns {Object|undefined} Contract instance or undefined
     */
    getContract(name) {
        return this.contracts[name];
    }
    
    /**
     * Set a contract
     * @param {string} name - Contract name
     * @param {Object} contract - Contract instance
     */
    setContract(name, contract) {
        this.contracts[name] = contract;
    }
    
    /**
     * Check if a contract exists
     * @param {string} name - Contract name
     * @returns {boolean} True if contract exists
     */
    hasContract(name) {
        return this.contracts[name] !== undefined;
    }
}

module.exports = DemoState;

