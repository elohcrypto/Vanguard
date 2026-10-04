import { expect } from "chai";
import { ethers } from "hardhat";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { describeProofs } = require("../helpers/zkProofs") as {
  describeProofs: Mocha.PendingSuiteFunction;
};
/**
 * Plan v2 Task 3.7b: demo options 42 -> 3 / 4 / 5 and 44 / 45 / 46 on the
 * live PrivacyManager. Option 1 trusts the session's demo issuer key for the
 * three circuits and sets the default policies; each option signs, proves
 * through scripts/zk/prove-attestation.js and binds the record; success is
 * printed only when the validator reads true, and the views read
 * PrivacyManager state. The issuer key is never printed.
 */
describeProofs(
  "Attestations on the live PrivacyManager (demo options 42 -> 3/4/5, 44-46)",
  function () {
    this.timeout(600_000);

    it("deploys trusted, binds valid records, refuses what the policy refuses", async function () {
      const ContractDeployer = require("../../demo/core/ContractDeployer");
      const DemoState = require("../../demo/core/DemoState");
      const { EnhancedLogger } = require("../../demo/logging");
      const PrivacyModule = require("../../demo/modules/PrivacyModule");
      const ProofGenerator = require("../../demo/utils/ProofGenerator");
      const { CIRCUITS } = require("../../scripts/zk/attest");

      const state = new DemoState();
      if (state.initialize) await state.initialize();
      state.signers = await ethers.getSigners();
      const s = state.signers;
      const answers: string[] = [];
      const privacy = new PrivacyModule(
        state,
        new EnhancedLogger(),
        async () => answers.shift() ?? "",
        new ProofGenerator(state),
      );
      const deployer = new ContractDeployer(state, new EnhancedLogger());

      const logged: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => void logged.push(a.join(" "));
      const step = async (name: string, run: () => Promise<unknown>) => {
        const from = logged.length;
        const r = await run();
        return { r, out: logged.slice(from).join("\n"), name };
      };
      let deploy: any, jur: any, inactive: any, unknown: any, low: any;
      let acc: any, comp: any, v44: any, v45: any, v46: any;
      try {
        deploy = await step("deploy", async () => {
          await deployer.deployAllContracts();
          await deployer.deployDigitalTokenSystem(); // option 21: VSC's rule
        });
        answers.push("1", "840");
        jur = await step("42-3", () =>
          privacy.submitJurisdictionEligibilityProof(),
        );
        answers.push("1", "999");
        unknown = await step("42-3 999", () =>
          privacy.submitJurisdictionEligibilityProof(),
        );
        // Task 3.8: blocking CA (124) for VSC in ComplianceRules is all it
        // takes; PrivacyManager has no list of its own.
        const vsc = await state.getContract("digitalToken").getAddress();
        await state
          .getContract("complianceRules")
          .setJurisdictionRule(vsc, [], [124]);
        answers.push("2", "124");
        inactive = await step("42-3 CA", () =>
          privacy.submitJurisdictionEligibilityProof(),
        );
        answers.push("2", "1");
        low = await step("42-4 low", () =>
          privacy.submitAccreditationStatusProof(),
        );
        answers.push("2", "2");
        acc = await step("42-4", () =>
          privacy.submitAccreditationStatusProof(),
        );
        answers.push("1", "");
        comp = await step("42-5", () =>
          privacy.submitComplianceAggregationProof(),
        );
        v44 = await step("44", () => privacy.verifyJurisdiction());
        v45 = await step("45", () => privacy.verifyAccreditation());
        v46 = await step("46", () => privacy.privacyPreservingValidation());
      } finally {
        console.log = origLog;
      }
      const all = logged.join("\n");
      const pm = state.getContract("privacyManager");

      // Option 1: the demo key is trusted for all three, policies printed.
      for (const c of Object.values(CIRCUITS) as { id: string }[]) {
        expect(await pm.trustedAttestorCount(c.id), deploy.out).to.equal(1n);
      }
      expect(deploy.out).to.contain("Demo attestation issuer");
      expect(deploy.out).to.contain("minimum accreditation 100000");
      expect(state.attestorKey).to.match(/^0x[0-9a-f]{64}$/);
      expect(all).to.not.contain(state.attestorKey.slice(2));

      // 42 -> 3: bound and valid; an unknown code stops; an inactive one is
      // refused by the prover before proving.
      expect(jur.r, jur.out).to.equal(true);
      expect(jur.out).to.contain("JURISDICTION ATTESTATION BOUND AND VALID");
      expect(jur.out).to.contain("validatePrivateJurisdiction");
      expect(deploy.out).to.contain(
        "Private jurisdiction proofs use allowed mask",
      );
      expect(deploy.out).to.contain("rule for VSC");
      expect(unknown.out).to.contain(
        "999 has no jurisdiction bit on PrivacyManager",
      );
      expect(inactive.r, inactive.out).to.equal(false);
      expect(inactive.out).to.contain("not in the allowed mask");
      expect(inactive.out).to.not.contain("BOUND AND VALID");
      // The registry change lapsed wallet 1's jurisdiction record.
      expect(
        await pm.validatePrivateJurisdiction.staticCall(s[1].address),
      ).to.equal(false);

      // 42 -> 4: below the minimum refused, then bound.
      expect(low.r, low.out).to.equal(false);
      expect(low.out).to.contain("below the minimum accreditation");
      expect(acc.r, acc.out).to.equal(true);
      expect(
        await pm.validatePrivateAccreditation.staticCall(s[2].address),
      ).to.equal(true);

      // 42 -> 5: bound and valid; the scores are never printed as signals.
      expect(comp.r, comp.out).to.equal(true);
      expect(
        await pm.validatePrivateCompliance.staticCall(s[1].address),
      ).to.equal(true);

      // 44 / 45 / 46 read PrivacyManager, not events.
      expect(v44.out).to.contain("lapsed: the policy changed since");
      expect(v44.out).to.contain("NO VALID JURISDICTION ATTESTATION");
      expect(v45.out).to.contain(`wallet 2 ${s[2].address}: valid`);
      expect(v46.out).to.contain(
        `wallet 1 ${s[1].address}: whitelist ❌ jurisdiction ❌ accreditation ❌ compliance ✅`,
      );
      expect(v46.out).to.contain(
        `wallet 2 ${s[2].address}: whitelist ❌ jurisdiction ❌ accreditation ✅ compliance ❌`,
      );
    });

    // Phase 3 review B-L7 (fix round L5): options 44-46 tell an untrusted
    // key from a re-trusted one whose record lapsed by epoch.
    it("44-46 status: valid, key untrusted, key re-trusted, policy changed", async function () {
      const {
        deployAttestationFixture,
      } = require("../helpers/attestationFixture");
      const { attestationStatus } = require("../../demo/utils/AttestationFlow");
      const f = await deployAttestationFixture("jurisdiction");
      const w1 = f.wallets[1];
      const r = await f.prove(await f.sign({ mask: 1 }), w1);
      await f.pm.connect(w1).submitAttestationProof(f.id, r.proof, r.signals);
      const state = { getContract: () => f.pm, signers: [f.wallets[0], w1] };
      const status = async () => {
        const lines: string[] = [];
        await attestationStatus({
          state,
          circuit: "jurisdiction",
          log: (m: string) => lines.push(m),
        });
        return lines.join("\n");
      };
      const line = (why: string) => `wallet 1 ${w1.address}: ${why}`;
      expect(await status()).to.contain(line("valid"));
      await f.pm.setTrustedAttestor(f.id, f.Ax, f.Ay, false);
      expect(await status()).to.contain(
        line("lapsed: the issuer key is no longer trusted"),
      );
      await f.pm.setTrustedAttestor(f.id, f.Ax, f.Ay, true);
      expect(await status()).to.contain(
        line(
          "lapsed: the issuer key was untrusted and trusted again since (re-trusting revives no record): prove again",
        ),
      );
      // setPolicyToken bumps the jurisdiction policy epoch.
      await f.pm.setPolicyToken(await f.pm.policyToken());
      expect(await status()).to.contain(
        line("lapsed: the policy changed since"),
      );
    });
  },
);
