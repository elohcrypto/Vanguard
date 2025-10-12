/**
 * @fileoverview Zero-knowledge proof generation utilities
 * @module ProofGenerator
 * @description Provides utilities for generating mock and real ZK proofs
 * for privacy-preserving compliance validation.
 * 
 * @example
 * const ProofGenerator = require('./utils/ProofGenerator');
 * const generator = new ProofGenerator(state);
 * const proof = generator.generateMockWhitelistProof(userAddress);
 */

const { ethers } = require('hardhat');

/**
 * @class ProofGenerator
 * @description Generates zero-knowledge proofs for privacy-preserving compliance.
 * Supports both mock proofs (for fast demonstration) and real proofs (for production).
 */
class ProofGenerator {
    /**
     * Create a ProofGenerator
     * @param {Object} state - DemoState instance
     */
    constructor(state) {
        /**
         * @property {Object} state - Reference to DemoState
         * @private
         */
        this.state = state;
    }

    /**
     * Check if currently in real ZK mode
     * @returns {boolean} True if in real mode
     */
    isRealMode() {
        return this.state.zkMode === 'real';
    }

    /**
     * Generate a mock whitelist membership proof
     * 
     * @param {string} userAddress - User address
     * @param {string} merkleRoot - Merkle root of whitelist
     * @returns {Object} Mock proof object
     * 
     * @example
     * const proof = generator.generateMockWhitelistProof(
     *   '0x1234...',
     *   '0xabcd...'
     * );
     */
    generateMockWhitelistProof(userAddress, merkleRoot) {
        const nullifierHash = ethers.keccak256(
            ethers.solidityPacked(['address', 'bytes32'], [userAddress, merkleRoot])
        );

        return {
            a: [ethers.toBigInt(1), ethers.toBigInt(2)],
            b: [[ethers.toBigInt(3), ethers.toBigInt(4)], [ethers.toBigInt(5), ethers.toBigInt(6)]],
            c: [ethers.toBigInt(7), ethers.toBigInt(8)],
            publicInputs: [merkleRoot, nullifierHash],
            isMock: true
        };
    }

    /**
     * Generate a mock blacklist non-membership proof
     * 
     * @param {string} userAddress - User address
     * @param {string} blacklistRoot - Merkle root of blacklist
     * @returns {Object} Mock proof object
     * 
     * @example
     * const proof = generator.generateMockBlacklistProof(
     *   '0x1234...',
     *   '0xabcd...'
     * );
     */
    generateMockBlacklistProof(userAddress, blacklistRoot) {
        const nullifierHash = ethers.keccak256(
            ethers.solidityPacked(['address', 'bytes32'], [userAddress, blacklistRoot])
        );

        const challengeHash = ethers.keccak256(
            ethers.solidityPacked(['bytes32', 'uint256'], [blacklistRoot, Date.now()])
        );

        return {
            a: [ethers.toBigInt(10), ethers.toBigInt(11)],
            b: [[ethers.toBigInt(12), ethers.toBigInt(13)], [ethers.toBigInt(14), ethers.toBigInt(15)]],
            c: [ethers.toBigInt(16), ethers.toBigInt(17)],
            publicInputs: [blacklistRoot, nullifierHash, challengeHash],
            isMock: true
        };
    }

    /**
     * Generate a mock accreditation proof
     * 
     * @param {number} userAccreditation - User's accreditation level
     * @param {number} minimumAccreditation - Minimum required accreditation
     * @returns {Object} Mock proof object
     * 
     * @example
     * const proof = generator.generateMockAccreditationProof(150000, 100000);
     */
    generateMockAccreditationProof(userAccreditation, minimumAccreditation) {
        const salt = ethers.randomBytes(32);
        const commitmentHash = ethers.keccak256(
            ethers.solidityPacked(['uint256', 'bytes32'], [userAccreditation, salt])
        );

        return {
            a: [ethers.toBigInt(20), ethers.toBigInt(21)],
            b: [[ethers.toBigInt(22), ethers.toBigInt(23)], [ethers.toBigInt(24), ethers.toBigInt(25)]],
            c: [ethers.toBigInt(26), ethers.toBigInt(27)],
            publicInputs: [minimumAccreditation, commitmentHash],
            isMock: true
        };
    }

    /**
     * Generate a mock jurisdiction proof
     * 
     * @param {number} userJurisdiction - User's jurisdiction code
     * @param {number} allowedJurisdictionsMask - Allowed jurisdictions bitmask
     * @returns {Object} Mock proof object
     * 
     * @example
     * const proof = generator.generateMockJurisdictionProof(840, 0xFFFF);
     */
    generateMockJurisdictionProof(userJurisdiction, allowedJurisdictionsMask) {
        const salt = ethers.randomBytes(32);
        const commitmentHash = ethers.keccak256(
            ethers.solidityPacked(['uint256', 'bytes32'], [userJurisdiction, salt])
        );

        return {
            a: [ethers.toBigInt(30), ethers.toBigInt(31)],
            b: [[ethers.toBigInt(32), ethers.toBigInt(33)], [ethers.toBigInt(34), ethers.toBigInt(35)]],
            c: [ethers.toBigInt(36), ethers.toBigInt(37)],
            publicInputs: [allowedJurisdictionsMask, commitmentHash],
            isMock: true
        };
    }

    /**
     * Generate a mock compliance aggregation proof
     * 
     * @param {Object} scores - Compliance scores
     * @param {number} scores.kyc - KYC score (0-100)
     * @param {number} scores.aml - AML score (0-100)
     * @param {number} scores.jurisdiction - Jurisdiction score (0-100)
     * @param {number} scores.accreditation - Accreditation score (0-100)
     * @param {number} minimumComplianceLevel - Minimum compliance level
     * @returns {Object} Mock proof object
     * 
     * @example
     * const proof = generator.generateMockComplianceAggregationProof(
     *   { kyc: 90, aml: 85, jurisdiction: 95, accreditation: 80 },
     *   75
     * );
     */
    generateMockComplianceAggregationProof(scores, minimumComplianceLevel) {
        const salt = ethers.randomBytes(32);
        const commitmentHash = ethers.keccak256(
            ethers.solidityPacked(
                ['uint256', 'uint256', 'uint256', 'uint256', 'bytes32'],
                [scores.kyc, scores.aml, scores.jurisdiction, scores.accreditation, salt]
            )
        );

        // Calculate weighted compliance level (mock calculation)
        const complianceLevel = Math.floor(
            (scores.kyc + scores.aml + scores.jurisdiction + scores.accreditation) / 4
        );

        return {
            a: [ethers.toBigInt(40), ethers.toBigInt(41)],
            b: [[ethers.toBigInt(42), ethers.toBigInt(43)], [ethers.toBigInt(44), ethers.toBigInt(45)]],
            c: [ethers.toBigInt(46), ethers.toBigInt(47)],
            publicInputs: [minimumComplianceLevel, commitmentHash, complianceLevel],
            isMock: true
        };
    }

    /**
     * Initialize real proof generator
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await generator.initializeRealProofGenerator();
     */
    async initializeRealProofGenerator() {
        if (!this.state.realProofGenerator) {
            console.log('🔧 Initializing RealProofGenerator...');
            const path = require('path');
            const { RealProofGenerator } = require(path.join(__dirname, '../../scripts/generate-real-proofs.js'));
            this.state.realProofGenerator = new RealProofGenerator();
            await this.state.realProofGenerator.initialize();
            console.log('✅ RealProofGenerator initialized');
        }
    }

    /**
     * Generate a proof (mock or real based on current mode)
     * 
     * @param {string} proofType - Type of proof ('whitelist', 'blacklist', 'accreditation', 'jurisdiction', 'compliance')
     * @param {Object} params - Proof parameters
     * @returns {Promise<Object>} Proof object
     * 
     * @example
     * const proof = await generator.generateProof('whitelist', {
     *   userAddress: '0x1234...',
     *   merkleRoot: '0xabcd...'
     * });
     */
    async generateProof(proofType, params) {
        if (this.isRealMode()) {
            // Use real proof generator
            await this.initializeRealProofGenerator();
            return await this.state.realProofGenerator.generateProof(proofType, params);
        } else {
            // Use mock proof generator
            switch (proofType) {
                case 'whitelist':
                    return this.generateMockWhitelistProof(params.userAddress, params.merkleRoot);
                case 'blacklist':
                    return this.generateMockBlacklistProof(params.userAddress, params.blacklistRoot);
                case 'accreditation':
                    return this.generateMockAccreditationProof(params.userAccreditation, params.minimumAccreditation);
                case 'jurisdiction':
                    return this.generateMockJurisdictionProof(params.userJurisdiction, params.allowedJurisdictionsMask);
                case 'compliance':
                    return this.generateMockComplianceAggregationProof(params.scores, params.minimumComplianceLevel);
                default:
                    throw new Error(`Unknown proof type: ${proofType}`);
            }
        }
    }

    /**
     * Track proof generation time
     * 
     * @param {string} proofType - Type of proof
     * @param {number} timeMs - Time in milliseconds
     * 
     * @example
     * generator.trackProofGenerationTime('whitelist', 1500);
     */
    trackProofGenerationTime(proofType, timeMs) {
        if (!this.state.proofGenerationTimes.has(proofType)) {
            this.state.proofGenerationTimes.set(proofType, []);
        }
        this.state.proofGenerationTimes.get(proofType).push(timeMs);
    }

    /**
     * Get average proof generation time
     * 
     * @param {string} proofType - Type of proof
     * @returns {number} Average time in milliseconds
     * 
     * @example
     * const avgTime = generator.getAverageProofGenerationTime('whitelist');
     * console.log(`Average: ${avgTime}ms`);
     */
    getAverageProofGenerationTime(proofType) {
        const times = this.state.proofGenerationTimes.get(proofType);
        if (!times || times.length === 0) return 0;
        return times.reduce((a, b) => a + b, 0) / times.length;
    }
}

module.exports = ProofGenerator;

