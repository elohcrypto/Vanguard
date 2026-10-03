import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The demo must not deploy a mock verifier while calling it real.
 *
 * demo/modules/PrivacyModule.js once deployed ZKVerifierIntegrated with
 * testingMode = true under the log line "Real ZK Verifiers". In that mode every
 * verify* function skips verification and returns true for any non-zero public
 * signal, so an all-zero proof was accepted. testingMode is immutable, so the
 * deployed instance could never be corrected without redeploying.
 *
 * Since Task 3.6 the demo has no mock mode at all: option 1 deploys the real
 * pair (ZKVerifierIntegrated(false) + PrivacyManager), option 21 wires it
 * into ComplianceRules for VSC, option 41 attaches it. Mocks live in test/.
 */
describe("ZK deployment mode", function () {
  it("rejects a garbage proof when testingMode is off", async function () {
    const v = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    // PLONK shape since Task 3.1: 24 proof words, [nullifier, root, wallet].
    const ok = await v.verifyWhitelistMembership.staticCall(
      Array(24).fill(0),
      [1, 1, 1],
    );
    expect(ok, "a zero proof must not verify").to.be.false;
  });

  it("accepts a garbage proof when testingMode is on (why it must not be the default)", async function () {
    const v = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(true);
    // PLONK shape since Task 3.1: 24 proof words, [nullifier, root, wallet].
    const ok = await v.verifyWhitelistMembership.staticCall(
      Array(24).fill(0),
      [1, 1, 1],
    );
    expect(ok, "testingMode is a mock and must never be the production default")
      .to.be.true;
  });

  it("the demo has no mock mode (Task 3.6)", async function () {
    const fs = require("fs");
    const path = require("path");
    const files = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e: any) =>
          e.isDirectory()
            ? files(path.join(dir, e.name))
            : e.name.endsWith(".js")
              ? [path.join(dir, e.name)]
              : [],
        );
    for (const f of files("demo")) {
      const src = fs.readFileSync(f, "utf8");
      for (const banned of [
        "ZK_TESTING_MODE",
        "zkMode",
        "createMockGroth16Proof",
        "generateMock",
      ]) {
        expect(src.includes(banned), `${f} mentions ${banned}`).to.be.false;
      }
    }
    const deployer = fs.readFileSync("demo/core/ContractDeployer.js", "utf8");
    expect(deployer).to.match(
      /getContractFactory\("ZKVerifierIntegrated"\)\s*\)\.deploy\(false\)/,
    );
  });

  async function demo(proofGenerator?: any) {
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    const PrivacyModule = require("../../demo/modules/PrivacyModule");
    const state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    const deployer = new ContractDeployer(state, new EnhancedLogger());
    const privacy = new PrivacyModule(
      state,
      new EnhancedLogger(),
      async () => "1",
      proofGenerator ?? {
        async initializeRealProofGenerator() {
          state.realProofGenerator ??= {};
        },
      },
    );
    return { state, deployer, privacy };
  }

  async function quiet<T>(fn: () => Promise<T>, logged: string[] = []) {
    const origLog = console.log,
      origErr = console.error;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      return await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  it("option 1 deploys the real pair; option 21 wires it for VSC, mode OracleOnly", async function () {
    this.timeout(120_000);
    const { state, deployer } = await demo();
    await quiet(async () => {
      await deployer.deployAllContracts();
      await deployer.deployDigitalTokenSystem();
    });
    const zk = state.getContract("zkVerifierIntegrated");
    const pm = state.getContract("privacyManager");
    expect(await zk.testingMode()).to.be.false;
    expect(state.getContract("zkVerifier")).to.equal(zk);
    expect(await pm.zkVerifier()).to.equal(await zk.getAddress());
    const rules = state.getContract("complianceRules");
    const vsc = await state.getContract("digitalToken").getAddress();
    expect(await rules.privacyManager(vsc)).to.equal(await pm.getAddress());
    expect(await rules.whitelistMode(vsc)).to.equal(0n);
  });

  it("option 41 attaches option 1's pair and refuses nothing", async function () {
    this.timeout(120_000);
    const { state, deployer, privacy } = await demo();
    const logged: string[] = [];
    await quiet(async () => {
      await deployer.deployAllContracts();
      const pm = state.getContract("privacyManager");
      // No ComplianceRules, token or oracles: 41 still attaches.
      await privacy.deployPrivacySystem();
      expect(state.getContract("privacyManager")).to.equal(pm);
    }, logged);
    expect(logged.join("\n")).to.match(/Using the privacy pair option 1/);
    expect(logged.join("\n")).to.not.match(/attach failed/);
    expect(state.realProofGenerator).to.not.be.null;
  });

  it("option 41 deploys the same real pair when option 1 has not", async function () {
    this.timeout(120_000);
    const { state, privacy } = await demo();
    await quiet(() => privacy.deployPrivacySystem());
    const zk = state.getContract("zkVerifierIntegrated");
    expect(await zk.testingMode()).to.be.false;
    expect(await state.getContract("privacyManager").zkVerifier()).to.equal(
      await zk.getAddress(),
    );
  });

  // Found reviewing PR #4: deploying in real mode set the mode flag but
  // nothing initialised the real proof generator, so every proof action in
  // the default demo crashed on a null generator instead of generating a
  // proof. Since 3.6 every proof action initialises it itself.
  it("option 42 -> 1 initialises the real proof generator before using it", async function () {
    this.timeout(120_000);
    let generatorUsed = false;
    const holder: any = {};
    const { state, deployer, privacy } = await demo({
      async initializeRealProofGenerator() {
        holder.state.realProofGenerator ??= {
          async generateWhitelistProof() {
            generatorUsed = true;
            return { proof: Array(24).fill(0), publicSignals: [1, 1, 0] };
          },
        };
      },
    });
    holder.state = state;
    const logged: string[] = [];
    await quiet(async () => {
      await deployer.deployAllContracts();
      // No option 41: option 1's verifier is enough to reach the proof.
      await privacy.submitWhitelistMembershipProof();
    }, logged);
    expect(logged.join("\n")).to.not.match(/Cannot read properties of null/);
    expect(generatorUsed, "the demo must generate through the real generator")
      .to.be.true;
  });
});
