import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The demo must not deploy a mock verifier while calling it real.
 *
 * demo/modules/PrivacyModule.js deployed ZKVerifierIntegrated with
 * testingMode = true under the log line "Real ZK Verifiers". In that mode every
 * verify* function skips Groth16 and returns true for any non-zero public
 * signal, so an all-zero proof was accepted. testingMode is immutable, so the
 * deployed instance could never be corrected without redeploying.
 */
describe("ZK deployment mode", function () {
  it("rejects a garbage proof when testingMode is off", async function () {
    const v = await (await ethers.getContractFactory("ZKVerifierIntegrated")).deploy(false);
    const ok = await v.verifyWhitelistMembership.staticCall(
      [0, 0], [[0, 0], [0, 0]], [0, 0], [1]
    );
    expect(ok, "a zero proof must not verify").to.be.false;
  });

  it("accepts a garbage proof when testingMode is on (why it must not be the default)", async function () {
    const v = await (await ethers.getContractFactory("ZKVerifierIntegrated")).deploy(true);
    const ok = await v.verifyWhitelistMembership.staticCall(
      [0, 0], [[0, 0], [0, 0]], [0, 0], [1]
    );
    expect(ok, "testingMode is a mock and must never be the production default").to.be.true;
  });

  it("the demo does not hardcode testingMode on", async function () {
    const src = require("fs").readFileSync("demo/modules/PrivacyModule.js", "utf8");
    const m = src.match(/ZKVerifierIntegratedFactory\.deploy\(([^)]*)\)/);
    expect(m, "ZKVerifierIntegrated deployment not found").to.not.be.null;
    expect(m![1].trim(), "must not be a hardcoded true").to.not.equal("true");
  });

  it("the demo labels mock mode honestly", async function () {
    const src = require("fs").readFileSync("demo/modules/PrivacyModule.js", "utf8");
    // The old log said "Real ZK Verifiers" while deploying the mock. Whatever
    // the wording, it must be derived from the flag, not asserted blindly.
    const claimsRealUnconditionally =
      /Real ZK Verifiers/.test(src) && !/testingMode|zkTestingMode|MOCK/i.test(src);
    expect(claimsRealUnconditionally, "log must reflect the actual mode").to.be.false;
  });

  // Found reviewing PR #4: deploying in real mode set state.zkMode = 'real' but
  // nothing initialised the real proof generator, so every proof action in the
  // default demo crashed on a null generator instead of generating a proof.
  it("the demo initialises the real proof generator before using it (real mode)", async function () {
    this.timeout(120_000);
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    const PrivacyModule = require("../../demo/modules/PrivacyModule");

    const state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    const deployer = new ContractDeployer(state, new EnhancedLogger());

    // A stand-in for ProofGenerator: the only thing the demo may rely on is
    // that initializeRealProofGenerator() populates state.realProofGenerator.
    let generatorUsed = false;
    const fakeProofGenerator = {
      async initializeRealProofGenerator() {
        state.realProofGenerator ??= {
          async generateWhitelistProof() {
            generatorUsed = true;
            return { proof: { a: [0, 0], b: [[0, 0], [0, 0]], c: [0, 0] }, publicSignals: [1] };
          },
        };
      },
    };
    const privacy = new PrivacyModule(state, new EnhancedLogger(), async () => "1", fakeProofGenerator);

    const logged: string[] = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    const prevMode = process.env.ZK_TESTING_MODE;
    delete process.env.ZK_TESTING_MODE; // the default: real verifier
    try {
      await deployer.deployAllContracts();
      await deployer.deployComplianceRules();
      await deployer.deployOracleSystem();
      await privacy.deployPrivacySystem();
      expect(state.zkMode).to.equal("real");
      await privacy.submitWhitelistMembershipProof();
    } finally {
      console.log = origLog; console.error = origErr;
      if (prevMode !== undefined) process.env.ZK_TESTING_MODE = prevMode;
    }

    expect(logged.join("\n")).to.not.match(/Cannot read properties of null/);
    expect(generatorUsed, "real-mode demo must generate through the real generator").to.be.true;
  });
});
