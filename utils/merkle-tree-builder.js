const { buildPoseidon } = require("circomlibjs");

/**
 * @title MerkleTreeBuilder
 * @dev Utility for building Poseidon-based Merkle trees for ZK proofs
 */
class MerkleTreeBuilder {
    constructor(levels = 20) {
        this.levels = levels;
        this.poseidon = null;
        this.tree = [];
    }

    /**
     * Initialize Poseidon hash function
     */
    async initialize() {
        if (!this.poseidon) {
            this.poseidon = await buildPoseidon();
        }
    }

    /**
     * Hash two values using Poseidon
     * @param {BigInt} left - Left value
     * @param {BigInt} right - Right value
     * @returns {BigInt} Hash result
     */
    hash(left, right) {
        if (!this.poseidon) {
            throw new Error("MerkleTreeBuilder not initialized. Call initialize() first.");
        }
        return this.poseidon.F.toObject(this.poseidon([left, right]));
    }

    /**
     * Hash a single value using Poseidon
     * @param {BigInt} value - Value to hash
     * @returns {BigInt} Hash result
     */
    hashSingle(value) {
        if (!this.poseidon) {
            throw new Error("MerkleTreeBuilder not initialized. Call initialize() first.");
        }
        return this.poseidon.F.toObject(this.poseidon([value]));
    }

    /**
     * Build Merkle tree from leaves
     * @param {BigInt[]} leaves - Array of leaf values
     * @returns {Array} Tree structure (array of levels)
     */
    buildTree(leaves) {
        if (!this.poseidon) {
            throw new Error("MerkleTreeBuilder not initialized. Call initialize() first.");
        }

        // Ensure we have at least one leaf
        if (leaves.length === 0) {
            leaves = [BigInt(0)];
        }

        // Initialize tree with leaves
        this.tree = [];
        this.tree[0] = [...leaves];

        // Pad leaves to power of 2
        const targetSize = Math.pow(2, this.levels);
        while (this.tree[0].length < targetSize) {
            this.tree[0].push(BigInt(0));
        }

        // Build tree bottom-up
        for (let level = 0; level < this.levels; level++) {
            const currentLevel = this.tree[level];
            const nextLevel = [];

            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i] || BigInt(0);
                const right = currentLevel[i + 1] || BigInt(0);
                const hash = this.hash(left, right);
                nextLevel.push(hash);
            }

            this.tree[level + 1] = nextLevel;
        }

        return this.tree;
    }

    /**
     * Get Merkle root
     * @returns {BigInt} Root hash
     */
    getRoot() {
        if (this.tree.length === 0) {
            throw new Error("Tree not built. Call buildTree() first.");
        }
        return this.tree[this.tree.length - 1][0];
    }

    /**
     * Get Merkle proof for a leaf
     * @param {number} leafIndex - Index of the leaf
     * @returns {Object} Proof object with pathElements and pathIndices
     */
    getProof(leafIndex) {
        if (this.tree.length === 0) {
            throw new Error("Tree not built. Call buildTree() first.");
        }

        const pathElements = [];
        const pathIndices = [];
        let index = leafIndex;

        for (let level = 0; level < this.levels; level++) {
            const isLeft = index % 2 === 0;
            const siblingIndex = isLeft ? index + 1 : index - 1;
            const sibling = this.tree[level][siblingIndex] || BigInt(0);

            pathElements.push(sibling);
            pathIndices.push(isLeft ? 0 : 1);

            index = Math.floor(index / 2);
        }

        return { pathElements, pathIndices };
    }

    /**
     * Verify Merkle proof
     * @param {BigInt} leaf - Leaf value
     * @param {BigInt} root - Expected root
     * @param {BigInt[]} pathElements - Proof path elements
     * @param {number[]} pathIndices - Proof path indices
     * @returns {boolean} True if proof is valid
     */
    verifyProof(leaf, root, pathElements, pathIndices) {
        if (!this.poseidon) {
            throw new Error("MerkleTreeBuilder not initialized. Call initialize() first.");
        }

        let currentHash = leaf;

        for (let i = 0; i < pathElements.length; i++) {
            const sibling = pathElements[i];
            const isLeft = pathIndices[i] === 0;

            if (isLeft) {
                currentHash = this.hash(currentHash, sibling);
            } else {
                currentHash = this.hash(sibling, currentHash);
            }
        }

        return currentHash === root;
    }

    /**
     * Find leaf index in tree
     * @param {BigInt} leaf - Leaf value to find
     * @returns {number} Index of leaf, or -1 if not found
     */
    findLeafIndex(leaf) {
        if (this.tree.length === 0) {
            throw new Error("Tree not built. Call buildTree() first.");
        }

        return this.tree[0].findIndex(l => l === leaf);
    }

    /**
     * Check if leaf exists in tree
     * @param {BigInt} leaf - Leaf value to check
     * @returns {boolean} True if leaf exists
     */
    hasLeaf(leaf) {
        return this.findLeafIndex(leaf) !== -1;
    }

    /**
     * Get tree statistics
     * @returns {Object} Tree statistics
     */
    getStats() {
        return {
            levels: this.levels,
            maxLeaves: Math.pow(2, this.levels),
            currentLeaves: this.tree.length > 0 ? this.tree[0].length : 0,
            root: this.tree.length > 0 ? this.getRoot().toString() : null
        };
    }

    /**
     * Export tree to JSON
     * @returns {Object} Tree data
     */
    exportTree() {
        return {
            levels: this.levels,
            tree: this.tree.map(level => level.map(v => v.toString()))
        };
    }

    /**
     * Import tree from JSON
     * @param {Object} data - Tree data
     */
    importTree(data) {
        this.levels = data.levels;
        this.tree = data.tree.map(level => level.map(v => BigInt(v)));
    }

    /**
     * Create a simple tree for testing
     * @param {number} numLeaves - Number of leaves
     * @returns {MerkleTreeBuilder} Tree instance
     */
    static async createSimpleTree(numLeaves = 4, levels = 20) {
        const builder = new MerkleTreeBuilder(levels);
        await builder.initialize();

        const leaves = [];
        for (let i = 0; i < numLeaves; i++) {
            leaves.push(BigInt(i + 1));
        }

        builder.buildTree(leaves);
        return builder;
    }

    /**
     * Create tree from identity hashes
     * @param {BigInt[]} identities - Array of identity values
     * @param {number} levels - Tree levels
     * @returns {MerkleTreeBuilder} Tree instance
     */
    static async createFromIdentities(identities, levels = 20) {
        const builder = new MerkleTreeBuilder(levels);
        await builder.initialize();

        // Hash each identity to create leaves
        const leaves = identities.map(id => builder.hashSingle(id));
        builder.buildTree(leaves);

        return builder;
    }

    /**
     * Create empty tree (all zeros)
     * @param {number} levels - Tree levels
     * @returns {MerkleTreeBuilder} Tree instance
     */
    static async createEmptyTree(levels = 20) {
        const builder = new MerkleTreeBuilder(levels);
        await builder.initialize();
        builder.buildTree([BigInt(0)]);
        return builder;
    }
}

module.exports = { MerkleTreeBuilder };

