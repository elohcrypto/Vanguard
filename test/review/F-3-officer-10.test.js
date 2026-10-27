// F-3 round 10 (item E, lane D's D9-3): "compliance officer wallet 1" is
// set by InvestorTypeRegistry.setComplianceOfficer, an owner setter, so
// after the handover a vote may revoke it, and a refused deploy then
// listed it missing. It reads until the handover, as the other
// owner-settable links do.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask } = require("../helpers/deployFlows");
const { wiring } = require("../../demo/utils/DeployWiring");

describe("F-3 round 10: compliance officer wallet 1 reads until the handover", function () {
  this.timeout(600000);

  it("D9-3: a vote revokes wallet 1 after the handover: the link reads true", async function () {
    const id = await network.provider.request({ method: "evm_snapshot" });
    try {
      const state = new DemoState();
      state.signers = await ethers.getSigners();
      const logger = new EnhancedLogger();
      const d = new ContractDeployer(state, logger);
      const inv = new InvestorTypeModule(state, logger, ask);
      await capture(async () => {
        await d.deployAllContracts();
        await d.deployComplianceRules();
        await d.deployDigitalTokenSystem();
        await inv.deployInvestorTypeSystem();
      });
      const name = "compliance officer wallet 1";
      const link = async () => (await wiring(state)).find((w) => w.name === name);
      expect(await link(), "before").to.deep.equal({ name, ok: true });
      const types = state.getContract("investorTypeRegistry");
      const vote = state.signers[15];
      await (await types.transferOwnership(vote.address)).wait();
      await (await types.connect(vote).acceptOwnership()).wait();
      await (
        await types
          .connect(vote)
          .setComplianceOfficer(state.signers[1].address, false)
      ).wait();
      expect(
        await types.isComplianceOfficer(state.signers[1].address),
        "revoked",
      ).to.equal(false);
      expect(await link(), "after the handover").to.deep.equal({
        name,
        ok: true,
      });
    } finally {
      await network.provider.request({ method: "evm_revert", params: [id] });
    }
  });
});
