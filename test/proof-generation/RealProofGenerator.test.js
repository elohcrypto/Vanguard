const { expect } = require("chai");
const { ethers } = require("hardhat");
const { RealProofGenerator } = require("../../scripts/generate-real-proofs");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");
const { ProofFormatter } = require("../../utils/proof-formatter");
const { describeProofs } = require("../helpers/zkProofs");

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

  describeProofs("1. Whitelist Membership Proof", function () {
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

  describeProofs("2. Blacklist Non-Membership Proof", function () {
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

  // Task 3.7b (D31 a): the three attestation circuits prove an issuer's
  // EdDSA signature (scripts/zk/attest.js) and the policy; verified here on
  // a real-mode wrapper.
  describeProofs(
    "3-5. Attestation proofs (jurisdiction, accreditation, compliance)",
    function () {
      const {
        signAttestation,
        newAttestorKey,
      } = require("../../scripts/zk/attest");
      const key = newAttestorKey();
      const identity = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
      // Task 3.10: the issuer signs an expiry; one year from now.
      const validUntil = Math.floor(Date.now() / 1000) + 365 * 86400;
      let real;
      const fields = (a) => ({
        identity: a.identity,
        salt: a.salt,
        R8x: a.R8x,
        R8y: a.R8y,
        S: a.S,
        Ax: a.Ax,
        Ay: a.Ay,
        chainId: a.chainId,
        verifierContext: BigInt(a.privacyManager),
        validUntil: a.validUntil,
        walletBinding: owner.address,
      });

      before(async function () {
        real = await (
          await ethers.getContractFactory("ZKVerifierIntegrated")
        ).deploy(false);
      });

      it("should generate a valid jurisdiction proof", async function () {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "jurisdiction",
          identity,
          mask: 4,
        });
        const result = await generator.generateJurisdictionProof({
          ...fields(a),
          mask: a.attributes[0],
          allowedMask: 15n,
        });
        // [nullifier, Ax, Ay, chainId, verifierContext, validUntil,
        // allowedMask, walletBinding]
        expect(result.proof).to.have.lengthOf(24);
        expect(result.publicSignals).to.have.lengthOf(8);
        expect(result.publicSignals[0]).to.equal(result.inputs.nullifier);
        expect(result.publicSignals.slice(1)).to.deep.equal([
          a.Ax,
          a.Ay,
          "31337",
          BigInt(a.privacyManager).toString(),
          String(validUntil),
          "15",
          BigInt(owner.address).toString(),
        ]);
        expect(
          await real.verifyJurisdictionProof.staticCall(
            result.proof,
            result.publicSignals,
          ),
        ).to.equal(true);
        const rx = await (
          await real.verifyJurisdictionProof(result.proof, result.publicSignals)
        ).wait();
        console.log(
          `  ⛽ ${"verifyJurisdictionProof"} gas (real verifier): ${rx.gasUsed}`,
        );
      });

      it("should generate a valid accreditation proof", async function () {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "accreditation",
          identity,
          amount: 250000,
        });
        const result = await generator.generateAccreditationProof({
          ...fields(a),
          amount: a.attributes[0],
          minimumAccreditation: 100000n,
        });
        expect(result.publicSignals).to.have.lengthOf(8);
        expect(
          await real.verifyAccreditationProof.staticCall(
            result.proof,
            result.publicSignals,
          ),
        ).to.equal(true);
        const rx = await (
          await real.verifyAccreditationProof(
            result.proof,
            result.publicSignals,
          )
        ).wait();
        console.log(
          `  ⛽ ${"verifyAccreditationProof"} gas (real verifier): ${rx.gasUsed}`,
        );
      });

      it("should generate a valid compliance proof", async function () {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "compliance",
          identity,
          scores: [88, 88, 88, 88],
        });
        const result = await generator.generateComplianceProof({
          ...fields(a),
          scores: a.attributes,
          minimum: 50n,
          weights: [30n, 30n, 20n, 20n],
        });
        // [nullifier, Ax, Ay, chainId, verifierContext, validUntil, minimum,
        // wK, wA, wJ, wAcc, walletBinding]: the aggregate (88) is not among
        // them.
        expect(result.publicSignals).to.have.lengthOf(12);
        expect(result.publicSignals.slice(6, 11)).to.deep.equal([
          "50",
          "30",
          "30",
          "20",
          "20",
        ]);
        expect(
          await real.verifyComplianceAggregation.staticCall(
            result.proof,
            result.publicSignals,
          ),
        ).to.equal(true);
        const rx = await (
          await real.verifyComplianceAggregation(
            result.proof,
            result.publicSignals,
          )
        ).wait();
        console.log(
          `  ⛽ ${"verifyComplianceAggregation"} gas (real verifier): ${rx.gasUsed}`,
        );
      });

      it("should refuse attributes below the policy before proving", async function () {
        const j = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "jurisdiction",
          identity,
          mask: 16,
        });
        await expect(
          generator.generateJurisdictionProof({
            ...fields(j),
            mask: 16n,
            allowedMask: 15n,
          }),
        ).to.be.rejectedWith("not in allowedMask");
        const c = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "compliance",
          identity,
          scores: [50, 50, 50, 50],
        });
        await expect(
          generator.generateComplianceProof({
            ...fields(c),
            scores: c.attributes,
            minimum: 90n,
            weights: [25n, 25n, 25n, 25n],
          }),
        ).to.be.rejectedWith("Insufficient compliance score");
      });

      it("should require the attestation fields and the wallet", async function () {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "accreditation",
          identity,
          amount: 5,
        });
        const base = { ...fields(a), amount: 5n, minimumAccreditation: 3n };
        await expect(
          generator.generateAccreditationProof({ ...base, S: undefined }),
        ).to.be.rejectedWith("S required");
        await expect(
          generator.generateAccreditationProof({ ...base, walletBinding: 0n }),
        ).to.be.rejectedWith("walletBinding is required");
        await expect(
          generator.generateAccreditationProof({
            ...base,
            minimumAccreditation: undefined,
          }),
        ).to.be.rejectedWith("minimumAccreditation is required");
      });
    },
  );

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
