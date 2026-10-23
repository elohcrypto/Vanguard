// Review F-3, round 4 (F3 LOW-1): once governance owns ComplianceRules,
// naming option 51's custody manager a registrar is a ComplianceRules
// vote. Option 51 then completes, printing the pending proposal; the
// registrar link is read only while the deployer owns ComplianceRules,
// as the oracle nodes and the treasury exemption are.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { onboard } = require("../../demo/utils/Onboard");
const { walletCodeHash } = require("../../demo/utils/GovernedCalls");
const {
  capture,
  ask,
  baseStack,
  editing,
  skip,
} = require("../helpers/deployFlows");

const PENDING =
  /⏳ Wallets cannot be created until proposal #(\d+) passes \(options 77, 78\)/;

describe("F-3 round 4: option 51 after governance takes ComplianceRules", function () {
  this.timeout(600000);

  it("completes and reports the custody registrar as a pending ComplianceRules proposal", async function () {
    const state = new DemoState();
    state.signers = await ethers.getSigners();
    const logger = new EnhancedLogger();
    const modules = {
      investorType: new InvestorTypeModule(state, logger, ask),
      governance: new GovernanceModule(state, logger, ask),
    };
    const [ok] = await capture(() =>
      new ContractDeployer(state, logger).deployEverything(modules),
    );
    expect(ok).to.equal(true);
    const [gov, vgt, rules] = [
      "vanguardGovernance",
      "governanceToken",
      "complianceRules",
    ].map((k) => state.getContract(k));
    const vsc = state.getContract("digitalToken").target;
    // A wallet that may propose: verified, holding the fee, old enough.
    const proposer = state.signers[4];
    await onboard(state, proposer.address);
    const cost = await gov.proposalCreationCost();
    await (await vgt.mint(proposer.address, cost)).wait();
    const age = Number(await gov.minVoterAge()) + 1;
    await network.provider.send("evm_increaseTime", [age]);
    await network.provider.send("evm_mine");
    // Governance's own key stands in for the ComplianceRules acceptance vote.
    await network.provider.send("hardhat_impersonateAccount", [gov.target]);
    await network.provider.send("hardhat_setBalance", [
      gov.target,
      "0x56bc75e2d63100000",
    ]);
    await (await rules.transferOwnership(gov.target)).wait();
    const asGov = await ethers.getSigner(gov.target);
    await (await rules.connect(asGov).acceptOwnership()).wait();
    const oldTypes = state.getContract("investorTypeRegistry");

    let err = "";
    const [, out] = await capture(() =>
      modules.investorType.deployInvestorTypeSystem().catch((e) => {
        err = e.message;
      }),
    );
    const text = out.join("\n");
    expect(err).to.equal("");
    const pending = text.match(PENDING);
    expect(pending, "the pending proposal is printed").to.not.equal(null);
    expect(text).to.contain("INVESTOR TYPE SYSTEM DEPLOYED SUCCESSFULLY!");
    expect(text).to.not.contain("missing wiring");
    const types = state.getContract("investorTypeRegistry");
    expect(types.target).to.not.equal(oldTypes.target);
    const irm = state.getContract("investorRequestManager");
    const hash = await walletCodeHash("MultiSigWallet");
    const [p] = await gov.getProposal(BigInt(pending[1]));
    expect(p.target).to.equal(rules.target);
    expect(p.callData).to.equal(
      rules.interface.encodeFunctionData("setTrustedRegistrar", [
        vsc,
        irm.target,
        hash,
      ]),
    );
    expect(await rules.trustedRegistrars(vsc, irm)).to.equal(ethers.ZeroHash);
  });

  it("while the deployer owns ComplianceRules a registrar call without effect still stops 51", async function () {
    const { state } = await baseStack();
    const hash = await walletCodeHash("MultiSigWallet");
    const spec = {
      name: "ComplianceRules",
      fn: "setTrustedRegistrar",
      target: () => state.getContract("complianceRules").target,
      match: (a) => a[2] === hash,
      edit: skip,
    };
    const m = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    let err = "";
    const [[, out], hits] = await editing(spec, () =>
      capture(() =>
        m.deployInvestorTypeSystem().catch((e) => {
          err = e.message;
        }),
      ),
    );
    expect(hits).to.equal(1);
    expect(err).to.match(
      /^missing wiring: InvestorRequestManager \(custody\) registrar on VSC/,
    );
    expect(out.join("\n")).to.not.contain("DEPLOYED SUCCESSFULLY");
    expect(state.getContract("investorTypeRegistry")).to.equal(undefined);
  });
});
