import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

/* eslint-disable @typescript-eslint/no-var-requires */
const { describeProofs } = require("../helpers/zkProofs") as {
  describeProofs: Mocha.SuiteFunction;
};
const {
  JURISDICTION_TOKEN,
  wireJurisdictionSource,
  deployAttestationFixture,
} = require("../helpers/attestationFixture");
const { countryBit } = require("../../scripts/zk/attest");
const { proveAttestation } = require("../../scripts/zk/prove-attestation");
const {
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Plan v2 Task 3.8: the jurisdiction set the private proofs use is the set
 * ComplianceRules enforces for the policy token (VSC in the demo).
 * PrivacyManager keeps only the append-only ISO-code-to-bit assignment
 * issuers attest; ComplianceRules' rule version is part of the policy, so
 * a restored rule revives no record (R-3R-32).
 */
describe("One jurisdiction source (Task 3.8)", function () {
  async function deployPm() {
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    const pm = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(await zk.getAddress());
    return { zk, pm };
  }

  describe("the mask is ComplianceRules' verdict over the registered codes", function () {
    it("no source, no policy; the default blocked list and the token's rule apply", async function () {
      const { pm } = await deployPm();
      expect(await pm.allowedJurisdictionMask()).to.equal(0n);
      const [admin] = await ethers.getSigners();
      // Default rule: allow list [840, 826, 124], sanctions [643].
      const rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(admin.address, [840, 826, 124], [643]);
      await wireJurisdictionSource(pm, [840, 826, 124, 643, 276]);
      await pm.setJurisdictionSource(
        await rules.getAddress(),
        JURISDICTION_TOKEN,
      );
      // 643 blocked by default, 276 outside the default allow list.
      expect(await pm.allowedJurisdictionMask()).to.equal(0b00111n);
      // A token rule with an empty allow list admits 276; 643 stays
      // blocked (the default blocked list always applies), 124 is blocked.
      await rules.setJurisdictionRule(JURISDICTION_TOKEN, [], [124]);
      expect(await pm.allowedJurisdictionMask()).to.equal(0b10011n);
      for (const [code, verdict] of [
        [840, true],
        [124, false],
        [643, false],
        [276, true],
        [36, false], // no bit
      ] as const) {
        expect(await pm.isJurisdictionActive(code), `${code}`).to.equal(
          verdict,
        );
        if (code !== 36) {
          expect(
            (await rules.validateJurisdiction(JURISDICTION_TOKEN, code))[0],
          ).to.equal(verdict);
        }
      }
      expect(await pm.getActiveJurisdictions()).to.deep.equal([
        [840n, 826n, 276n],
        [1n, 2n, 16n],
      ]);
    });

    it("ComplianceRules counts every rule change per token, by governance only", async function () {
      const [admin, stranger] = await ethers.getSigners();
      const rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(admin.address, [], []);
      const t = JURISDICTION_TOKEN;
      expect(await rules.jurisdictionRuleVersion(t)).to.equal(0n);
      await rules.setJurisdictionRule(t, [840], []);
      await rules.setJurisdictionRule(t, [840], []);
      await rules.clearJurisdictionRule(t);
      expect(await rules.jurisdictionRuleVersion(t)).to.equal(3n);
      expect(await rules.jurisdictionRuleVersion(admin.address)).to.equal(0n);
      await expect(
        rules.connect(stranger).setJurisdictionRule(t, [], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
    });
  });

  describe("bits", function () {
    it("a code with no bit cannot be attested until registered; bits never move", async function () {
      const { pm } = await deployPm();
      await wireJurisdictionSource(pm, [840, 276]);
      const lookup = (country: number) =>
        countryBit({
          country,
          privacyManager: pm.target,
          runner: ethers.provider,
        });
      await expect(lookup(702)).to.be.rejectedWith(
        /country 702: no jurisdiction bit on PrivacyManager/,
      );
      expect(await pm.jurisdictionBit(702)).to.equal(0n);
      const epoch = await pm.policyEpoch(ethers.id("JURISDICTION_PROOF"));
      await expect(pm.registerJurisdictionCode(702))
        .to.emit(pm, "JurisdictionCodeRegistered")
        .withArgs(702, 4)
        .and.to.emit(pm, "PolicyEpochBumped");
      expect(await pm.policyEpoch(ethers.id("JURISDICTION_PROOF"))).to.equal(
        epoch + 1n,
      );
      expect(await lookup(702)).to.deep.equal({
        code: 702n,
        bit: 4n,
        active: true,
      });
      for (const c of [36, 124, 250, 392, 756]) {
        await pm.registerJurisdictionCode(c);
      }
      expect(await pm.jurisdictionBit(840)).to.equal(1n);
      expect(await pm.jurisdictionBit(276)).to.equal(2n);
      expect(await pm.jurisdictionBit(702)).to.equal(4n);
      expect(await pm.jurisdictionBit(756)).to.equal(128n);
      expect((await pm.getAllJurisdictions())[0]).to.deep.equal([
        840n,
        276n,
        702n,
        36n,
        124n,
        250n,
        392n,
        756n,
      ]);
    });

    it("refuses the 65th code, zero, non-ISO, repeated codes and strangers", async function () {
      const { pm } = await deployPm();
      const [, stranger] = await ethers.getSigners();
      await wireJurisdictionSource(pm, []);
      for (const bad of [0n, 1000n, BigInt("18446744073709551616")]) {
        await expect(pm.registerJurisdictionCode(bad))
          .to.be.revertedWithCustomError(pm, "InvalidJurisdictionCode")
          .withArgs(bad);
      }
      for (let c = 1; c <= 64; c++) await pm.registerJurisdictionCode(c);
      await expect(pm.registerJurisdictionCode(1))
        .to.be.revertedWithCustomError(pm, "InvalidJurisdictionCode")
        .withArgs(1);
      await expect(
        pm.registerJurisdictionCode(65),
      ).to.be.revertedWithCustomError(pm, "JurisdictionCapacity");
      expect(await pm.jurisdictionBit(64)).to.equal(2n ** 63n);
      expect(await pm.allowedJurisdictionMask()).to.equal(2n ** 64n - 1n);
      await expect(
        pm.connect(stranger).registerJurisdictionCode(100),
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
    });

    it("setJurisdictionSource takes a ComplianceRules and a token, from the owner", async function () {
      const { zk, pm } = await deployPm();
      const [admin, stranger] = await ethers.getSigners();
      const { rules } = await wireJurisdictionSource(pm, []);
      const r = await rules.getAddress();
      for (const [a, t] of [
        [admin.address, JURISDICTION_TOKEN], // not a contract
        [r, ethers.ZeroAddress],
        [await zk.getAddress(), JURISDICTION_TOKEN], // no rule version
      ]) {
        await expect(pm.setJurisdictionSource(a, t)).to.be.reverted;
      }
      await expect(
        pm.connect(stranger).setJurisdictionSource(r, JURISDICTION_TOKEN),
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
      await expect(pm.setJurisdictionSource(r, admin.address))
        .to.emit(pm, "JurisdictionSourceSet")
        .withArgs(r, admin.address);
      expect(await pm.complianceRules()).to.equal(r);
      expect(await pm.policyToken()).to.equal(admin.address);
    });
  });

  describe("the ceremony", function () {
    it("refuses a PrivacyManager reading another ComplianceRules or token", async function () {
      const f = await handoverFixture();
      const { c, args, deployer } = f;
      const vsc = await c.token.getAddress();
      const rules = await c.complianceRules.getAddress();
      const other = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(deployer.address, [], []);
      const refused = async (msg: RegExp) => {
        const nonce = await ethers.provider.getTransactionCount(
          deployer.address,
        );
        await expect(handoverDeployerPowers(args)).to.be.rejectedWith(msg);
        expect(
          await ethers.provider.getTransactionCount(deployer.address),
        ).to.equal(nonce);
      };
      await c.privacyManager.setJurisdictionSource(
        await other.getAddress(),
        vsc,
      );
      await refused(
        new RegExp(
          `reads its jurisdiction policy from ComplianceRules ${await other.getAddress()}, not the ceremony's ${rules}`,
        ),
      );
      const { failures } = await assertHandoverComplete(args);
      expect(failures).to.include(
        `PrivacyManager jurisdiction source: ComplianceRules ${rules}`,
      );
      const vgt = await c.governanceToken.getAddress();
      await c.privacyManager.setJurisdictionSource(rules, vgt);
      await refused(
        new RegExp(
          `takes its jurisdiction policy from token ${vgt}, not VSC ${vsc}`,
        ),
      );
      await c.privacyManager.setJurisdictionSource(rules, vsc);
      await c.privacyManager.registerJurisdictionCode(840);
      const { checks } = await assertHandoverComplete(args);
      const passed = checks.filter((x: any) => x.ok).map((x: any) => x.label);
      expect(passed).to.include.members([
        `PrivacyManager jurisdiction source: ComplianceRules ${rules}`,
        `PrivacyManager jurisdiction policy token: VSC ${vsc}`,
        "PrivacyManager jurisdiction bits registered: 1",
      ]);
    });
  });

  // One proof, made once: US (840, bit 1) under mask 15.
  describeProofs(
    "real proofs: a blocked country lapses, a restore revives nothing",
    function () {
      this.timeout(600000);
      let f: any;
      let att: any;
      let r1: any;
      const JUR = ethers.id("JURISDICTION_PROOF");

      before(async function () {
        f = await deployAttestationFixture("jurisdiction");
        att = await f.sign({ mask: await f.pm.jurisdictionBit(840) });
        r1 = await f.prove(att, f.wallets[1]);
      });

      it("blocking US in ComplianceRules alone rejects the US attestation", async function () {
        const { pm, rules, token, wallets } = f;
        const w1 = wallets[1];
        await pm.connect(w1).submitAttestationProof(JUR, r1.proof, r1.signals);
        expect(await pm.validatePrivateJurisdiction.staticCall(w1.address)).to
          .be.true;
        const epoch = await pm.policyEpoch(JUR);

        // A: [no token rule]. B: US blocked for the token. Nothing is called
        // on PrivacyManager.
        await rules.setJurisdictionRule(token, [], [840]);
        expect(await pm.policyEpoch(JUR)).to.equal(epoch);
        expect(await pm.allowedJurisdictionMask()).to.equal(14n);
        expect(await pm.isJurisdictionActive(840)).to.equal(false);
        expect(await pm.validatePrivateJurisdiction.staticCall(w1.address)).to
          .be.false;
        await expect(
          pm.connect(w1).submitAttestationProof(JUR, r1.proof, r1.signals),
        ).to.be.revertedWithCustomError(pm, "StalePolicy");
        // A fresh proof cannot be made: the bit is outside the allowed mask.
        await expect(
          proveAttestation({
            attestation: att,
            wallet: w1.address,
            privacyManager: pm.target,
            runner: w1,
            generator: f.gen,
          }),
        ).to.be.rejectedWith(/not in the allowed mask/);

        // Back to A: the mask is 15 again, but the record made under the
        // first A stays lapsed (rule version); re-proving re-admits.
        await rules.clearJurisdictionRule(token);
        expect(await pm.allowedJurisdictionMask()).to.equal(15n);
        expect(await rules.jurisdictionRuleVersion(token)).to.equal(2n);
        expect((await pm.getUserProofInfo(w1.address, JUR)).isValid).to.equal(
          false,
        );
        await pm.connect(w1).submitAttestationProof(JUR, r1.proof, r1.signals);
        expect((await pm.getUserProofInfo(w1.address, JUR)).isValid).to.equal(
          true,
        );
        // A change that leaves US allowed still starts a new policy.
        await rules.setJurisdictionRule(token, [], [124]);
        expect((await pm.getUserProofInfo(w1.address, JUR)).isValid).to.equal(
          false,
        );
      });
    },
  );
});
