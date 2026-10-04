const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { deployAttestationFixture } = require("../helpers/attestationFixture");
const { signAttestation } = require("../../scripts/zk/attest");
const { describeProofs } = require("../helpers/zkProofs");

// Task 3.10 (D32 a, Phase 3 review A-M1): an issuer attestation carries the
// expiry the issuer signed (validUntil, a public signal); PrivacyManager
// refuses the proof from then on and no record outlives it, so a lapsed
// accreditation cannot be re-proved with old calldata. Real PLONK proofs on
// a real-mode wrapper; the CLIs refuse a missing, past or lapsed expiry.
const MIN = 100000n;
const DAY = 86400n;
const ROOT = path.join(__dirname, "../..");
const run = (script, args, env = {}) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.join(ROOT, "scripts/zk", script), ...args],
      { cwd: ROOT, env: { ...process.env, ...env } },
      (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr }),
    ),
  );
const now = async () =>
  BigInt((await ethers.provider.getBlock("latest")).timestamp);
const setNextTime = (t) =>
  ethers.provider.send("evm_setNextBlockTimestamp", [Number(t)]);

describeProofs("Attestation lifetime (Task 3.10)", function () {
  this.timeout(600000);

  let f;
  let w1;

  before(async function () {
    f = await deployAttestationFixture("accreditation");
    await f.pm.setMinimumAccreditation(MIN);
    w1 = f.wallets[1];
  });

  describe("on chain", function () {
    it("caps the record's expiresAt at validUntil when it is sooner than proofValidityPeriod", async function () {
      const period = await f.pm.proofValidityPeriod();
      const validUntil = (await now()) + 10n * DAY;
      expect(validUntil < (await now()) + period, "precondition").to.equal(
        true,
      );
      const att = await f.sign({ amount: 250000, validUntil });
      const r = await f.prove(att, w1);
      expect(r.signals[5]).to.equal(validUntil.toString());
      const tx = await f.pm
        .connect(w1)
        .submitAttestationProof(f.id, r.proof, r.signals);
      const rec = await f.pm.attestationRecords(w1.address, f.id);
      expect(rec.expiresAt).to.equal(validUntil);
      await expect(tx)
        .to.emit(f.pm, "AttestationProofBound")
        .withArgs(w1.address, f.id, r.signals[0], rec.policyHash, validUntil);

      // A later validUntil leaves proofValidityPeriod as the bound.
      const later = await f.sign({ amount: 250000 }); // one year
      const r2 = await f.prove(later, w1);
      const rx = await (
        await f.pm
          .connect(w1)
          .submitAttestationProof(f.id, r2.proof, r2.signals)
      ).wait();
      const ts = BigInt(
        (await ethers.provider.getBlock(rx.blockNumber)).timestamp,
      );
      expect(
        (await f.pm.attestationRecords(w1.address, f.id)).expiresAt,
      ).to.equal(ts + period);
    });

    it("refuses a real proof with AttestationExpired from validUntil on, before the policy check", async function () {
      const validUntil = (await now()) + 2n * DAY;
      const att = await f.sign({ amount: 250000, validUntil });
      const r = await f.prove(att, w1);
      // The wrapper accepts the proof itself: only PrivacyManager refuses.
      expect(
        await f.zk.verifyAccreditationProof.staticCall(r.proof, r.signals),
      ).to.equal(true);
      await setNextTime(validUntil); // block.timestamp == validUntil
      await expect(
        f.pm.connect(w1).submitAttestationProof(f.id, r.proof, r.signals),
      )
        .to.be.revertedWithCustomError(f.pm, "AttestationExpired")
        .withArgs(validUntil);
      // Checked before the policy: a stale policy still reads expired.
      await f.pm.setMinimumAccreditation(MIN + 1n);
      try {
        await expect(
          f.pm.connect(w1).submitAttestationProof(f.id, r.proof, r.signals),
        ).to.be.revertedWithCustomError(f.pm, "AttestationExpired");
      } finally {
        await f.pm.setMinimumAccreditation(MIN);
      }
      // The prover refuses it too, on the chain's time, before proving.
      await expect(f.prove(att, w1)).to.be.rejectedWith(
        `the attestation expired on ${new Date(Number(validUntil) * 1000).toISOString()}`,
      );
    });

    // Review A-M1 probe P2: the same calldata re-recorded as valid after
    // 400 days. Now the record lapses at validUntil and the resubmission
    // reverts.
    it("P2: the same proof calldata resubmitted after validUntil reverts", async function () {
      const att = await f.sign({ amount: 250000 }); // one year
      const r = await f.prove(att, w1);
      await f.pm.connect(w1).submitAttestationProof(f.id, r.proof, r.signals);
      expect((await f.pm.getUserProofInfo(w1.address, f.id)).isValid).to.equal(
        true,
      );
      await ethers.provider.send("evm_increaseTime", [400 * 86400]);
      await ethers.provider.send("evm_mine", []);
      const info = await f.pm.getUserProofInfo(w1.address, f.id);
      expect([info.isValid, info.isExpired]).to.deep.equal([false, true]);
      await expect(
        f.pm.connect(w1).submitAttestationProof(f.id, r.proof, r.signals),
      )
        .to.be.revertedWithCustomError(f.pm, "AttestationExpired")
        .withArgs(BigInt(att.validUntil));
      expect(
        await f.pm.validatePrivateAccreditation.staticCall(w1.address),
      ).to.equal(false);
      // A new attestation renews it.
      const renewed = await f.sign({ amount: 250000 });
      const r2 = await f.prove(renewed, w1);
      await f.pm.connect(w1).submitAttestationProof(f.id, r2.proof, r2.signals);
      expect(
        await f.pm.validatePrivateAccreditation.staticCall(w1.address),
      ).to.equal(true);
    });
  });

  describe("CLIs", function () {
    const identity = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const PMX = "0x" + "11".repeat(20);
    let tmp;

    before(function () {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "att-life-"));
    });
    after(function () {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("attest.js --sign refuses without a validity, with both, and with a past date", async function () {
      const base = [
        "--sign",
        "--identity",
        identity,
        "--circuit",
        "accreditation",
        "--amount",
        "5",
        "--chain-id",
        "31337",
        "--privacy-manager",
        PMX,
      ];
      for (const [args, re] of [
        [[], /the issuer sets the expiry/],
        [
          ["--valid-days", "1", "--valid-until", "2099-01-01"],
          /the issuer sets the expiry/,
        ],
        [
          ["--valid-until", "2020-01-01"],
          /--valid-until 2020-01-01T00:00:00.000Z is not in the future/,
        ],
        [["--valid-days", "0"], /--valid-days: a whole number of days/],
        [["--valid-until", "someday"], /not an ISO date/],
      ]) {
        const r = await run("attest.js", [...base, ...args], {
          ATTESTOR_KEY: f.key,
        });
        expect(r.code, args.join(" ")).to.equal(1);
        expect(r.stderr, args.join(" ")).to.match(re);
        expect(r.stdout).to.equal("");
        expect(r.stderr).to.not.include(f.key.slice(2));
      }
      const ok = await run(
        "attest.js",
        [...base, "--valid-until", "2099-01-01T00:00:00Z"],
        { ATTESTOR_KEY: f.key },
      );
      expect(ok.code, ok.stderr).to.equal(0);
      expect(JSON.parse(ok.stdout).validUntil).to.equal(
        String(Date.UTC(2099, 0, 1) / 1000),
      );
      expect(ok.stderr).to.match(/attestation expires 2099-01-01T00:00:00/);
    });

    it("prove-attestation.js refuses an expired attestation before proving, naming the date", async function () {
      const past = Math.floor(Date.now() / 1000) - 86400;
      const old = await signAttestation({
        key: f.key,
        chainId: 31337,
        privacyManager: PMX,
        validUntil: past,
        circuit: "accreditation",
        identity,
        amount: 250000,
      });
      const file = path.join(tmp, "expired.json");
      fs.writeFileSync(file, JSON.stringify(old));
      const r = await run("prove-attestation.js", [
        "--attestation",
        file,
        "--wallet",
        w1.address,
        "--minimum",
        MIN.toString(),
      ]);
      expect(r.code).to.equal(1);
      expect(r.stderr).to.include(
        `the attestation expired on ${new Date(past * 1000).toISOString()}`,
      );
      expect(r.stderr, "no proving started").to.not.match(/Generating/);
      expect(r.stdout).to.equal("");
      for (const k of ["salt", "R8x", "R8y", "S"]) {
        expect(r.stderr, k).to.not.include(old[k]);
      }
      // A validity is required in the attestation itself.
      const { validUntil, ...bare } = old;
      expect(validUntil).to.equal(String(past));
      fs.writeFileSync(file + "2", JSON.stringify(bare));
      const none = await run("prove-attestation.js", [
        "--attestation",
        file + "2",
        "--wallet",
        w1.address,
        "--minimum",
        MIN.toString(),
      ]);
      expect(none.stderr).to.match(/validUntil: required/);
    });
  });
});
