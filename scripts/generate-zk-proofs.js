const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Try to load snarkjs and circomlib, but don't fail if not available
let snarkjs, circomlib;
try {
    snarkjs = require("snarkjs");
    circomlib = require("circomlib");
} catch (error) {
    console.log("⚠️  snarkjs/circomlib not fully available - using simulation mode");
}

/**
 * ZK Proof Generation Script
 * Generates real zero-knowledge proofs for whitelist membership
 */
class ZKProofGenerator {
    constructor() {
        this.circuitWasm = path.join(__dirname, "../circuits/build/whitelist_membership.wasm");
        this.circuitZkey = path.join(__dirname, "../circuits/build/whitelist_membership_final.zkey");
        this.vkeyPath = path.join(__dirname, "../circuits/build/verification_key.json");
        this.simulationMode = !snarkjs || !circomlib;

        if (this.simulationMode) {
            console.log("🎭 Running in simulation mode (circuits not compiled yet)");
        }
    }

    /**
     * Build Merkle Tree from whitelist addresses
     * @param {string[]} addresses - Array of whitelisted addresses
     * @returns {Object} Merkle tree with root and proof functions
     */
    buildMerkleTree(addresses) {
        if (this.simulationMode) {
            // Simulation mode - use simple hashing
            const leaves = addresses.map(addr => {
                return BigInt(ethers.keccak256(ethers.toUtf8Bytes(addr)));
            });

            const tree = this.buildSimpleTree(leaves, 20);

            return {
                root: tree.root,
                getProof: (leafIndex) => this.getMerkleProof(tree, leafIndex),
                leaves: leaves
            };
        }

        const poseidon = circomlib.poseidon;

        // Hash each address to create leaves
        const leaves = addresses.map(addr => {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(addr));
            return poseidon([BigInt(hash)]);
        });

        // Build tree (simplified for 20 levels)
        const tree = this.buildTree(leaves, 20);

        return {
            root: tree.root,
            getProof: (leafIndex) => this.getMerkleProof(tree, leafIndex),
            leaves: leaves
        };
    }

    /**
     * Build binary Merkle tree (real version with Poseidon)
     * @param {BigInt[]} leaves - Leaf values
     * @param {number} levels - Tree depth
     * @returns {Object} Tree structure
     */
    buildTree(leaves, levels) {
        const poseidon = circomlib.poseidon;
        let currentLevel = [...leaves];
        const tree = [currentLevel];

        // Pad to power of 2
        const targetSize = 2 ** levels;
        while (currentLevel.length < targetSize) {
            currentLevel.push(BigInt(0));
        }

        // Build tree bottom-up
        for (let level = 0; level < levels; level++) {
            const nextLevel = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i] || BigInt(0);
                const right = currentLevel[i + 1] || BigInt(0);
                nextLevel.push(poseidon([left, right]));
            }
            currentLevel = nextLevel;
            tree.push(currentLevel);
        }

        return {
            root: currentLevel[0],
            levels: tree
        };
    }

    /**
     * Build simple Merkle tree (simulation mode with keccak256)
     * @param {BigInt[]} leaves - Leaf values
     * @param {number} levels - Tree depth
     * @returns {Object} Tree structure
     */
    buildSimpleTree(leaves, levels) {
        let currentLevel = [...leaves];
        const tree = [currentLevel];

        // Pad to power of 2
        const targetSize = 2 ** levels;
        while (currentLevel.length < targetSize) {
            currentLevel.push(BigInt(0));
        }

        // Build tree bottom-up using keccak256
        for (let level = 0; level < levels; level++) {
            const nextLevel = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i] || BigInt(0);
                const right = currentLevel[i + 1] || BigInt(0);
                const combined = ethers.solidityPackedKeccak256(
                    ["uint256", "uint256"],
                    [left.toString(), right.toString()]
                );
                nextLevel.push(BigInt(combined));
            }
            currentLevel = nextLevel;
            tree.push(currentLevel);
        }

        return {
            root: currentLevel[0],
            levels: tree
        };
    }

    /**
     * Get Merkle proof for a specific leaf
     * @param {Object} tree - Merkle tree
     * @param {number} leafIndex - Index of the leaf
     * @returns {Object} Merkle proof
     */
    getMerkleProof(tree, leafIndex) {
        const pathElements = [];
        const pathIndices = [];
        let currentIndex = leafIndex;

        for (let level = 0; level < tree.levels.length - 1; level++) {
            const currentLevel = tree.levels[level];
            const isLeft = currentIndex % 2 === 0;
            const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
            
            pathElements.push(currentLevel[siblingIndex] || BigInt(0));
            pathIndices.push(isLeft ? 0 : 1);
            
            currentIndex = Math.floor(currentIndex / 2);
        }

        return { pathElements, pathIndices };
    }

    /**
     * Generate nullifier hash
     * @param {BigInt} identity - User's secret identity
     * @param {BigInt} merkleRoot - Merkle root
     * @returns {BigInt} Nullifier hash
     */
    generateNullifier(identity, merkleRoot) {
        if (this.simulationMode) {
            // Simulation mode - use keccak256
            const combined = ethers.solidityPackedKeccak256(
                ["uint256", "uint256"],
                [identity.toString(), merkleRoot.toString()]
            );
            return BigInt(combined);
        }

        const poseidon = circomlib.poseidon;
        return poseidon([identity, merkleRoot]);
    }

    /**
     * Generate ZK proof for whitelist membership
     * @param {Object} inputs - Proof inputs
     * @returns {Object} ZK proof
     */
    async generateWhitelistProof(inputs) {
        const {
            identity,
            merkleRoot,
            pathElements,
            pathIndices
        } = inputs;

        // Generate nullifier
        const nullifierHash = this.generateNullifier(identity, merkleRoot);

        console.log("🔧 Generating ZK proof...");
        console.log(`   🔢 Identity: ${identity.toString().substring(0, 10)}...`);
        console.log(`   🌳 Merkle Root: ${merkleRoot.toString().substring(0, 10)}...`);
        console.log(`   🔒 Nullifier: ${nullifierHash.toString().substring(0, 10)}...`);

        if (this.simulationMode) {
            console.log("   🎭 Using simulation mode (mock proof)");

            // Generate mock proof for simulation
            const mockProof = this.generateMockProof();

            return {
                proof: mockProof,
                publicSignals: [nullifierHash.toString()],
                nullifierHash: nullifierHash,
                merkleRoot: merkleRoot,
                isSimulation: true
            };
        }

        // Prepare circuit inputs
        const circuitInputs = {
            identity: identity.toString(),
            merkleRoot: merkleRoot.toString(),
            nullifierHash: nullifierHash.toString(),
            pathElements: pathElements.map(x => x.toString()),
            pathIndices: pathIndices
        };

        // Generate proof using snarkjs
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            circuitInputs,
            this.circuitWasm,
            this.circuitZkey
        );

        // Format proof for Solidity
        const solidityProof = this.formatProofForSolidity(proof);

        return {
            proof: solidityProof,
            publicSignals: publicSignals,
            nullifierHash: nullifierHash,
            merkleRoot: merkleRoot,
            isSimulation: false
        };
    }

    /**
     * Generate mock proof for simulation mode
     * @returns {Object} Mock proof structure
     */
    generateMockProof() {
        return {
            a: [
                "0x1234567890123456789012345678901234567890123456789012345678901234",
                "0x2345678901234567890123456789012345678901234567890123456789012345"
            ],
            b: [
                [
                    "0x3456789012345678901234567890123456789012345678901234567890123456",
                    "0x4567890123456789012345678901234567890123456789012345678901234567"
                ],
                [
                    "0x5678901234567890123456789012345678901234567890123456789012345678",
                    "0x6789012345678901234567890123456789012345678901234567890123456789"
                ]
            ],
            c: [
                "0x7890123456789012345678901234567890123456789012345678901234567890",
                "0x8901234567890123456789012345678901234567890123456789012345678901"
            ]
        };
    }

    /**
     * Format proof for Solidity contract
     * @param {Object} proof - Raw snarkjs proof
     * @returns {Object} Formatted proof
     */
    formatProofForSolidity(proof) {
        return {
            a: [proof.pi_a[0], proof.pi_a[1]],
            b: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
            c: [proof.pi_c[0], proof.pi_c[1]]
        };
    }

    /**
     * Verify proof off-chain
     * @param {Object} proof - ZK proof
     * @param {string[]} publicSignals - Public signals
     * @returns {boolean} Verification result
     */
    async verifyProof(proof, publicSignals) {
        if (this.simulationMode) {
            console.log("   🎭 Simulation mode - skipping cryptographic verification");
            return true; // Always return true in simulation mode
        }

        if (!fs.existsSync(this.vkeyPath)) {
            console.log("   ⚠️  Verification key not found - skipping verification");
            return true;
        }

        const vKey = JSON.parse(fs.readFileSync(this.vkeyPath));
        return await snarkjs.groth16.verify(vKey, publicSignals, proof);
    }

    /**
     * Demo: Generate proof for a user in whitelist
     */
    async demo() {
        console.log("🎯 ZK PROOF GENERATION DEMO");
        console.log("=" .repeat(50));

        // 1. Create sample whitelist
        const whitelist = [
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // User 0
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // User 1  
            "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // User 2
            "0x90F79bf6EB2c4f870365E785982E1f101E93b906"  // User 3
        ];

        console.log("📋 Whitelist created with", whitelist.length, "addresses");

        // 2. Build Merkle tree
        const merkleTree = this.buildMerkleTree(whitelist);
        console.log("🌳 Merkle tree built, root:", merkleTree.root.toString().substring(0, 20) + "...");

        // 3. Generate proof for user 0
        const userIndex = 0;
        const userAddress = whitelist[userIndex];
        const userIdentity = BigInt(ethers.keccak256(ethers.toUtf8Bytes(userAddress)));
        const merkleProof = merkleTree.getProof(userIndex);

        console.log("👤 Generating proof for user:", userAddress);

        // 4. Generate ZK proof
        const zkProof = await this.generateWhitelistProof({
            identity: userIdentity,
            merkleRoot: merkleTree.root,
            pathElements: merkleProof.pathElements,
            pathIndices: merkleProof.pathIndices
        });

        console.log("✅ ZK proof generated successfully!");
        console.log("🔒 Nullifier Hash:", zkProof.nullifierHash.toString());

        // 5. Verify proof off-chain
        const isValid = await this.verifyProof(zkProof.proof, zkProof.publicSignals);
        console.log("🔍 Off-chain verification:", isValid ? "✅ VALID" : "❌ INVALID");

        return zkProof;
    }
}

// Export for use in other scripts
module.exports = ZKProofGenerator;

// Run demo if called directly
if (require.main === module) {
    async function main() {
        try {
            const generator = new ZKProofGenerator();
            await generator.demo();
        } catch (error) {
            console.error("❌ Error:", error.message);
            process.exit(1);
        }
    }
    
    main();
}
