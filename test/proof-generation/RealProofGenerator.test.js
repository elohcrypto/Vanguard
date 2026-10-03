const { expect } = require("chai");
const { ethers } = require("hardhat");
const { RealProofGenerator } = require("../../scripts/generate-real-proofs");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");
const { ProofFormatter } = require("../../utils/proof-formatter");

describe("RealProofGenerator - All 5 Proof Types", function () {
  let generator;
  let zkVerifier;
  let owner;

  // Increase timeout for proof generation
  this.timeout(60000);

  before(async function () {
    [owner] = await ethers.getSigners();

    // Deploy ZKVerifierIntegrated in testing mode
    const ZKVerifierIntegrated = await ethers.getContractFactory(
      "ZKVerifierIntegrated",
    );
    zkVerifier = await ZKVerifierIntegrated.deploy(true); // testingMode=true
    await zkVerifier.waitForDeployment();

    // Initialize proof generator
    generator = new RealProofGenerator();
    await generator.initialize();
  });

  describe("1. Whitelist Membership Proof", function () {
    it("should generate valid whitelist proof", async function () {
      console.log("\n  🧪 Testing Whitelist Proof Generation");

      const members = [11111n, 12345n, 33333n, 44444n].map((identity, i) => ({
        identity,
        secret: BigInt(i + 1) * 1000n,
      }));

      const startTime = Date.now();
      const result = await generator.generateWhitelistProof({
        ...members[1],
        members,
        walletBinding: owner.address,
      });
      const duration = Date.now() - startTime;

      console.log(`  ⏱️  Generation time: ${duration}ms`);
      console.log(`  📊 Public signals: ${result.publicSignals.length}`);

      // PLONK: 24 proof words, [nullifier, merkleRoot, walletBinding]
      expect(result.proof).to.have.lengthOf(24);
      expect(result.publicSignals).to.have.lengthOf(3);

      // Verify on-chain
      const tx = await zkVerifier.verifyWhitelistMembership(
        result.proof,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
      expect(tx).to.not.be.reverted;
    });

    it("should reject a commitment not in the whitelist", async function () {
      const members = [
        { identity: 11111n, secret: 101n },
        { identity: 22222n, secret: 202n },
      ];

      await expect(
        generator.generateWhitelistProof({
          identity: 99999n,
          secret: 909n,
          members,
          walletBinding: owner.address,
        }),
      ).to.be.rejectedWith("Commitment not found in whitelist");
      // A listed identity with the wrong secret is not a member either.
      await expect(
        generator.generateWhitelistProof({
          identity: 11111n,
          secret: 102n,
          members,
          walletBinding: owner.address,
        }),
      ).to.be.rejectedWith("Commitment not found in whitelist");
    });

    it("should accept published commitments as the tree leaves", async function () {
      const members = [
        { identity: 11111n, secret: 101n },
        { identity: 12345n, secret: 202n },
      ];
      const commitments = members.map((m) =>
        generator.hash([m.identity, m.secret]),
      );
      const a = await generator.generateWhitelistProof({
        ...members[1],
        commitments,
        walletBinding: owner.address,
      });
      const b = await generator.generateWhitelistProof({
        ...members[1],
        members,
        walletBinding: owner.address,
      });
      expect(a.publicSignals).to.deep.equal(b.publicSignals);
    });

    it("should require secret and walletBinding", async function () {
      await expect(
        generator.generateWhitelistProof({
          identity: 12345n,
          members: [{ identity: 12345n, secret: 1n }],
          walletBinding: owner.address,
        }),
      ).to.be.rejectedWith("secret is required");
      await expect(
        generator.generateWhitelistProof({
          identity: 12345n,
          secret: 1n,
          members: [{ identity: 12345n, secret: 1n }],
        }),
      ).to.be.rejectedWith("walletBinding is required");
    });
  });

  describe("2. Blacklist Non-Membership Proof", function () {
    const members = [11111n, 12345n, 33333n].map((identity, i) => ({
      identity,
      secret: BigInt(i + 1) * 1000n,
    }));
    const blacklistIdentities = [22222n, 33333n, 44444n];

    it("should generate valid blacklist proof", async function () {
      console.log("\n  🧪 Testing Blacklist Proof Generation");

      const startTime = Date.now();
      const result = await generator.generateBlacklistProof({
        ...members[1],
        members,
        blacklistIdentities,
        walletBinding: owner.address,
      });
      const duration = Date.now() - startTime;

      console.log(`  ⏱️  Generation time: ${duration}ms`);
      console.log(`  📊 Public signals: ${result.publicSignals.length}`);

      // PLONK: 24 proof words,
      // [nullifier, whitelistRoot, blacklistRoot, walletBinding]
      expect(result.proof).to.have.lengthOf(24);
      expect(result.publicSignals).to.have.lengthOf(4);
      expect(result.publicSignals[2]).to.equal(result.inputs.blacklistRoot);
      expect(result.publicSignals[3]).to.equal(
        BigInt(owner.address).toString(),
      );

      // Verify on-chain
      const tx = await zkVerifier.verifyBlacklistNonMembership(
        result.proof,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
      expect(tx).to.not.be.reverted;
    });

    it("should refuse a listed identity and an unknown commitment", async function () {
      await expect(
        generator.generateBlacklistProof({
          ...members[2],
          members,
          blacklistIdentities,
          walletBinding: owner.address,
        }),
      ).to.be.rejectedWith("is on the sanctions list");
      await expect(
        generator.generateBlacklistProof({
          identity: 99999n,
          secret: 1n,
          members,
          blacklistIdentities,
          walletBinding: owner.address,
        }),
      ).to.be.rejectedWith("Commitment not found in whitelist");
    });

    it("should require secret, walletBinding and the sanctions list", async function () {
      const base = { ...members[0], members, blacklistIdentities };
      await expect(
        generator.generateBlacklistProof({ ...base, secret: undefined }),
      ).to.be.rejectedWith("secret is required");
      await expect(
        generator.generateBlacklistProof({ ...base, walletBinding: 0n }),
      ).to.be.rejectedWith("walletBinding is required");
      await expect(
        generator.generateBlacklistProof({
          ...base,
          walletBinding: owner.address,
          blacklistIdentities: undefined,
        }),
      ).to.be.rejectedWith("blacklistIdentities is required");
    });
  });

  describe("3. Jurisdiction Proof", function () {
    it("should generate valid jurisdiction proof", async function () {
      console.log("\n  🧪 Testing Jurisdiction Proof Generation");

      const userJurisdiction = BigInt(1); // US
      const allowedJurisdictions = [BigInt(1), BigInt(2), BigInt(3)];

      const startTime = Date.now();
      const result = await generator.generateJurisdictionProof({
        userJurisdiction,
        allowedJurisdictions,
      });
      const duration = Date.now() - startTime;

      console.log(`  ⏱️  Generation time: ${duration}ms`);
      console.log(`  📊 Public signals: ${result.publicSignals.length}`);

      // Validate proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.have.lengthOf(1);

      // Verify on-chain
      const tx = await zkVerifier.verifyJurisdictionProof(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
      expect(tx).to.not.be.reverted;
    });

    it("should reject disallowed jurisdiction", async function () {
      const userJurisdiction = BigInt(99); // Not allowed
      const allowedJurisdictions = [BigInt(1), BigInt(2)];

      await expect(
        generator.generateJurisdictionProof({
          userJurisdiction,
          allowedJurisdictions,
        }),
      ).to.be.rejectedWith("User jurisdiction not in allowed list");
    });
  });

  describe("4. Accreditation Proof", function () {
    it("should generate valid accreditation proof", async function () {
      console.log("\n  🧪 Testing Accreditation Proof Generation");

      const userAccreditation = BigInt(5);
      const minimumAccreditation = BigInt(3);

      const startTime = Date.now();
      const result = await generator.generateAccreditationProof({
        userAccreditation,
        minimumAccreditation,
      });
      const duration = Date.now() - startTime;

      console.log(`  ⏱️  Generation time: ${duration}ms`);
      console.log(`  📊 Public signals: ${result.publicSignals.length}`);

      // Validate proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.have.lengthOf(1);

      // Verify on-chain
      const tx = await zkVerifier.verifyAccreditationProof(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
      expect(tx).to.not.be.reverted;
    });

    it("should reject insufficient accreditation level", async function () {
      const userAccreditation = BigInt(2);
      const minimumAccreditation = BigInt(5);

      await expect(
        generator.generateAccreditationProof({
          userAccreditation,
          minimumAccreditation,
        }),
      ).to.be.rejectedWith("Accreditation level below minimum");
    });
  });

  describe("5. Compliance Aggregation Proof", function () {
    it("should generate valid compliance proof", async function () {
      console.log("\n  🧪 Testing Compliance Proof Generation");

      const params = {
        kycScore: BigInt(88),
        amlScore: BigInt(88),
        jurisdictionScore: BigInt(88),
        accreditationScore: BigInt(88),
        weightKyc: BigInt(30),
        weightAml: BigInt(30),
        weightJurisdiction: BigInt(20),
        weightAccreditation: BigInt(20),
        // Weighted sum = 88*30 + 88*30 + 88*20 + 88*20 = 8800 (divisible by 100 → 88)
        // minimumComplianceLevel is 0-100 (gets multiplied by 100 in circuit)
        // So 50 means minimum weighted sum of 5000
        minimumComplianceLevel: BigInt(50),
      };

      const startTime = Date.now();
      const result = await generator.generateComplianceProof(params);
      const duration = Date.now() - startTime;

      console.log(`  ⏱️  Generation time: ${duration}ms`);
      console.log(`  📊 Public signals: ${result.publicSignals.length}`);

      // Validate proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.have.lengthOf(2); // meetsCompliance and complianceLevel

      // Verify on-chain
      // Note: Contract expects 6 public inputs (not the 2 circuit outputs)
      // Construct the public inputs array manually
      const publicInputs = [
        params.minimumComplianceLevel,
        result.inputs.commitmentHash,
        params.weightKyc,
        params.weightAml,
        params.weightJurisdiction,
        params.weightAccreditation,
      ];

      const tx = await zkVerifier.verifyComplianceAggregation(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        publicInputs,
      );
      const receipt = await tx.wait();

      console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
      expect(tx).to.not.be.reverted;
    });

    it("should reject insufficient compliance score", async function () {
      const params = {
        kycScore: BigInt(50),
        amlScore: BigInt(50),
        jurisdictionScore: BigInt(50),
        accreditationScore: BigInt(50),
        weightKyc: BigInt(25),
        weightAml: BigInt(25),
        weightJurisdiction: BigInt(25),
        weightAccreditation: BigInt(25),
        // Weighted sum = 50*25 + 50*25 + 50*25 + 50*25 = 5000
        // minimumComplianceLevel is 0-100 (gets multiplied by 100 in circuit)
        // So 90 means minimum weighted sum of 9000 (which is > 5000, so should fail)
        minimumComplianceLevel: BigInt(90),
      };

      // Circuit will fail with assertion error instead of throwing custom error
      await expect(generator.generateComplianceProof(params)).to.be.rejected; // Accept any rejection (circuit assertion failure)
    });
  });

  describe("Utility Functions", function () {
    describe("MerkleTreeBuilder", function () {
      it("should build merkle tree correctly", async function () {
        const tree = await MerkleTreeBuilder.createSimpleTree(4, 20);

        expect(tree.getRoot()).to.not.be.null;
        expect(tree.getStats().levels).to.equal(20);
        expect(tree.getStats().maxLeaves).to.equal(Math.pow(2, 20));
      });

      it("should generate valid merkle proofs", async function () {
        const commitments = [BigInt(1), BigInt(2), BigInt(3), BigInt(4)];
        const tree = await MerkleTreeBuilder.createFromCommitments(commitments);

        const { pathElements, pathIndices } = tree.getProof(0);
        expect(pathElements).to.have.lengthOf(20);
        expect(pathIndices).to.have.lengthOf(20);
      });
    });

    describe("ProofFormatter", function () {
      it("should format proof for Solidity", async function () {
        const mockProof = {
          pi_a: ["1", "2", "1"],
          pi_b: [
            ["3", "4"],
            ["5", "6"],
            ["1", "1"],
          ],
          pi_c: ["7", "8", "1"],
        };
        const publicSignals = ["12345"];

        const formatted = ProofFormatter.formatForSolidity(
          mockProof,
          publicSignals,
        );

        expect(formatted.a).to.have.lengthOf(2);
        expect(formatted.b).to.have.lengthOf(2);
        expect(formatted.c).to.have.lengthOf(2);
        expect(formatted.publicSignals).to.deep.equal(["12345"]);
      });

      it("should validate proof structure", function () {
        const validProof = {
          pi_a: ["1", "2", "1"],
          pi_b: [
            ["3", "4"],
            ["5", "6"],
            ["1", "1"],
          ],
          pi_c: ["7", "8", "1"],
        };

        expect(ProofFormatter.validateProof(validProof)).to.be.true;
        expect(ProofFormatter.validateProof({})).to.be.false;
      });
    });
  });
});
