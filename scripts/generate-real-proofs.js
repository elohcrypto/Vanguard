const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const path = require("path");
const fs = require("fs");
const { MerkleTreeBuilder } = require("../utils/merkle-tree-builder");
const { ProofFormatter } = require("../utils/proof-formatter");
const {
  buildBlacklistSmt,
  nonInclusionWitness,
} = require("../utils/smt-builder");

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
      vkey: path.join(circuitDir, `${circuitName}_vkey.json`),
    };
  }

  /**
   * Verify circuit files exist
   * @param {string} circuitName - Name of the circuit
   * @returns {boolean} True if all files exist
   */
  verifyCircuitFiles(circuitName) {
    const paths = this.getCircuitPaths(circuitName);
    return (
      fs.existsSync(paths.wasm) &&
      fs.existsSync(paths.zkey) &&
      fs.existsSync(paths.vkey)
    );
  }

  /**
   * Generate a PLONK whitelist membership proof (D30 a: commitment leaves).
   * @param {Object} params - Proof parameters
   * @param {BigInt} params.identity - The prover's identity value
   * @param {BigInt} params.secret - The prover's private secret; leaf =
   *        Poseidon(identity, secret), nullifier = Poseidon(secret, root)
   * @param {BigInt|string} params.walletBinding - Wallet the proof is for
   *        (an address or a field element); the consumer compares it with
   *        msg.sender (Task 3.3)
   * @param {BigInt[]} [params.commitments] - Published tree leaves, as given
   * @param {{identity: BigInt, secret: BigInt}[]} [params.members] - Or the
   *        members, committed here (tests and the demo)
   * @returns {Object} { proof: 24 words, publicSignals: [nullifier,
   *          merkleRoot, walletBinding], rawProof, inputs }; pass proof and
   *          publicSignals to ZKVerifierIntegrated.verifyWhitelistMembership
   */
  async generateWhitelistProof(params) {
    await this.initialize();
    console.log("\n🔐 Generating Whitelist Membership Proof (PLONK)...");

    const { identity, secret, walletBinding, commitments, members } = params;
    if (identity === undefined || identity === null) {
      throw new Error("identity is required");
    }
    if (secret === undefined || secret === null) {
      throw new Error(
        "secret is required: the whitelist leaf is Poseidon(identity, secret)",
      );
    }
    if (
      walletBinding === undefined ||
      walletBinding === null ||
      BigInt(walletBinding) === 0n
    ) {
      // 0 is never a wallet; the consumer (3.3) requires binding == msg.sender.
      throw new Error("walletBinding is required and must be non-zero");
    }
    if (!commitments === !members) {
      throw new Error("pass exactly one of commitments or members");
    }

    console.log("  📊 Building Merkle tree...");
    const leaves =
      commitments ||
      members.map((m) => this.hash([BigInt(m.identity), BigInt(m.secret)]));
    const tree = await MerkleTreeBuilder.createFromCommitments(leaves);
    const leafIndex = tree.findLeafIndex(tree.commitment(identity, secret));

    if (leafIndex === -1) {
      throw new Error("Commitment not found in whitelist");
    }

    const merkleRoot = tree.getRoot();
    const { pathElements, pathIndices } = tree.getProof(leafIndex);

    const input = {
      identity: BigInt(identity).toString(),
      secret: BigInt(secret).toString(),
      pathElements: pathElements.map((x) => x.toString()),
      pathIndices: pathIndices,
      merkleRoot: merkleRoot.toString(),
      walletBinding: BigInt(walletBinding).toString(),
    };

    const paths = this.getCircuitPaths("whitelist_membership");
    console.log("  🔐 Generating witness and proof...");
    const { proof, publicSignals } = await snarkjs.plonk.fullProve(
      input,
      paths.wasm,
      paths.zkey,
    );
    console.log("  ✅ Proof generated successfully");

    const calldata = await ProofFormatter.formatPlonkForSolidity(
      proof,
      publicSignals,
    );
    return {
      proof: calldata.proof,
      publicSignals: calldata.publicSignals,
      rawProof: proof,
      inputs: {
        merkleRoot: merkleRoot.toString(),
        walletBinding: input.walletBinding,
        nullifier: this.hash([BigInt(secret), merkleRoot]).toString(),
      },
    };
  }

  /**
   * Generate a PLONK blacklist non-membership proof (Task 3.7): the wallet's
   * holder owns a commitment in the whitelist root whose identity is not in
   * the sanctions tree. Non-gating (D2): nothing on chain consumes it.
   * @param {Object} params - Proof parameters
   * @param {BigInt} params.identity - The prover's identity (sanctions-tree key)
   * @param {BigInt} params.secret - The prover's secret; the whitelist leaf is
   *        Poseidon(identity, secret), nullifier = Poseidon(secret, blacklistRoot)
   * @param {BigInt|string} params.walletBinding - Wallet the proof is for
   *        (an address or a field element), non-zero
   * @param {BigInt[]} [params.commitments] - Published whitelist leaves
   * @param {{identity: BigInt, secret: BigInt}[]} [params.members] - Or the
   *        whitelist members, committed here (tests)
   * @param {BigInt[]} params.blacklistIdentities - Listed identities; the
   *        sanctions SMT is built from them (utils/smt-builder.js)
   * @returns {Object} { proof: 24 words, publicSignals: [nullifier,
   *          whitelistRoot, blacklistRoot, walletBinding], rawProof, inputs };
   *          pass proof and publicSignals to
   *          ZKVerifierIntegrated.verifyBlacklistNonMembership
   * @throws before proving when the identity is listed or its commitment is
   *         not in the whitelist
   */
  async generateBlacklistProof(params) {
    await this.initialize();
    console.log("\n🔐 Generating Blacklist Non-Membership Proof (PLONK)...");

    const {
      identity,
      secret,
      walletBinding,
      commitments,
      members,
      blacklistIdentities,
    } = params;
    if (identity === undefined || identity === null) {
      throw new Error("identity is required");
    }
    if (secret === undefined || secret === null) {
      throw new Error(
        "secret is required: the whitelist leaf is Poseidon(identity, secret)",
      );
    }
    if (
      walletBinding === undefined ||
      walletBinding === null ||
      BigInt(walletBinding) === 0n
    ) {
      throw new Error("walletBinding is required and must be non-zero");
    }
    if (!commitments === !members) {
      throw new Error("pass exactly one of commitments or members");
    }
    if (!Array.isArray(blacklistIdentities)) {
      throw new Error(
        "blacklistIdentities is required (an array; empty for an empty list)",
      );
    }

    console.log("  📊 Building whitelist tree and sanctions tree...");
    const leaves =
      commitments ||
      members.map((m) => this.hash([BigInt(m.identity), BigInt(m.secret)]));
    const tree = await MerkleTreeBuilder.createFromCommitments(leaves);
    const leafIndex = tree.findLeafIndex(tree.commitment(identity, secret));
    if (leafIndex === -1) {
      throw new Error("Commitment not found in whitelist");
    }
    const whitelistRoot = tree.getRoot();
    const { pathElements, pathIndices } = tree.getProof(leafIndex);

    const smt = await buildBlacklistSmt(blacklistIdentities);
    // Throws "... is on the sanctions list ..." for a listed identity.
    const w = await nonInclusionWitness(smt.tree, identity);

    const input = {
      identity: BigInt(identity).toString(),
      secret: BigInt(secret).toString(),
      pathElements: pathElements.map((x) => x.toString()),
      pathIndices: pathIndices,
      siblings: w.siblings.map((x) => x.toString()),
      oldKey: w.oldKey.toString(),
      oldValue: w.oldValue.toString(),
      isOld0: w.isOld0,
      whitelistRoot: whitelistRoot.toString(),
      blacklistRoot: smt.root.toString(),
      walletBinding: BigInt(walletBinding).toString(),
    };

    const paths = this.getCircuitPaths("blacklist_membership");
    console.log("  🔐 Generating witness and proof...");
    const { proof, publicSignals } = await snarkjs.plonk.fullProve(
      input,
      paths.wasm,
      paths.zkey,
    );
    console.log("  ✅ Proof generated successfully");

    const calldata = await ProofFormatter.formatPlonkForSolidity(
      proof,
      publicSignals,
    );
    return {
      proof: calldata.proof,
      publicSignals: calldata.publicSignals,
      rawProof: proof,
      inputs: {
        whitelistRoot: whitelistRoot.toString(),
        blacklistRoot: smt.root.toString(),
        walletBinding: input.walletBinding,
        nullifier: this.hash([BigInt(secret), smt.root]).toString(),
      },
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

    const {
      userJurisdiction,
      allowedJurisdictions,
      userSalt = BigInt(12345),
    } = params;

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
      commitmentHash: commitmentHash.toString(),
    };

    console.log("  🧮 Generating witness...");
    const paths = this.getCircuitPaths("jurisdiction_proof");

    console.log("  🔐 Generating proof...");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      paths.wasm,
      paths.zkey,
    );

    console.log("  ✅ Proof generated successfully");

    return {
      proof: ProofFormatter.formatForSolidity(proof, publicSignals),
      publicSignals,
      inputs: {
        userJurisdiction: userJurisdiction.toString(),
        userSalt: userSalt.toString(),
        commitmentHash: commitmentHash.toString(),
      },
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
      issuerPublicKey = [BigInt(333), BigInt(444)],
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
      issuerSignature: issuerSignature.map((x) => x.toString()),
      minimumAccreditation: minimumAccreditation.toString(),
      commitmentHash: commitmentHash.toString(),
      issuerPublicKey: issuerPublicKey.map((x) => x.toString()),
    };

    console.log("  🧮 Generating witness...");
    const paths = this.getCircuitPaths("accreditation_proof");

    console.log("  🔐 Generating proof...");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      paths.wasm,
      paths.zkey,
    );

    console.log("  ✅ Proof generated successfully");

    return {
      proof: ProofFormatter.formatForSolidity(proof, publicSignals),
      publicSignals,
      inputs: {
        userAccreditation: userAccreditation.toString(),
        minimumAccreditation: minimumAccreditation.toString(),
        commitmentHash: commitmentHash.toString(),
      },
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
      userSalt = BigInt(12345),
    } = params;

    // Calculate weighted compliance score
    // The circuit will validate this internally, but we pre-check for better error messages
    const totalScore =
      kycScore * weightKyc +
      amlScore * weightAml +
      jurisdictionScore * weightJurisdiction +
      accreditationScore * weightAccreditation;

    // Convert to number for display (avoid BigInt division)
    const totalScoreNum = Number(totalScore);
    const avgScore = totalScoreNum / 100;
    console.log(`  📊 Weighted sum: ${totalScore}, Average score: ${avgScore}`);

    // Pre-check: Validate compliance score meets minimum requirement
    // minimumComplianceLevel is 0-100, gets multiplied by 100 in circuit
    const minimumWeightedSum = minimumComplianceLevel * BigInt(100);
    if (totalScore < minimumWeightedSum) {
      const error = new Error(
        `Insufficient compliance score: ${totalScore} < ${minimumWeightedSum} (minimum required)`,
      );
      console.log(`  ❌ ${error.message}`);
      throw error;
    }

    // Create commitment with salt (matching circuit: 5 inputs)
    const commitmentHash = this.hash([
      kycScore,
      amlScore,
      jurisdictionScore,
      accreditationScore,
      userSalt,
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
      weightAccreditation: weightAccreditation.toString(),
    };

    console.log("  🧮 Generating witness...");
    const paths = this.getCircuitPaths("compliance_aggregation");

    console.log("  🔐 Generating proof...");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      paths.wasm,
      paths.zkey,
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
        weightAccreditation: weightAccreditation.toString(),
      },
    };
  }
}

module.exports = { RealProofGenerator };
