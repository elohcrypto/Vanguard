const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const {
  IN_SIGNATURE,
  deployAttestationFixture,
  wireJurisdictionSource,
  circuitInput,
  witness,
  cachedEvents,
  aliasedProof,
  reproducesCommittedVerifier,
  expectTamperedRefused,
} = require("../helpers/attestationFixture");
const { signAttestation } = require("../../scripts/zk/attest");

const { describeProofs } = require("../helpers/zkProofs");
// Task 3.7b (D31 a): the jurisdiction proof states "a trusted issuer signed
// this identity's jurisdiction bit, and that bit is in PrivacyManager's
// allowed mask" (the codes ComplianceRules allows on the policy token, 3.8). A-F mirror the whitelist guards in ZKSoundness.test.js.
// Proofs are generated once in `before` and reused.
const IN_MAIN = /Assert Failed\. Error in template JurisdictionProof/;

describeProofs("Jurisdiction attestation soundness (Task 3.7b)", function () {
  this.timeout(600000);

  let f; // fixture
  let att; // US (840, bit 1), signed by the trusted issuer
  let r1; // wallet 1's proof under the default policy (mask 15)
  let r2; // the same attestation bound to wallet 2

  before(async function () {
    f = await deployAttestationFixture("jurisdiction");
    att = await f.sign({ mask: 1 });
    r1 = await f.prove(att, f.wallets[1]);
    r2 = await f.prove(att, f.wallets[2]);
  });

  describe("A: forged or untrusted signatures", function () {
    it("a signature by another key under the trusted (Ax, Ay) has no witness", async function () {
      const other = await f.sign(
        { mask: 1 },
        ethers.hexlify(ethers.randomBytes(32)),
      );
      const input = circuitInput(other, [15n], f.wallets[1].address, {
        Ax: att.Ax,
        Ay: att.Ay,
      });
      await expect(witness(f.paths, input)).to.be.rejectedWith(IN_SIGNATURE);
    });

    it("a changed attribute or identity breaks the signature", async function () {
      for (const o of [
        { userMask: "2" },
        { identity: "1234" },
        { salt: "7" },
      ]) {
        const input = circuitInput(att, [15n], f.wallets[1].address, o);
        await expect(
          witness(f.paths, input),
          JSON.stringify(o),
        ).to.be.rejectedWith(IN_SIGNATURE);
      }
    });

    it("an accreditation attestation of amount 1 is not a mask-1 attestation (domain)", async function () {
      const acc = await signAttestation({
        key: f.key,
        circuit: "accreditation",
        identity: att.identity,
        amount: 1,
      });
      const input = circuitInput(
        { ...acc, circuit: "jurisdiction", attributes: ["1"] },
        [15n],
        f.wallets[1].address,
      );
      await expect(witness(f.paths, input)).to.be.rejectedWith(IN_SIGNATURE);
    });

    it("PrivacyManager refuses an untrusted (Ax, Ay), before the verifier", async function () {
      const pm = f.pm;
      await pm.setTrustedAttestor(f.id, f.Ax, f.Ay, false);
      try {
        await expect(
          pm
            .connect(f.wallets[1])
            .submitAttestationProof(f.id, r1.proof, r1.signals),
        )
          .to.be.revertedWithCustomError(pm, "UntrustedAttestor")
          .withArgs(f.id, f.attestor);
        // The prover refuses before proving, too.
        await expect(f.prove(att, f.wallets[1])).to.be.rejectedWith(
          /not trusted/,
        );
      } finally {
        await pm.setTrustedAttestor(f.id, f.Ax, f.Ay, true);
      }
    });
  });

  describe("B: policy mismatches", function () {
    it("a mask bit outside allowedMask has no witness", async function () {
      const input = circuitInput(att, [14n], f.wallets[1].address);
      await expect(witness(f.paths, input)).to.be.rejectedWith(IN_MAIN);
    });

    it("a mask with two bits (or none) has no witness", async function () {
      for (const mask of [3, 0]) {
        const input = circuitInput(att, [15n], f.wallets[1].address, {
          userMask: String(mask),
        });
        await expect(
          witness(f.paths, input),
          `mask ${mask}`,
        ).to.be.rejectedWith(/Assert Failed/);
      }
    });

    it("PrivacyManager refuses stale policy signals", async function () {
      const pm = f.pm;
      // CA (124, bit 8) blocked in ComplianceRules for the policy token.
      await f.rules.setJurisdictionRule(f.token, [], [124]);
      try {
        expect(await pm.allowedJurisdictionMask()).to.equal(7n);
        await expect(
          pm
            .connect(f.wallets[1])
            .submitAttestationProof(f.id, r1.proof, r1.signals),
        ).to.be.revertedWithCustomError(pm, "StalePolicy");
        // The prover refuses an explicit policy that is not the chain's.
        await expect(
          require("../../scripts/zk/prove-attestation").proveAttestation({
            attestation: att,
            wallet: f.wallets[1].address,
            policy: [15n],
            privacyManager: pm.target,
            runner: f.wallets[1],
            generator: f.gen,
          }),
        ).to.be.rejectedWith(/stale policy/);
      } finally {
        await f.rules.clearJurisdictionRule(f.token);
      }
      expect(await pm.allowedJurisdictionMask()).to.equal(15n);
    });
  });

  describe("C: the wrapper refuses tampered or aliased signals and caches nothing", function () {
    it("every signal tampered, and proof words", async function () {
      await expectTamperedRefused(f.zk, "verifyJurisdictionProof", r1);
    });

    for (const [name, i] of [
      ["nullifier", 0],
      ["walletBinding", 4],
    ]) {
      it(`${name} aliased by + q, which the raw verifier accepts`, async function () {
        const input = circuitInput(att, [15n], f.wallets[1].address);
        const a = await aliasedProof(f.paths, input, i, 5);
        const raw = await ethers.getContractAt(
          "JurisdictionProofVerifier",
          await f.zk.jurisdictionVerifier(),
        );
        expect(
          await raw.verifyProof(a.proof, a.signals),
          "precondition",
        ).to.equal(true);
        const [before] = await f.zk.getCircuitStats("jurisdiction");
        expect(
          await f.zk.verifyJurisdictionProof.staticCall(a.proof, a.signals),
        ).to.equal(false);
        const tx = await f.zk.verifyJurisdictionProof(a.proof, a.signals);
        expect(await cachedEvents(f.zk, tx)).to.have.lengthOf(0);
        expect((await f.zk.getCircuitStats("jurisdiction"))[0]).to.equal(
          before,
        );
      });
    }
  });

  describe("D: the PLONK setup property", function () {
    it("signals are [Poseidon(salt, allowedMask), Ax, Ay, allowedMask, walletBinding]", async function () {
      expect(r1.proof).to.have.lengthOf(24);
      expect(r1.signals).to.deep.equal([
        f.gen.hash([BigInt(att.salt), 15n]).toString(),
        att.Ax,
        att.Ay,
        "15",
        BigInt(f.wallets[1].address).toString(),
      ]);
      expect(
        r2.signals[0],
        "one nullifier per attestation per policy",
      ).to.equal(r1.signals[0]);
    });

    it("the committed verifier is PLONK with nPublic 5", async function () {
      const artifact = await artifacts.readArtifact(
        "JurisdictionProofVerifier",
      );
      const fn = artifact.abi.find((x) => x.name === "verifyProof");
      expect(fn.inputs.map((i) => i.type)).to.deep.equal([
        "uint256[24]",
        "uint256[5]",
      ]);
      const vkey = JSON.parse(fs.readFileSync(f.paths.vkey, "utf8"));
      expect([vkey.protocol, vkey.nPublic]).to.deep.equal(["plonk", 5]);
    });

    it("the committed verifier is reproduced from the committed circuit", function () {
      reproducesCommittedVerifier(
        this,
        "jurisdiction_proof",
        "JurisdictionProofVerifier",
      );
    });
  });

  describe("E: a valid proof binds one wallet per attestation per policy", function () {
    it("binds, validates, refuses a second wallet, lapses on a policy change and re-admits", async function () {
      const pm = f.pm;
      const [w1, w2] = [f.wallets[1], f.wallets[2]];
      // A copied proof is refused for any other wallet.
      await expect(
        pm.connect(w2).submitAttestationProof(f.id, r1.proof, r1.signals),
      ).to.be.revertedWithCustomError(pm, "WalletBindingMismatch");

      const tx = await pm
        .connect(w1)
        .submitAttestationProof(f.id, r1.proof, r1.signals);
      const rec = await pm.attestationRecords(w1.address, f.id);
      await expect(tx)
        .to.emit(pm, "AttestationProofBound")
        .withArgs(
          w1.address,
          f.id,
          r1.signals[0],
          rec.policyHash,
          rec.expiresAt,
        );
      console.log(
        `      submitAttestationProof gasUsed: ${(await tx.wait()).gasUsed}`,
      );
      expect(rec.policyHash).to.equal(await pm.currentPolicyHash(f.id));
      expect(rec.attestor).to.equal(f.attestor);
      expect(
        await pm.validatePrivateJurisdiction.staticCall(w1.address),
      ).to.equal(true);
      expect((await pm.validateAllPrivateCompliance(w1.address))[1]).to.equal(
        true,
      );
      expect((await pm.getUserProofInfo(w1.address, f.id)).isValid).to.equal(
        true,
      );

      // The same attestation for a second wallet: same nullifier, refused.
      await expect(
        pm.connect(w2).submitAttestationProof(f.id, r2.proof, r2.signals),
      )
        .to.be.revertedWithCustomError(pm, "AttestationNullifierBound")
        .withArgs(w1.address);

      // The user's preference flag sits on top.
      await pm.connect(w1).setUserPrivacySettings({
        enablePrivateWhitelist: true,
        enablePrivateJurisdiction: false,
        enablePrivateAccreditation: true,
        enablePrivateCompliance: true,
        proofValidityPeriod: 86400,
      });
      expect(
        await pm.validatePrivateJurisdiction.staticCall(w1.address),
      ).to.equal(false);

      // Revoking the issuer lapses the record; re-trusting the key does not
      // revive it (attestor epoch, review 3.7b L1): the holder resubmits.
      await pm.setTrustedAttestor(f.id, f.Ax, f.Ay, false);
      expect((await pm.getUserProofInfo(w1.address, f.id)).isValid).to.equal(
        false,
      );
      await pm.setTrustedAttestor(f.id, f.Ax, f.Ay, true);
      expect((await pm.getUserProofInfo(w1.address, f.id)).isValid).to.equal(
        false,
      );
      await pm.connect(w1).submitAttestationProof(f.id, r1.proof, r1.signals);
      expect((await pm.getUserProofInfo(w1.address, f.id)).isValid).to.equal(
        true,
      );

      // A policy change lapses it and frees the attestation for a re-prove.
      await pm.registerJurisdictionCode(702); // Singapore, bit 16
      expect(await pm.allowedJurisdictionMask()).to.equal(31n);
      expect((await pm.getUserProofInfo(w1.address, f.id)).isValid).to.equal(
        false,
      );
      const r3 = await f.prove(att, w2);
      expect(r3.signals[3]).to.equal("31");
      expect(r3.signals[0]).to.not.equal(r1.signals[0]);
      await pm.connect(w2).submitAttestationProof(f.id, r3.proof, r3.signals);
      expect(
        await pm.validatePrivateJurisdiction.staticCall(w2.address),
      ).to.equal(true);
    });
  });

  describe("F: owner setters", function () {
    it("only the owner sets trust; keys and circuits are checked", async function () {
      const pm = f.pm;
      await expect(
        pm.connect(f.wallets[1]).setTrustedAttestor(f.id, 1, 2, true),
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
      // Zero, the identity point (0, 1), an off-curve pair and a
      // coordinate at the field order are refused (review 3.7b L3).
      const P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      for (const [x, y] of [
        [0n, 2n],
        [0n, 1n],
        [1n, 2n],
        [BigInt(f.Ax) + 1n, BigInt(f.Ay)],
        [BigInt(f.Ax) + P, BigInt(f.Ay)],
      ]) {
        await expect(
          pm.setTrustedAttestor(f.id, x, y, true),
          `${x}, ${y}`,
        ).to.be.revertedWithCustomError(pm, "InvalidAttestorKey");
      }
      const WL = ethers.id("WHITELIST_MEMBERSHIP");
      await expect(pm.setTrustedAttestor(WL, 1, 2, true))
        .to.be.revertedWithCustomError(pm, "NotAttestationCircuit")
        .withArgs(WL);
      expect(await pm.trustedAttestorCount(f.id)).to.equal(1n);
      await pm.setTrustedAttestor(f.id, f.Ax, f.Ay, true); // idempotent
      expect(await pm.trustedAttestorCount(f.id)).to.equal(1n);
    });

    it("bits stop at 64 codes, the width the circuit carries", async function () {
      const pm = await (
        await ethers.getContractFactory("PrivacyManager")
      ).deploy(await f.zk.getAddress());
      // Bits 2^0 .. 2^63 for codes 1 .. 64.
      await wireJurisdictionSource(
        pm,
        Array.from({ length: 64 }, (_, i) => i + 1),
      );
      await expect(
        pm.registerJurisdictionCode(65),
      ).to.be.revertedWithCustomError(pm, "JurisdictionCapacity");
      expect(await pm.allowedJurisdictionMask()).to.equal(2n ** 64n - 1n);
    });
  });
});
