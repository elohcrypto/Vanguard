const { ethers } = require("hardhat");
const ZKProofGenerator = require("./generate-zk-proofs");
const fs = require("fs");
const path = require("path");

/**
 * Setup Real ZK Proofs Integration
 * This script sets up the infrastructure for real ZK proof generation
 */
class RealZKProofSetup {
  constructor() {
    this.generator = new ZKProofGenerator();
    this.whitelistFile = path.join(__dirname, "../data/whitelist.json");
    this.proofsFile = path.join(__dirname, "../data/generated-proofs.json");
  }

  /**
   * Initialize whitelist data
   */
  async initializeWhitelist() {
    console.log("📋 INITIALIZING WHITELIST DATA");
    console.log("=".repeat(40));

    // Get signers from Hardhat
    const signers = await ethers.getSigners();

    // Create initial whitelist with first 10 signers
    const whitelist = signers.slice(0, 10).map((signer) => signer.address);

    console.log("👥 Created whitelist with", whitelist.length, "addresses:");
    whitelist.forEach((addr, i) => {
      console.log(`   ${i + 1}. ${addr}`);
    });

    // Save whitelist to file
    const whitelistData = {
      addresses: whitelist,
      createdAt: new Date().toISOString(),
      merkleRoot: null, // Will be calculated when needed
    };

    // Ensure data directory exists
    const dataDir = path.dirname(this.whitelistFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(
      this.whitelistFile,
      JSON.stringify(whitelistData, null, 2),
    );
    console.log("💾 Whitelist saved to:", this.whitelistFile);

    return whitelist;
  }

  /**
   * Generate proofs for all whitelisted users
   */
  async generateAllProofs() {
    console.log("\n🔧 GENERATING ZK PROOFS FOR ALL USERS");
    console.log("=".repeat(40));

    // Load whitelist
    if (!fs.existsSync(this.whitelistFile)) {
      throw new Error("Whitelist not found. Run initializeWhitelist() first.");
    }

    const whitelistData = JSON.parse(
      fs.readFileSync(this.whitelistFile, "utf8"),
    );
    const whitelist = whitelistData.addresses;

    // Build Merkle tree
    console.log("🌳 Building Merkle tree...");
    const merkleTree = this.generator.buildMerkleTree(whitelist);

    // Update whitelist data with merkle root
    whitelistData.merkleRoot = merkleTree.root.toString();
    fs.writeFileSync(
      this.whitelistFile,
      JSON.stringify(whitelistData, null, 2),
    );

    console.log(
      "🌳 Merkle root:",
      merkleTree.root.toString().substring(0, 20) + "...",
    );

    // Generate proofs for each user
    const generatedProofs = {
      merkleRoot: merkleTree.root.toString(),
      proofs: {},
      generatedAt: new Date().toISOString(),
    };

    for (let i = 0; i < whitelist.length; i++) {
      const userAddress = whitelist[i];
      console.log(
        `\n👤 Generating proof ${i + 1}/${whitelist.length} for: ${userAddress}`,
      );

      try {
        // Get user identity and merkle proof
        const userIdentity = BigInt(
          ethers.keccak256(ethers.toUtf8Bytes(userAddress)),
        );
        const merkleProof = merkleTree.getProof(i);

        // Generate ZK proof
        const zkProof = await this.generator.generateWhitelistProof({
          identity: userIdentity,
          merkleRoot: merkleTree.root,
          pathElements: merkleProof.pathElements,
          pathIndices: merkleProof.pathIndices,
        });

        // Store proof data
        generatedProofs.proofs[userAddress] = {
          proof: zkProof.proof,
          publicSignals: zkProof.publicSignals.map((x) => x.toString()),
          nullifierHash: zkProof.nullifierHash.toString(),
          userIndex: i,
          generatedAt: new Date().toISOString(),
        };

        console.log("   ✅ Proof generated successfully");
        console.log(
          "   🔒 Nullifier:",
          zkProof.nullifierHash.toString().substring(0, 20) + "...",
        );
      } catch (error) {
        console.log("   ❌ Failed to generate proof:", error.message);
        generatedProofs.proofs[userAddress] = {
          error: error.message,
          generatedAt: new Date().toISOString(),
        };
      }
    }

    // Save all proofs
    fs.writeFileSync(this.proofsFile, JSON.stringify(generatedProofs, null, 2));
    console.log("\n💾 All proofs saved to:", this.proofsFile);

    return generatedProofs;
  }

  /**
   * Get proof for a specific user
   */
  getProofForUser(userAddress) {
    if (!fs.existsSync(this.proofsFile)) {
      throw new Error("Proofs not found. Run generateAllProofs() first.");
    }

    const proofsData = JSON.parse(fs.readFileSync(this.proofsFile, "utf8"));
    const userProof = proofsData.proofs[userAddress];

    if (!userProof) {
      throw new Error(`No proof found for user: ${userAddress}`);
    }

    if (userProof.error) {
      throw new Error(`Proof generation failed for user: ${userProof.error}`);
    }

    return {
      merkleRoot: proofsData.merkleRoot,
      proof: userProof.proof,
      publicSignals: userProof.publicSignals,
      nullifierHash: userProof.nullifierHash,
    };
  }

  /**
   * Verify a user's proof
   */
  async verifyUserProof(userAddress) {
    const proofData = this.getProofForUser(userAddress);

    console.log(`🔍 Verifying proof for: ${userAddress}`);
    console.log(
      `   🌳 Merkle Root: ${proofData.merkleRoot.substring(0, 20)}...`,
    );
    console.log(
      `   🔒 Nullifier: ${proofData.nullifierHash.substring(0, 20)}...`,
    );

    const isValid = await this.generator.verifyProof(
      proofData.proof,
      proofData.publicSignals,
    );

    console.log(
      `   ${isValid ? "✅" : "❌"} Verification: ${isValid ? "VALID" : "INVALID"}`,
    );
    return isValid;
  }

  /**
   * Integration helper: Get proof in format expected by contracts
   */
  getContractProof(userAddress) {
    const proofData = this.getProofForUser(userAddress);

    return {
      a: proofData.proof.a,
      b: proofData.proof.b,
      c: proofData.proof.c,
      publicSignals: proofData.publicSignals.map((x) => BigInt(x)),
      merkleRoot: proofData.merkleRoot,
      nullifierHash: proofData.nullifierHash,
    };
  }

  /**
   * Demo: Complete setup and verification
   */
  async demo() {
    console.log("🚀 REAL ZK PROOF SETUP DEMO");
    console.log("=".repeat(50));

    try {
      // 1. Initialize whitelist
      const whitelist = await this.initializeWhitelist();

      // 2. Generate all proofs
      const proofs = await this.generateAllProofs();

      // 3. Test verification for first user
      const testUser = whitelist[0];
      console.log(`\n🧪 TESTING PROOF FOR: ${testUser}`);
      console.log("=".repeat(40));

      await this.verifyUserProof(testUser);

      // 4. Show contract integration format
      console.log("\n📋 CONTRACT INTEGRATION FORMAT:");
      console.log("=".repeat(40));
      const contractProof = this.getContractProof(testUser);
      console.log("✅ Proof ready for contract submission:");
      console.log(
        `   🔒 Nullifier Hash: ${contractProof.nullifierHash.substring(0, 20)}...`,
      );
      console.log(
        `   🌳 Merkle Root: ${contractProof.merkleRoot.substring(0, 20)}...`,
      );
      console.log(
        `   📊 Public Signals: ${contractProof.publicSignals.length} elements`,
      );

      console.log("\n🎉 SETUP COMPLETE!");
      console.log("💡 You can now use real ZK proofs in your demo!");
    } catch (error) {
      console.error("❌ Setup failed:", error.message);
      throw error;
    }
  }
}

// Export for use in other scripts
module.exports = RealZKProofSetup;

// Run demo if called directly
if (require.main === module) {
  async function main() {
    try {
      const setup = new RealZKProofSetup();
      await setup.demo();
    } catch (error) {
      console.error("❌ Error:", error.message);
      process.exit(1);
    }
  }

  main();
}
