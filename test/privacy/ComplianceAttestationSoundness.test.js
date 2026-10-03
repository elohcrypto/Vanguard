const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const {
  IN_SIGNATURE,
  deployAttestationFixture,
  circuitInput,
  witness,
  cachedEvents,
  aliasedProof,
  reproducesCommittedVerifier,
  expectTamperedRefused,
} = require("../helpers/attestationFixture");

const { describeProofs } = require("../helpers/zkProofs");
// Task 3.7b (D31 a): the compliance-aggregation proof states "a trusted
// issuer signed this identity's four scores in one attestation, and their
// weighted sum meets PrivacyManager's minimum". The aggregate is never
// public (the old complianceLevel output is gone). A-F as in
// JurisdictionAttestationSoundness.
const IN_MAIN = /Assert Failed\. Error in template ComplianceAggregation/;
const POLICY = [70n, 25n, 25n, 25n, 25n];

describeProofs(
  "Compliance aggregation attestation soundness (Task 3.7b)",
  function () {
    this.timeout(600000);

    let f;
    let att; // scores 90, 80, 70, 60: weighted 7500 >= 7000
    let r1;
    let r2;

    before(async function () {
      f = await deployAttestationFixture("compliance");
      await f.pm.setCompliancePolicy(...POLICY);
      att = await f.sign({ scores: [90, 80, 70, 60] });
      r1 = await f.prove(att, f.wallets[1]);
      r2 = await f.prove(att, f.wallets[2]);
    });

    describe("A: forged or untrusted signatures", function () {
      it("a signature by another key under the trusted (Ax, Ay) has no witness", async function () {
        const other = await f.sign(
          { scores: [90, 80, 70, 60] },
          ethers.hexlify(ethers.randomBytes(32)),
        );
        const input = circuitInput(other, POLICY, f.wallets[1].address, {
          Ax: att.Ax,
          Ay: att.Ay,
        });
        await expect(witness(f.paths, input)).to.be.rejectedWith(IN_SIGNATURE);
      });

      it("any raised score breaks the signature", async function () {
        for (let i = 0; i < 4; i++) {
          const scores = [...att.attributes];
          scores[i] = "100";
          const input = circuitInput(att, POLICY, f.wallets[1].address, {
            scores,
          });
          await expect(
            witness(f.paths, input),
            `score ${i}`,
          ).to.be.rejectedWith(IN_SIGNATURE);
        }
      });

      it("PrivacyManager refuses an untrusted (Ax, Ay)", async function () {
        await f.pm.setTrustedAttestor(f.id, f.Ax, f.Ay, false);
        try {
          await expect(
            f.pm
              .connect(f.wallets[1])
              .submitAttestationProof(f.id, r1.proof, r1.signals),
          )
            .to.be.revertedWithCustomError(f.pm, "UntrustedAttestor")
            .withArgs(f.id, f.attestor);
        } finally {
          await f.pm.setTrustedAttestor(f.id, f.Ax, f.Ay, true);
        }
      });
    });

    describe("B: policy mismatches", function () {
      it("a weighted sum below minimum * 100 has no witness", async function () {
        const input = circuitInput(
          att,
          [76n, 25n, 25n, 25n, 25n],
          f.wallets[1].address,
        );
        await expect(witness(f.paths, input)).to.be.rejectedWith(IN_MAIN);
      });

      it("weights that do not sum to 100, or a score above 100, have no witness", async function () {
        for (const policy of [
          [70n, 50n, 50n, 50n, 50n],
          [70n, 25n, 25n, 25n, 24n],
        ]) {
          const input = circuitInput(att, policy, f.wallets[1].address);
          await expect(witness(f.paths, input)).to.be.rejectedWith(IN_MAIN);
        }
        const big = await f.sign({ scores: [90, 80, 70, 60] });
        const input = circuitInput(big, POLICY, f.wallets[1].address, {
          scores: ["101", "80", "70", "60"],
        });
        await expect(witness(f.paths, input)).to.be.rejectedWith(
          /Assert Failed/,
        );
      });

      it("the prover refuses low scores before proving", async function () {
        const low = await f.sign({ scores: [50, 50, 50, 50] });
        await expect(f.prove(low, f.wallets[1])).to.be.rejectedWith(
          /below the compliance minimum/,
        );
      });

      it("PrivacyManager refuses stale policy signals", async function () {
        await f.pm.setCompliancePolicy(70n, 40n, 20n, 20n, 20n);
        try {
          await expect(
            f.pm
              .connect(f.wallets[1])
              .submitAttestationProof(f.id, r1.proof, r1.signals),
          ).to.be.revertedWithCustomError(f.pm, "StalePolicy");
        } finally {
          await f.pm.setCompliancePolicy(...POLICY);
        }
      });
    });

    describe("C: the wrapper refuses tampered or aliased signals and caches nothing", function () {
      it("every signal tampered, and proof words", async function () {
        await expectTamperedRefused(f.zk, "verifyComplianceAggregation", r1);
      });

      for (const [name, i] of [
        ["minimum", 3],
        ["wJ", 6],
      ]) {
        it(`${name} aliased by + q, which the raw verifier accepts`, async function () {
          const input = circuitInput(att, POLICY, f.wallets[1].address);
          const a = await aliasedProof(f.paths, input, i, 9);
          const raw = await ethers.getContractAt(
            "ComplianceAggregationVerifier",
            await f.zk.complianceVerifier(),
          );
          expect(
            await raw.verifyProof(a.proof, a.signals),
            "precondition",
          ).to.equal(true);
          const COMP = ethers.id("COMPLIANCE_AGGREGATION");
          expect(
            await f.zk.verifyCircuitProof.staticCall(COMP, a.proof, a.signals),
          ).to.equal(false);
          const tx = await f.zk.verifyComplianceAggregation(a.proof, a.signals);
          expect(await cachedEvents(f.zk, tx)).to.have.lengthOf(0);
        });
      }
    });

    describe("D: the PLONK setup property", function () {
      it("signals are [Poseidon(salt, Poseidon(policy)), Ax, Ay, policy, walletBinding]", async function () {
        expect(r1.signals).to.deep.equal([
          f.gen.hash([BigInt(att.salt), f.gen.hash(POLICY)]).toString(),
          att.Ax,
          att.Ay,
          ...POLICY.map(String),
          BigInt(f.wallets[1].address).toString(),
        ]);
        expect(r2.signals[0]).to.equal(r1.signals[0]);
      });

      it("the committed verifier is PLONK with nPublic 9", async function () {
        const artifact = await artifacts.readArtifact(
          "ComplianceAggregationVerifier",
        );
        const fn = artifact.abi.find((x) => x.name === "verifyProof");
        expect(fn.inputs.map((i) => i.type)).to.deep.equal([
          "uint256[24]",
          "uint256[9]",
        ]);
        const vkey = JSON.parse(fs.readFileSync(f.paths.vkey, "utf8"));
        expect([vkey.protocol, vkey.nPublic]).to.deep.equal(["plonk", 9]);
      });

      it("the committed verifier is reproduced from the committed circuit", function () {
        reproducesCommittedVerifier(
          this,
          "compliance_aggregation",
          "ComplianceAggregationVerifier",
        );
      });
    });

    describe("E: a valid proof binds one wallet per attestation per policy", function () {
      it("binds, validates, refuses a second wallet, lapses on a policy change and re-admits", async function () {
        const pm = f.pm;
        const [w1, w2] = [f.wallets[1], f.wallets[2]];
        await pm.connect(w1).submitAttestationProof(f.id, r1.proof, r1.signals);
        expect(
          await pm.validatePrivateCompliance.staticCall(w1.address),
        ).to.equal(true);
        expect((await pm.validateAllPrivateCompliance(w1.address))[3]).to.equal(
          true,
        );
        await expect(
          pm.connect(w2).submitAttestationProof(f.id, r2.proof, r2.signals),
        )
          .to.be.revertedWithCustomError(pm, "AttestationNullifierBound")
          .withArgs(w1.address);

        await pm.setCompliancePolicy(60n, 10n, 30n, 30n, 30n);
        expect(
          await pm.validatePrivateCompliance.staticCall(w1.address),
        ).to.equal(false);
        const r3 = await f.prove(att, w2);
        expect(r3.signals.slice(3, 8)).to.deep.equal([
          "60",
          "10",
          "30",
          "30",
          "30",
        ]);
        await pm.connect(w2).submitAttestationProof(f.id, r3.proof, r3.signals);
        expect(
          await pm.validatePrivateCompliance.staticCall(w2.address),
        ).to.equal(true);
        // Back to the first policy (A -> B -> A): neither old record revives
        // (policy epoch, review 3.7b L1); a fresh submission is required and
        // the nullifier reservation starts over, so w2 may take it now.
        await pm.setCompliancePolicy(...POLICY);
        expect(
          await pm.validatePrivateCompliance.staticCall(w1.address),
        ).to.equal(false);
        expect(
          await pm.validatePrivateCompliance.staticCall(w2.address),
        ).to.equal(false);
        await pm.connect(w2).submitAttestationProof(f.id, r2.proof, r2.signals);
        expect(
          await pm.validatePrivateCompliance.staticCall(w2.address),
        ).to.equal(true);
        await expect(
          pm.connect(w1).submitAttestationProof(f.id, r1.proof, r1.signals),
        )
          .to.be.revertedWithCustomError(pm, "AttestationNullifierBound")
          .withArgs(w2.address);
      });
    });

    describe("F: owner setters", function () {
      it("setCompliancePolicy: owner only, minimum <= 100, weights sum to 100", async function () {
        const pm = f.pm;
        await expect(
          pm.connect(f.wallets[1]).setCompliancePolicy(...POLICY),
        ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
        for (const bad of [
          [101n, 25n, 25n, 25n, 25n],
          [70n, 25n, 25n, 25n, 24n],
          [70n, 101n, 0n, 0n, 0n],
          [70n, 0n, 0n, 0n, 0n],
        ]) {
          await expect(
            pm.setCompliancePolicy(...bad),
          ).to.be.revertedWithCustomError(pm, "InvalidPolicy");
        }
        await expect(pm.setCompliancePolicy(0n, 100n, 0n, 0n, 0n))
          .to.emit(pm, "CompliancePolicyUpdated")
          .withArgs(0n, 100n, 0n, 0n, 0n);
      });
    });
  },
);
