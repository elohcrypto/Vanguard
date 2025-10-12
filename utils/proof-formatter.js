/**
 * @title ProofFormatter
 * @dev Utility for formatting ZK proofs for Solidity contracts
 */
class ProofFormatter {
    /**
     * Format snarkjs proof for Solidity
     * @param {Object} proof - snarkjs proof object
     * @param {Array} publicSignals - Public signals array
     * @returns {Object} Formatted proof for Solidity
     */
    static formatForSolidity(proof, publicSignals) {
        return {
            a: [proof.pi_a[0], proof.pi_a[1]],
            b: [
                [proof.pi_b[0][1], proof.pi_b[0][0]],
                [proof.pi_b[1][1], proof.pi_b[1][0]]
            ],
            c: [proof.pi_c[0], proof.pi_c[1]],
            publicSignals: publicSignals.map(s => s.toString())
        };
    }

    /**
     * Format proof for contract call
     * @param {Object} proof - snarkjs proof object
     * @param {Array} publicSignals - Public signals array
     * @returns {Object} Formatted for contract call
     */
    static formatForContractCall(proof, publicSignals) {
        const formatted = this.formatForSolidity(proof, publicSignals);
        return {
            a: formatted.a,
            b: formatted.b,
            c: formatted.c,
            publicSignals: formatted.publicSignals
        };
    }

    /**
     * Validate proof structure
     * @param {Object} proof - Proof to validate
     * @returns {boolean} True if valid
     */
    static validateProof(proof) {
        if (!proof) return false;
        if (!proof.pi_a || proof.pi_a.length !== 3) return false;
        if (!proof.pi_b || proof.pi_b.length !== 3) return false;
        if (!proof.pi_c || proof.pi_c.length !== 3) return false;
        return true;
    }

    /**
     * Validate public signals
     * @param {Array} publicSignals - Public signals to validate
     * @param {number} expectedCount - Expected number of signals
     * @returns {boolean} True if valid
     */
    static validatePublicSignals(publicSignals, expectedCount) {
        if (!Array.isArray(publicSignals)) return false;
        if (publicSignals.length !== expectedCount) return false;
        return publicSignals.every(s => typeof s === 'string' || typeof s === 'bigint');
    }

    /**
     * Convert proof to JSON string
     * @param {Object} proof - Proof object
     * @param {Array} publicSignals - Public signals
     * @returns {string} JSON string
     */
    static toJSON(proof, publicSignals) {
        const formatted = this.formatForSolidity(proof, publicSignals);
        return JSON.stringify(formatted, null, 2);
    }

    /**
     * Parse proof from JSON
     * @param {string} json - JSON string
     * @returns {Object} Parsed proof
     */
    static fromJSON(json) {
        return JSON.parse(json);
    }

    /**
     * Calculate proof hash
     * @param {Object} proof - Proof object
     * @param {Array} publicSignals - Public signals
     * @returns {string} Proof hash
     */
    static calculateHash(proof, publicSignals) {
        const ethers = require('ethers');
        const formatted = this.formatForSolidity(proof, publicSignals);
        
        return ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['uint256[2]', 'uint256[2][2]', 'uint256[2]', 'uint256[]'],
                [formatted.a, formatted.b, formatted.c, formatted.publicSignals]
            )
        );
    }

    /**
     * Estimate proof size in bytes
     * @param {Object} proof - Proof object
     * @returns {number} Size in bytes
     */
    static estimateSize(proof) {
        // Each field element is 32 bytes
        // a: 2 elements = 64 bytes
        // b: 4 elements = 128 bytes
        // c: 2 elements = 64 bytes
        // Total: 256 bytes for proof points
        return 256;
    }

    /**
     * Format proof for display
     * @param {Object} proof - Proof object
     * @param {Array} publicSignals - Public signals
     * @returns {string} Formatted string
     */
    static formatForDisplay(proof, publicSignals) {
        const formatted = this.formatForSolidity(proof, publicSignals);
        
        let output = '📜 ZK Proof:\n';
        output += '  a: [' + formatted.a.join(', ') + ']\n';
        output += '  b: [[' + formatted.b[0].join(', ') + '], [' + formatted.b[1].join(', ') + ']]\n';
        output += '  c: [' + formatted.c.join(', ') + ']\n';
        output += '  Public Signals: [' + formatted.publicSignals.join(', ') + ']\n';
        
        return output;
    }

    /**
     * Create proof summary
     * @param {Object} proof - Proof object
     * @param {Array} publicSignals - Public signals
     * @param {string} circuitType - Type of circuit
     * @returns {Object} Proof summary
     */
    static createSummary(proof, publicSignals, circuitType) {
        return {
            circuitType,
            publicSignalCount: publicSignals.length,
            proofSize: this.estimateSize(proof),
            proofHash: this.calculateHash(proof, publicSignals),
            timestamp: new Date().toISOString(),
            valid: this.validateProof(proof)
        };
    }

    /**
     * Format whitelist proof
     * @param {Object} proof - snarkjs proof
     * @param {string} merkleRoot - Merkle root
     * @returns {Object} Formatted proof
     */
    static formatWhitelistProof(proof, merkleRoot) {
        return this.formatForSolidity(proof, [merkleRoot]);
    }

    /**
     * Format blacklist proof
     * @param {Object} proof - snarkjs proof
     * @param {string} isNotBlacklisted - Output signal (1 if not blacklisted)
     * @returns {Object} Formatted proof
     */
    static formatBlacklistProof(proof, isNotBlacklisted) {
        return this.formatForSolidity(proof, [isNotBlacklisted]);
    }

    /**
     * Format jurisdiction proof
     * @param {Object} proof - snarkjs proof
     * @param {string} jurisdictionHash - Jurisdiction hash
     * @returns {Object} Formatted proof
     */
    static formatJurisdictionProof(proof, jurisdictionHash) {
        return this.formatForSolidity(proof, [jurisdictionHash]);
    }

    /**
     * Format accreditation proof
     * @param {Object} proof - snarkjs proof
     * @param {string} accreditationHash - Accreditation hash
     * @returns {Object} Formatted proof
     */
    static formatAccreditationProof(proof, accreditationHash) {
        return this.formatForSolidity(proof, [accreditationHash]);
    }

    /**
     * Format compliance proof
     * @param {Object} proof - snarkjs proof
     * @param {Object} signals - Compliance signals
     * @returns {Object} Formatted proof
     */
    static formatComplianceProof(proof, signals) {
        const publicSignals = [
            signals.minimumComplianceLevel,
            signals.commitmentHash,
            signals.weightKyc,
            signals.weightAml,
            signals.weightJurisdiction,
            signals.weightAccreditation
        ];
        return this.formatForSolidity(proof, publicSignals);
    }

    /**
     * Batch format multiple proofs
     * @param {Array} proofs - Array of {proof, publicSignals} objects
     * @returns {Array} Formatted proofs
     */
    static batchFormat(proofs) {
        return proofs.map(({ proof, publicSignals }) => 
            this.formatForSolidity(proof, publicSignals)
        );
    }

    /**
     * Export proof to file format
     * @param {Object} proof - Proof object
     * @param {Array} publicSignals - Public signals
     * @param {string} circuitType - Circuit type
     * @returns {Object} Export data
     */
    static exportProof(proof, publicSignals, circuitType) {
        return {
            version: '1.0',
            circuitType,
            timestamp: new Date().toISOString(),
            proof: this.formatForSolidity(proof, publicSignals),
            summary: this.createSummary(proof, publicSignals, circuitType)
        };
    }

    /**
     * Import proof from file format
     * @param {Object} data - Import data
     * @returns {Object} Proof and metadata
     */
    static importProof(data) {
        if (data.version !== '1.0') {
            throw new Error('Unsupported proof format version');
        }
        return {
            proof: data.proof,
            circuitType: data.circuitType,
            summary: data.summary
        };
    }

    /**
     * Compare two proofs
     * @param {Object} proof1 - First proof
     * @param {Object} proof2 - Second proof
     * @returns {boolean} True if proofs are identical
     */
    static compareProofs(proof1, proof2) {
        const hash1 = this.calculateHash(proof1.proof, proof1.publicSignals);
        const hash2 = this.calculateHash(proof2.proof, proof2.publicSignals);
        return hash1 === hash2;
    }

    /**
     * Validate proof for specific circuit
     * @param {Object} proof - Proof object
     * @param {Array} publicSignals - Public signals
     * @param {string} circuitType - Expected circuit type
     * @returns {Object} Validation result
     */
    static validateForCircuit(proof, publicSignals, circuitType) {
        const expectedSignalCounts = {
            'whitelist': 1,
            'blacklist': 1,
            'jurisdiction': 1,
            'accreditation': 1,
            'compliance': 6
        };

        const expectedCount = expectedSignalCounts[circuitType];
        if (!expectedCount) {
            return { valid: false, error: 'Unknown circuit type' };
        }

        if (!this.validateProof(proof)) {
            return { valid: false, error: 'Invalid proof structure' };
        }

        if (!this.validatePublicSignals(publicSignals, expectedCount)) {
            return { 
                valid: false, 
                error: `Invalid public signals count. Expected ${expectedCount}, got ${publicSignals.length}` 
            };
        }

        return { valid: true };
    }
}

module.exports = { ProofFormatter };

