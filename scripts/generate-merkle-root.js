const { ethers } = require('ethers');
const { MerkleTree } = require('merkletreejs');

/**
 * @title Merkle Root Generator for Whitelist
 * @dev Generates merkle root from a list of approved addresses
 */

class WhitelistMerkleGenerator {
    constructor() {
        this.keccak256 = ethers.keccak256;
        this.solidityPackedKeccak256 = ethers.solidityPackedKeccak256;
    }

    /**
     * Generate merkle root from whitelist addresses
     * @param {string[]} addresses - Array of Ethereum addresses
     * @returns {Object} - Merkle tree data including root and proofs
     */
    generateMerkleRoot(addresses) {
        console.log('🌳 Generating Merkle Tree for Whitelist...');
        console.log(`📋 Processing ${addresses.length} addresses`);

        // Hash each address
        const leaves = addresses.map(addr =>
            this.keccak256(ethers.solidityPacked(['address'], [addr]))
        );

        // Create merkle tree
        const tree = new MerkleTree(leaves, this.keccak256, { sortPairs: true });
        const root = tree.getHexRoot();

        console.log(`✅ Merkle Root: ${root}`);

        // Generate proofs for each address
        const proofs = {};
        addresses.forEach((addr, index) => {
            const leaf = leaves[index];
            const proof = tree.getHexProof(leaf);
            proofs[addr] = {
                leaf: leaf,
                proof: proof,
                index: index
            };
        });

        return {
            root: root,
            tree: tree,
            leaves: leaves,
            proofs: proofs,
            addresses: addresses
        };
    }

    /**
     * Verify an address is in the whitelist
     * @param {string} address - Address to verify
     * @param {string} root - Merkle root
     * @param {string[]} proof - Merkle proof
     * @returns {boolean} - True if address is whitelisted
     */
    verifyWhitelist(address, root, proof) {
        const leaf = this.keccak256(ethers.solidityPacked(['address'], [address]));
        const tree = new MerkleTree([], this.keccak256, { sortPairs: true });
        return tree.verify(proof, leaf, root);
    }

    /**
     * Example: Generate whitelist for common scenarios
     */
    generateExampleWhitelists() {
        console.log('📋 EXAMPLE WHITELIST SCENARIOS');
        console.log('='.repeat(50));

        // 1. Institutional Investors
        const institutionalInvestors = [
            '0x1234567890123456789012345678901234567890', // Bank A
            '0x2345678901234567890123456789012345678901', // Fund B  
            '0x3456789012345678901234567890123456789012', // Insurance C
            '0x4567890123456789012345678901234567890123', // Pension D
            '0x5678901234567890123456789012345678901234'  // Sovereign E
        ];

        console.log('\n🏦 INSTITUTIONAL INVESTORS WHITELIST:');
        const institutional = this.generateMerkleRoot(institutionalInvestors);
        console.log(`   Root: ${institutional.root}`);

        // 2. Accredited Individual Investors
        const accreditedIndividuals = [
            '0x6789012345678901234567890123456789012345', // High Net Worth 1
            '0x7890123456789012345678901234567890123456', // High Net Worth 2
            '0x8901234567890123456789012345678901234567', // High Net Worth 3
            '0x9012345678901234567890123456789012345678', // High Net Worth 4
            '0xa123456789012345678901234567890123456789'  // High Net Worth 5
        ];

        console.log('\n👤 ACCREDITED INDIVIDUALS WHITELIST:');
        const accredited = this.generateMerkleRoot(accreditedIndividuals);
        console.log(`   Root: ${accredited.root}`);

        // 3. Geographic Whitelist (US + EU)
        const geographicWhitelist = [
            '0xb234567890123456789012345678901234567890', // US Entity 1
            '0xc345678901234567890123456789012345678901', // US Entity 2
            '0xd456789012345678901234567890123456789012', // EU Entity 1
            '0xe567890123456789012345678901234567890123', // EU Entity 2
            '0xf678901234567890123456789012345678901234'  // EU Entity 3
        ];

        console.log('\n🌍 GEOGRAPHIC WHITELIST (US + EU):');
        const geographic = this.generateMerkleRoot(geographicWhitelist);
        console.log(`   Root: ${geographic.root}`);

        return {
            institutional,
            accredited,
            geographic
        };
    }

    /**
     * Generate proof for a specific address
     * @param {string} address - Address to generate proof for
     * @param {Object} merkleData - Merkle tree data
     * @returns {Object} - Proof data for ZK circuit
     */
    generateZKProofInputs(address, merkleData) {
        const proofData = merkleData.proofs[address];
        if (!proofData) {
            throw new Error(`Address ${address} not found in whitelist`);
        }

        // For the ZK circuit, we need:
        // - identity (private): hash of the address
        // - pathElements (private): merkle proof elements
        // - pathIndices (private): merkle proof indices
        // - merkleRoot (public): the merkle root
        // - nullifierHash (public): prevents double-spending

        const identity = this.keccak256(ethers.solidityPacked(['address'], [address]));
        const pathElements = proofData.proof;
        const pathIndices = this.calculatePathIndices(proofData.index, pathElements.length);
        const nullifierHash = this.keccak256(
            ethers.solidityPacked(['bytes32', 'bytes32'], [identity, merkleData.root])
        );

        return {
            // Private inputs (secret)
            identity: identity,
            pathElements: pathElements,
            pathIndices: pathIndices,

            // Public inputs
            merkleRoot: merkleData.root,
            nullifierHash: nullifierHash
        };
    }

    /**
     * Calculate path indices for merkle proof
     * @param {number} leafIndex - Index of the leaf
     * @param {number} depth - Depth of the tree
     * @returns {number[]} - Array of path indices
     */
    calculatePathIndices(leafIndex, depth) {
        const indices = [];
        let index = leafIndex;

        for (let i = 0; i < depth; i++) {
            indices.push(index % 2);
            index = Math.floor(index / 2);
        }

        return indices;
    }
}

// Example usage
async function main() {
    const generator = new WhitelistMerkleGenerator();

    console.log('🚀 MERKLE ROOT GENERATOR FOR PRIVACY SYSTEM');
    console.log('='.repeat(60));

    // Generate example whitelists
    const examples = generator.generateExampleWhitelists();

    console.log('\n📊 USAGE IN PRIVACY SYSTEM:');
    console.log('='.repeat(40));
    console.log('1. Use the merkle root as public input to ZK circuit');
    console.log('2. Users prove membership without revealing their address');
    console.log('3. Smart contract verifies the proof against the root');

    console.log('\n💡 PRODUCTION WORKFLOW:');
    console.log('='.repeat(30));
    console.log('1. Compliance team creates whitelist of approved addresses');
    console.log('2. Generate merkle root using this script');
    console.log('3. Publish root on-chain (public)');
    console.log('4. Users generate ZK proofs of membership (private)');
    console.log('5. Smart contracts verify proofs without learning addresses');

    // Example: Generate proof for first institutional investor
    const testAddress = '0x1234567890123456789012345678901234567890';
    console.log(`\n🔍 EXAMPLE ZK PROOF INPUTS FOR ${testAddress}:`);
    try {
        const zkInputs = generator.generateZKProofInputs(testAddress, examples.institutional);
        console.log('   Private inputs (secret):');
        console.log(`     identity: ${zkInputs.identity}`);
        console.log(`     pathElements: [${zkInputs.pathElements.slice(0, 2).join(', ')}...]`);
        console.log(`     pathIndices: [${zkInputs.pathIndices.join(', ')}]`);
        console.log('   Public inputs:');
        console.log(`     merkleRoot: ${zkInputs.merkleRoot}`);
        console.log(`     nullifierHash: ${zkInputs.nullifierHash}`);
    } catch (error) {
        console.log(`   ❌ ${error.message}`);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { WhitelistMerkleGenerator };