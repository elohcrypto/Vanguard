import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Plan v2 Task 3.7b: demo options 42 -> 3 / 4 / 5 and 44 / 45 / 46 on the
 * live PrivacyManager. Option 1 trusts the session's demo issuer key for the
 * three circuits and sets the default policies; each option signs, proves
 * through scripts/zk/prove-attestation.js and binds the record; success is
 * printed only when the validator reads true, and the views read
 * PrivacyManager state. The issuer key is never printed.
 */
describe("Attestations on the live PrivacyManager (demo options 42 -> 3/4/5, 44-46)", function () {
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
      deploy = await step("deploy", () => deployer.deployAllContracts());
      answers.push("1", "US");
      jur = await step("42-3", () =>
        privacy.submitJurisdictionEligibilityProof(),
      );
      answers.push("1", "ZZ");
      unknown = await step("42-3 ZZ", () =>
        privacy.submitJurisdictionEligibilityProof(),
      );
      await state
        .getContract("privacyManager")
        .updateJurisdictionStatus("CA", false);
      answers.push("2", "CA");
      inactive = await step("42-3 CA", () =>
        privacy.submitJurisdictionEligibilityProof(),
      );
      answers.push("2", "1");
      low = await step("42-4 low", () =>
        privacy.submitAccreditationStatusProof(),
      );
      answers.push("2", "2");
      acc = await step("42-4", () => privacy.submitAccreditationStatusProof());
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
    expect(unknown.out).to.contain(
      "ZZ is not in PrivacyManager's jurisdiction registry",
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
});
