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
 * @dev Generate real PLONK proofs for all 5 circuits
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
   * Prove an attestation circuit (Task 3.7b, D31 a). Shared by the three
   * generators below: checks the required fields, builds the witness input,
   * proves with PLONK and formats the calldata.
   * @returns {Object} { proof: 24 words, publicSignals, rawProof, inputs:
   *          { nullifier } }
   */
  async _proveAttestation(
    circuitName,
    params,
    attributeInput,
    policyInput,
    policyHash,
  ) {
    await this.initialize();
    const missing = [
      "identity",
      "salt",
      "R8x",
      "R8y",
      "S",
      "Ax",
      "Ay",
      "walletBinding",
    ].filter((k) => params[k] === undefined || params[k] === null);
    if (missing.length) {
      throw new Error(
        `${missing.join(", ")} required (an issuer attestation and the wallet)`,
      );
    }
    if (BigInt(params.walletBinding) === 0n) {
      throw new Error("walletBinding is required and must be non-zero");
    }
    const str = (v) => BigInt(v).toString();
    const input = {
      identity: str(params.identity),
      ...attributeInput,
      salt: str(params.salt),
      R8x: str(params.R8x),
      R8y: str(params.R8y),
      S: str(params.S),
      Ax: str(params.Ax),
      Ay: str(params.Ay),
      ...policyInput,
      walletBinding: str(params.walletBinding),
    };
    const paths = this.getCircuitPaths(circuitName);
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
        nullifier: this.hash([BigInt(params.salt), policyHash]).toString(),
        walletBinding: input.walletBinding,
      },
    };
  }

  /** The value of a required policy or attribute field, as a BigInt. */
  _required(params, name) {
    if (params[name] === undefined || params[name] === null) {
      throw new Error(`${name} is required`);
    }
    return BigInt(params[name]);
  }

  /**
   * Generate a PLONK jurisdiction attestation proof.
   * @param {Object} params - an issuer attestation (scripts/zk/attest.js):
   *        identity, mask (the registry mask bit), salt, R8x, R8y, S, Ax, Ay;
   *        plus allowedMask (PrivacyManager.allowedJurisdictionMask) and
   *        walletBinding (the submitting wallet)
   * @returns {Object} { proof, publicSignals: [nullifier, Ax, Ay,
   *          allowedMask, walletBinding], rawProof, inputs }
   */
  async generateJurisdictionProof(params) {
    console.log("\n🔐 Generating Jurisdiction Attestation Proof (PLONK)...");
    const mask = this._required(params, "mask");
    const allowedMask = this._required(params, "allowedMask");
    if ((mask & allowedMask) === 0n) {
      throw new Error("the attested jurisdiction is not in allowedMask");
    }
    return this._proveAttestation(
      "jurisdiction_proof",
      params,
      { userMask: mask.toString() },
      { allowedMask: allowedMask.toString() },
      allowedMask,
    );
  }

  /**
   * Generate a PLONK accreditation attestation proof.
   * @param {Object} params - an issuer attestation: identity, amount, salt,
   *        R8x, R8y, S, Ax, Ay; plus minimumAccreditation and walletBinding
   * @returns {Object} { proof, publicSignals: [nullifier, Ax, Ay,
   *          minimumAccreditation, walletBinding], rawProof, inputs }
   */
  async generateAccreditationProof(params) {
    console.log("\n🔐 Generating Accreditation Attestation Proof (PLONK)...");
    const amount = this._required(params, "amount");
    const minimum = this._required(params, "minimumAccreditation");
    if (amount < minimum) {
      throw new Error("the attested amount is below minimumAccreditation");
    }
    return this._proveAttestation(
      "accreditation_proof",
      params,
      { amount: amount.toString() },
      { minimumAccreditation: minimum.toString() },
      minimum,
    );
  }

  /**
   * Generate a PLONK compliance-aggregation attestation proof.
   * @param {Object} params - an issuer attestation: identity, scores [kyc,
   *        aml, jurisdiction, accreditation] (0..100), salt, R8x, R8y, S, Ax,
   *        Ay; plus minimum, weights [wK, wA, wJ, wAcc] (sum 100) and
   *        walletBinding
   * @returns {Object} { proof, publicSignals: [nullifier, Ax, Ay, minimum,
   *          wK, wA, wJ, wAcc, walletBinding], rawProof, inputs }
   */
  async generateComplianceProof(params) {
    console.log(
      "\n🔐 Generating Compliance Aggregation Attestation Proof (PLONK)...",
    );
    const minimum = this._required(params, "minimum");
    for (const k of ["scores", "weights"]) {
      if (!Array.isArray(params[k]) || params[k].length !== 4) {
        throw new Error(`${k} is required (four values)`);
      }
    }
    const scores = params.scores.map(BigInt);
    const weights = params.weights.map(BigInt);
    const weighted = scores.reduce((acc, s, i) => acc + s * weights[i], 0n);
    if (weighted < minimum * 100n) {
      throw new Error(
        `Insufficient compliance score: weighted sum ${weighted} < ${minimum * 100n}`,
      );
    }
    await this.initialize();
    const policyHash = this.hash([minimum, ...weights]);
    return this._proveAttestation(
      "compliance_aggregation",
      params,
      { scores: scores.map(String) },
      { minimum: minimum.toString(), weights: weights.map(String) },
      policyHash,
    );
  }
}

module.exports = { RealProofGenerator };
