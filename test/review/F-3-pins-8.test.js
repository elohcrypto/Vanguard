// Review F-3, round 8 (item C; lane F F-2 and F-3): two demo conditions
// no test pinned. Each test passes unmutated and fails under its mutant.
//   F04  option 61's pending-registrar filter: once governance owns
//        ComplianceRules, naming the factory a registrar is a proposal;
//        option 61 prints it and completes (the registrar link reads
//        false until the vote, so without the filter it stops by name).
//   F16  the custody-bank redeploy condition: a manager in demo state with
//        another bank is redeployed (bank = ops, wallet 10), not reused.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const { EnhancedLogger } = require("../../demo/logging");
const { onboard } = require("../../demo/utils/Onboard");
const { deployCustody } = require("../../demo/utils/CustodyFlow");
const { capture, ask } = require("../helpers/deployFlows");

/** `fn` on the chain as it is now, reverted after. */
async function fresh(fn) {
  const id = await network.provider.request({ method: "evm_snapshot" });
  try {
    return await fn();
  } finally {
    await network.provider.request({ method: "evm_revert", params: [id] });
  }
}

/** Demo state after options 1, 13, 21, 31, 51 (and 74 with `gov`). */
async function stack(gov) {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const logger = new EnhancedLogger();
  const m = {
    state,
    deployer: new ContractDeployer(state, logger),
    inv: new InvestorTypeModule(state, logger, ask),
    gov: new GovernanceModule(state, logger, ask),
    esc: new EscrowModule(state, logger, ask),
  };
  await capture(async () => {
    await m.deployer.deployAllContracts();
    await m.deployer.deployComplianceRules();
    await m.deployer.deployDigitalTokenSystem();
    await m.deployer.deployOracleSystem();
    await m.inv.deployInvestorTypeSystem();
    if (gov) await m.gov.deployGovernanceSystem();
  });
  return m;
}

const PENDING =
  /⏳ Escrows cannot be created until proposal #(\d+) names the factory a registrar/;

describe("F-3 round 8: option 61's pending registrar and the custody bank, pinned", function () {
  this.timeout(600000);

  it("F04: option 61 after governance takes ComplianceRules prints the registrar proposal and completes", async function () {
    await fresh(async () => {
      const m = await stack(true);
      const { state } = m;
      const [gov, vgt, rules] = [
        "vanguardGovernance",
        "governanceToken",
        "complianceRules",
      ].map((k) => state.getContract(k));
      // A wallet that may propose: verified, holding the fee, old enough.
      const proposer = state.signers[4];
      await onboard(state, proposer.address);
      const cost = await gov.proposalCreationCost();
      await (await vgt.mint(proposer.address, cost)).wait();
      const age = Number(await gov.minVoterAge()) + 1;
      await network.provider.send("evm_increaseTime", [age]);
      await network.provider.send("evm_mine");
      // Governance's own key stands in for the acceptance vote.
      await network.provider.send("hardhat_impersonateAccount", [gov.target]);
      await network.provider.send("hardhat_setBalance", [
        gov.target,
        "0x56bc75e2d63100000",
      ]);
      await (await rules.transferOwnership(gov.target)).wait();
      const asGov = await ethers.getSigner(gov.target);
      await (await rules.connect(asGov).acceptOwnership()).wait();

      let err = "";
      const [, out] = await capture(() =>
        m.esc.deployEscrowSystem().catch((e) => {
          err = e.message;
        }),
      );
      const text = out.join("\n");
      expect(text, "the pending proposal is printed").to.match(PENDING);
      expect(err, "option 61 completes").to.equal("");
      expect(text).to.not.contain("missing wiring");
      expect(text).to.contain("ENHANCED ESCROW SYSTEM DEPLOYED SUCCESSFULLY!");
      const f = state.getContract("escrowFactory");
      expect(f, "the factory in demo state").to.not.equal(undefined);
      const vsc = state.getContract("digitalToken").target;
      expect(await rules.trustedRegistrars(vsc, f)).to.equal(ethers.ZeroHash);
    });
  });

  it("F16: a custody manager in demo state with another bank is redeployed with ops as bank", async function () {
    await fresh(async () => {
      const { state } = await stack(false);
      const ops = state.signers[10].address;
      const [vsc, types, ir] = [
        "digitalToken",
        "investorTypeRegistry",
        "identityRegistry",
      ].map((k) => state.getContract(k).target);
      const stale = await (
        await ethers.getContractFactory("InvestorRequestManager")
      ).deploy(state.signers[5].address, vsc, types, ir);
      await stale.waitForDeployment();
      state.setContract("investorRequestManager", stale);

      const m = await deployCustody(state, () => {});
      expect(m.target, "a new manager").to.not.equal(stale.target);
      expect(await m.bank(), "its bank is ops").to.equal(ops);
      expect(state.getContract("investorRequestManager")).to.equal(m);
    });
  });
});
