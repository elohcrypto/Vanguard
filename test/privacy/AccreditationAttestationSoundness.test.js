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
const { proveAttestation } = require("../../scripts/zk/prove-attestation");

const { describeProofs } = require("../helpers/zkProofs");
// Task 3.7b (D31 a): the accreditation proof states "a trusted issuer signed
// this identity's accreditation amount, and it is at least PrivacyManager's
// minimum". The old self-attested "issuer signature" (Poseidon over the
// issuer's PUBLIC key) is gone. A-F as in JurisdictionAttestationSoundness.
const IN_MAIN = /Assert Failed\. Error in template AccreditationProof/;
const MIN = 100000n;

describeProofs("Accreditation attestation soundness (Task 3.7b)", function () {
  this.timeout(600000);

  let f;
  let att; // amount 250000
  let r1; // bound to wallet 1, minimum 100000
  let r2; // same attestation, wallet 2

  before(async function () {
    f = await deployAttestationFixture("accreditation");
    await f.pm.setMinimumAccreditation(MIN);
    att = await f.sign({ amount: 250000 });
    r1 = await f.prove(att, f.wallets[1]);
    r2 = await f.prove(att, f.wallets[2]);
  });

  describe("A: forged or untrusted signatures", function () {
    it("a signature by another key under the trusted (Ax, Ay) has no witness", async function () {
      const other = await f.sign(
        { amount: 250000 },
        ethers.hexlify(ethers.randomBytes(32)),
      );
      const input = circuitInput(other, [MIN], f.wallets[1].address, {
        Ax: att.Ax,
        Ay: att.Ay,
      });
      await expect(witness(f.paths, input)).to.be.rejectedWith(IN_SIGNATURE);
    });

    it("a raised amount breaks the signature", async function () {
      const input = circuitInput(att, [MIN], f.wallets[1].address, {
        amount: "9999999",
      });
      await expect(witness(f.paths, input)).to.be.rejectedWith(IN_SIGNATURE);
    });

    it("the old scheme's 'signature' (a hash of public values) is no input at all", async function () {
      const input = circuitInput(att, [MIN], f.wallets[1].address, {
        issuerSignature: ["1", "2"],
      });
      await expect(witness(f.paths, input)).to.be.rejectedWith(
        /issuerSignature|Too many values|Signal not found/,
      );
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
    it("an amount below the minimum has no witness", async function () {
      const input = circuitInput(att, [250001n], f.wallets[1].address);
      await expect(witness(f.paths, input)).to.be.rejectedWith(IN_MAIN);
    });

    it("a minimum of 2^64 or more has no witness (range)", async function () {
      const input = circuitInput(att, [2n ** 64n], f.wallets[1].address);
      await expect(witness(f.paths, input)).to.be.rejectedWith(/Assert Failed/);
    });

    it("the prover refuses an amount below the chain's minimum before proving", async function () {
      const low = await f.sign({ amount: 99999 });
      await expect(f.prove(low, f.wallets[1])).to.be.rejectedWith(
        /below the minimum accreditation/,
      );
    });

    it("PrivacyManager refuses stale policy signals and an unset policy", async function () {
      const pm = f.pm;
      await pm.setMinimumAccreditation(MIN + 1n);
      try {
        await expect(
          pm
            .connect(f.wallets[1])
            .submitAttestationProof(f.id, r1.proof, r1.signals),
        ).to.be.revertedWithCustomError(pm, "StalePolicy");
      } finally {
        await pm.setMinimumAccreditation(MIN);
      }
      const fresh = await (
        await ethers.getContractFactory("PrivacyManager")
      ).deploy(await f.zk.getAddress());
      await fresh.setTrustedAttestor(f.id, f.Ax, f.Ay, true);
      await expect(
        fresh
          .connect(f.wallets[1])
          .submitAttestationProof(f.id, r1.proof, r1.signals),
      )
        .to.be.revertedWithCustomError(fresh, "PolicyNotSet")
        .withArgs(f.id);
    });
  });

  describe("C: the wrapper refuses tampered or aliased signals and caches nothing", function () {
    it("every signal tampered, and proof words", async function () {
      await expectTamperedRefused(f.zk, "verifyAccreditationProof", r1);
    });

    for (const [name, i] of [
      ["Ax", 1],
      ["minimumAccreditation", 3],
    ]) {
      it(`${name} aliased by + q, which the raw verifier accepts`, async function () {
        const input = circuitInput(att, [MIN], f.wallets[1].address);
        const a = await aliasedProof(f.paths, input, i, 5);
        const raw = await ethers.getContractAt(
          "AccreditationProofVerifier",
          await f.zk.accreditationVerifier(),
        );
        expect(
          await raw.verifyProof(a.proof, a.signals),
          "precondition",
        ).to.equal(true);
        expect(
          await f.zk.verifyAccreditationProof.staticCall(a.proof, a.signals),
        ).to.equal(false);
        const tx = await f.zk.verifyAccreditationProof(a.proof, a.signals);
        expect(await cachedEvents(f.zk, tx)).to.have.lengthOf(0);
      });
    }
  });

  describe("D: the PLONK setup property", function () {
    it("signals are [Poseidon(salt, minimum), Ax, Ay, minimum, walletBinding]", async function () {
      expect(r1.signals).to.deep.equal([
        f.gen.hash([BigInt(att.salt), MIN]).toString(),
        att.Ax,
        att.Ay,
        MIN.toString(),
        BigInt(f.wallets[1].address).toString(),
      ]);
      expect(r2.signals[0]).to.equal(r1.signals[0]);
      expect(r1.signals, "the amount is not disclosed").to.not.include(
        "250000",
      );
    });

    it("the committed verifier is PLONK with nPublic 5", async function () {
      const artifact = await artifacts.readArtifact(
        "AccreditationProofVerifier",
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
        "accreditation_proof",
        "AccreditationProofVerifier",
      );
    });
  });

  describe("E: a valid proof binds one wallet per attestation per policy", function () {
    it("binds, validates, refuses a second wallet, lapses on a policy change and re-admits", async function () {
      const pm = f.pm;
      const [w1, w2] = [f.wallets[1], f.wallets[2]];
      await pm.connect(w1).submitAttestationProof(f.id, r1.proof, r1.signals);
      expect(
        await pm.validatePrivateAccreditation.staticCall(w1.address),
      ).to.equal(true);
      expect((await pm.validateAllPrivateCompliance(w1.address))[2]).to.equal(
        true,
      );
      await expect(
        pm.connect(w2).submitAttestationProof(f.id, r2.proof, r2.signals),
      )
        .to.be.revertedWithCustomError(pm, "AttestationNullifierBound")
        .withArgs(w1.address);
      // Resubmitting refreshes the caller's own record.
      await pm.connect(w1).submitAttestationProof(f.id, r1.proof, r1.signals);

      // Expiry lapses the record.
      const validity = await pm.proofValidityPeriod();
      await ethers.provider.send("evm_increaseTime", [Number(validity)]);
      await ethers.provider.send("evm_mine", []);
      const info = await pm.getUserProofInfo(w1.address, f.id);
      expect([info.isValid, info.isExpired]).to.deep.equal([false, true]);

      await pm.setMinimumAccreditation(200000n);
      const r3 = await proveAttestation({
        attestation: att,
        wallet: w2.address,
        privacyManager: pm.target,
        runner: w2,
        generator: f.gen,
      });
      expect(r3.signals[3]).to.equal("200000");
      await pm.connect(w2).submitAttestationProof(f.id, r3.proof, r3.signals);
      expect(
        await pm.validatePrivateAccreditation.staticCall(w2.address),
      ).to.equal(true);
    });
  });

  describe("F: owner setters", function () {
    it("setMinimumAccreditation: owner only, in (0, 2^64), with an event", async function () {
      const pm = f.pm;
      await expect(
        pm.connect(f.wallets[1]).setMinimumAccreditation(5),
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
      for (const bad of [0n, 2n ** 64n]) {
        await expect(
          pm.setMinimumAccreditation(bad),
        ).to.be.revertedWithCustomError(pm, "InvalidPolicy");
      }
      const prev = await pm.minimumAccreditation();
      await expect(pm.setMinimumAccreditation(2n ** 64n - 1n))
        .to.emit(pm, "AccreditationPolicyUpdated")
        .withArgs(prev, 2n ** 64n - 1n);
    });
  });
});
