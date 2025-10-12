const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const path = require("path");
const fs = require("fs");
const { MerkleTreeBuilder } = require("../utils/merkle-tree-builder");
const { ProofFormatter } = require("../utils/proof-formatter");

/**
 * @title RealProofGenerator
 * @dev Generate real ZK proofs for all 5 circuit types
 */
class RealProofGenerator {
    constructor() {
        this.poseidon = null;
        this.buildDir = path.join(__dirname, "../build/circuits");
        this.initialized = false;
    }

    /**
     * Initialize Poseidon hash function
     */
    async initialize() {
        if (!this.initialized) {
            console.log("🔧 Initializing RealProofGenerator...");
            this.poseidon = await buildPoseidon();
            this.initialized = true;
            console.log("✅ RealProofGenerator initialized");
        }
    }

    /**
     * Hash a value using Poseidon
     * @param {BigInt[]} values - Values to hash
     * @returns {BigInt} Hash result
     */
    hash(values) {
        if (!this.poseidon) {
            throw new Error("RealProofGenerator not initialized");
        }
        return this.poseidon.F.toObject(this.poseidon(values));
    }

    /**
     * Get circuit paths
     * @param {string} circuitName - Name of the circuit
     * @returns {Object} Paths to circuit files
     */
    getCircuitPaths(circuitName) {
        const circuitDir = path.join(this.buildDir, circuitName);
        return {
            wasm: path.join(circuitDir, `${circuitName}_js`, `${circuitName}.wasm`),
            zkey: path.join(circuitDir, `${circuitName}.zkey`),
            vkey: path.join(circuitDir, `${circuitName}_vkey.json`)
        };
    }

    /**
     * Verify circuit files exist
     * @param {string} circuitName - Name of the circuit
     * @returns {boolean} True if all files exist
     */
    verifyCircuitFiles(circuitName) {
        const paths = this.getCircuitPaths(circuitName);
        return fs.existsSync(paths.wasm) && 
               fs.existsSync(paths.zkey) && 
               fs.existsSync(paths.vkey);
    }

    /**
     * Generate whitelist membership proof
     * @param {Object} params - Proof parameters
     * @param {BigInt} params.identity - User's secret identity
     * @param {BigInt[]} params.whitelistIdentities - Array of whitelisted identities
     * @param {BigInt} params.merkleRoot - Merkle root (optional, will be calculated)
     * @returns {Object} Generated proof
     */
    async generateWhitelistProof(params) {
        await this.initialize();
        console.log("\n🔐 Generating Whitelist Membership Proof...");

        const { identity, whitelistIdentities } = params;

        // Build merkle tree
        console.log("  📊 Building Merkle tree...");
        const tree = await MerkleTreeBuilder.createFromIdentities(whitelistIdentities);
        const identityHash = tree.hashSingle(identity);
        const leafIndex = tree.findLeafIndex(identityHash);

        if (leafIndex === -1) {
            throw new Error("Identity not found in whitelist");
        }

        const merkleRoot = tree.getRoot();
        const { pathElements, pathIndices } = tree.getProof(leafIndex);

        // Generate nullifier
        const nullifierHash = this.hash([identity, merkleRoot]);

        // Prepare circuit inputs
        const input = {
            identity: identity.toString(),
            pathElements: pathElements.map(x => x.toString()),
            pathIndices: pathIndices,
            merkleRoot: merkleRoot.toString(),
            nullifierHash: nullifierHash.toString()
        };

        console.log("  🧮 Generating witness...");
        const paths = this.getCircuitPaths("whitelist_membership");
        
        console.log("  🔐 Generating proof...");
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            paths.wasm,
            paths.zkey
        );

        console.log("  ✅ Proof generated successfully");

        return {
            proof: ProofFormatter.formatForSolidity(proof, publicSignals),
            publicSignals,
            inputs: {
                identity: identity.toString(),
                merkleRoot: merkleRoot.toString(),
                nullifierHash: nullifierHash.toString()
            }
        };
    }

    /**
     * Generate blacklist non-membership proof
     * @param {Object} params - Proof parameters
     * @param {BigInt} params.identity - User's secret identity
     * @param {BigInt[]} params.blacklistIdentities - Array of blacklisted identities
     * @param {BigInt} params.challengeHash - Challenge hash
     * @returns {Object} Generated proof
     */
    async generateBlacklistProof(params) {
        await this.initialize();
        console.log("\n🔐 Generating Blacklist Non-Membership Proof...");

        const {
            identity,
            blacklistIdentities,
            challengeHash = BigInt(Math.floor(Math.random() * 1000000))
        } = params;

        // Build merkle tree
        console.log("  📊 Building Merkle tree...");
        const tree = await MerkleTreeBuilder.createFromIdentities(blacklistIdentities);
        const identityHash = tree.hashSingle(identity);
        const blacklistRoot = tree.getRoot();

        // For non-membership proof, we need a sibling hash
        // Use a dummy position (0) and get its sibling
        const { pathElements, pathIndices } = tree.getProof(0);
        const siblingHash = pathElements[0];

        // Generate nullifier
        const nullifierHash = this.hash([identity, blacklistRoot, challengeHash]);

        // Prepare circuit inputs
        const input = {
            identity: identity.toString(),
            pathElements: pathElements.map(x => x.toString()),
            pathIndices: pathIndices,
            siblingHash: siblingHash.toString(),
            blacklistRoot: blacklistRoot.toString(),
            nullifierHash: nullifierHash.toString(),
            challengeHash: challengeHash.toString()
        };

        console.log("  🧮 Generating witness...");
        const paths = this.getCircuitPaths("blacklist_membership");
        
        console.log("  🔐 Generating proof...");
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            paths.wasm,
            paths.zkey
        );

        console.log("  ✅ Proof generated successfully");

        return {
            proof: ProofFormatter.formatForSolidity(proof, publicSignals),
            publicSignals,
            inputs: {
                identity: identity.toString(),
                blacklistRoot: blacklistRoot.toString(),
                nullifierHash: nullifierHash.toString(),
                challengeHash: challengeHash.toString()
            }
        };
    }

    /**
     * Generate jurisdiction proof
     * @param {Object} params - Proof parameters
     * @param {BigInt} params.userJurisdiction - User's jurisdiction code
     * @param {BigInt[]} params.allowedJurisdictions - Array of allowed jurisdictions
     * @param {BigInt} params.userSalt - Random salt for privacy (optional)
     * @returns {Object} Generated proof
     */
    async generateJurisdictionProof(params) {
        await this.initialize();
        console.log("\n🔐 Generating Jurisdiction Proof...");

        const { userJurisdiction, allowedJurisdictions, userSalt = BigInt(12345) } = params;

        // Check if user's jurisdiction is allowed
        const isAllowed = allowedJurisdictions.includes(userJurisdiction);
        if (!isAllowed) {
            throw new Error("User jurisdiction not in allowed list");
        }

        // Create commitment with salt
        const commitmentHash = this.hash([userJurisdiction, userSalt]);

        // For simplicity, use first allowed jurisdiction as mask
        const allowedJurisdictionsMask = allowedJurisdictions[0];

        // Prepare circuit inputs matching the circuit signature
        const input = {
            userJurisdiction: userJurisdiction.toString(),
            userSalt: userSalt.toString(),
            allowedJurisdictionsMask: allowedJurisdictionsMask.toString(),
            commitmentHash: commitmentHash.toString()
        };

        console.log("  🧮 Generating witness...");
        const paths = this.getCircuitPaths("jurisdiction_proof");

        console.log("  🔐 Generating proof...");
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            paths.wasm,
            paths.zkey
        );

        console.log("  ✅ Proof generated successfully");

        return {
            proof: ProofFormatter.formatForSolidity(proof, publicSignals),
            publicSignals,
            inputs: {
                userJurisdiction: userJurisdiction.toString(),
                userSalt: userSalt.toString(),
                commitmentHash: commitmentHash.toString()
            }
        };
    }

    /**
     * Generate accreditation proof
     * @param {Object} params - Proof parameters
     * @param {BigInt} params.accreditationLevel - User's accreditation level
     * @param {BigInt} params.minimumLevel - Minimum required level
     * @param {BigInt} params.userSalt - Random salt for privacy (optional)
     * @param {BigInt[]} params.issuerSignature - Issuer signature (optional)
     * @param {BigInt[]} params.issuerPublicKey - Issuer public key (optional)
     * @returns {Object} Generated proof
     */
    async generateAccreditationProof(params) {
        await this.initialize();
        console.log("\n🔐 Generating Accreditation Proof...");

        const {
            userAccreditation,
            minimumAccreditation,
            userSalt = BigInt(12345),
            issuerSignature = [BigInt(111), BigInt(222)],
            issuerPublicKey = [BigInt(333), BigInt(444)]
        } = params;

        // Check if user meets minimum level
        if (userAccreditation < minimumAccreditation) {
            throw new Error("Accreditation level below minimum");
        }

        // Create commitment with salt
        const commitmentHash = this.hash([userAccreditation, userSalt]);

        // Prepare circuit inputs matching the circuit signature
        const input = {
            userAccreditation: userAccreditation.toString(),
            userSalt: userSalt.toString(),
            issuerSignature: issuerSignature.map(x => x.toString()),
            minimumAccreditation: minimumAccreditation.toString(),
            commitmentHash: commitmentHash.toString(),
            issuerPublicKey: issuerPublicKey.map(x => x.toString())
        };

        console.log("  🧮 Generating witness...");
        const paths = this.getCircuitPaths("accreditation_proof");

        console.log("  🔐 Generating proof...");
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            paths.wasm,
            paths.zkey
        );

        console.log("  ✅ Proof generated successfully");

        return {
            proof: ProofFormatter.formatForSolidity(proof, publicSignals),
            publicSignals,
            inputs: {
                userAccreditation: userAccreditation.toString(),
                minimumAccreditation: minimumAccreditation.toString(),
                commitmentHash: commitmentHash.toString()
            }
        };
    }

    /**
     * Generate compliance aggregation proof
     * @param {Object} params - Proof parameters
     * @param {BigInt} params.userSalt - Random salt for privacy (optional)
     * @returns {Object} Generated proof
     */
    async generateComplianceProof(params) {
        await this.initialize();
        console.log("\n🔐 Generating Compliance Aggregation Proof...");

        const {
            kycScore,
            amlScore,
            jurisdictionScore,
            accreditationScore,
            weightKyc,
            weightAml,
            weightJurisdiction,
            weightAccreditation,
            minimumComplianceLevel,
            userSalt = BigInt(12345)
        } = params;

        // Calculate weighted compliance score
        // The circuit will validate this internally, but we pre-check for better error messages
        const totalScore =
            (kycScore * weightKyc) +
            (amlScore * weightAml) +
            (jurisdictionScore * weightJurisdiction) +
            (accreditationScore * weightAccreditation);

        // Convert to number for display (avoid BigInt division)
        const totalScoreNum = Number(totalScore);
        const avgScore = totalScoreNum / 100;
        console.log(`  📊 Weighted sum: ${totalScore}, Average score: ${avgScore}`);

        // Pre-check: Validate compliance score meets minimum requirement
        // minimumComplianceLevel is 0-100, gets multiplied by 100 in circuit
        const minimumWeightedSum = minimumComplianceLevel * BigInt(100);
        if (totalScore < minimumWeightedSum) {
            const error = new Error(
                `Insufficient compliance score: ${totalScore} < ${minimumWeightedSum} (minimum required)`
            );
            console.log(`  ❌ ${error.message}`);
            throw error;
        }

        // Create commitment with salt (matching circuit: 5 inputs)
        const commitmentHash = this.hash([
            kycScore, amlScore, jurisdictionScore, accreditationScore, userSalt
        ]);

        // Prepare circuit inputs matching the circuit signature
        const input = {
            kycScore: kycScore.toString(),
            amlScore: amlScore.toString(),
            jurisdictionScore: jurisdictionScore.toString(),
            accreditationScore: accreditationScore.toString(),
            userSalt: userSalt.toString(),
            minimumComplianceLevel: minimumComplianceLevel.toString(),
            commitmentHash: commitmentHash.toString(),
            weightKyc: weightKyc.toString(),
            weightAml: weightAml.toString(),
            weightJurisdiction: weightJurisdiction.toString(),
            weightAccreditation: weightAccreditation.toString()
        };

        console.log("  🧮 Generating witness...");
        const paths = this.getCircuitPaths("compliance_aggregation_fixed");

        console.log("  🔐 Generating proof...");
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            paths.wasm,
            paths.zkey
        );

        console.log("  ✅ Proof generated successfully");

        return {
            proof: ProofFormatter.formatForSolidity(proof, publicSignals),
            publicSignals,
            inputs: {
                minimumComplianceLevel: minimumComplianceLevel.toString(),
                commitmentHash: commitmentHash.toString(),
                weightKyc: weightKyc.toString(),
                weightAml: weightAml.toString(),
                weightJurisdiction: weightJurisdiction.toString(),
                weightAccreditation: weightAccreditation.toString()
            }
        };
    }
}

module.exports = { RealProofGenerator };

