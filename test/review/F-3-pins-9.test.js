// F-3 round 9 (item F; mutant W28, survived): the until-handover reads of
// item C's links. After the handover a vote owns IdentityRegistry and
// DynamicListManager and may move what those links read (trusted issuers,
// list oracles), as it may rebind OracleManager's engine; each link then
// reads true, as round 8's token and escrow links do (F-3-abi-8).
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const DynamicListModule = require("../../demo/modules/DynamicListModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask } = require("../helpers/deployFlows");
const { wiring } = require("../../demo/utils/DeployWiring");
const { KYC_TOPIC } = require("../../demo/utils/Kyc");

describe("F-3 round 9: item C's links read true after the handover", function () {
  this.timeout(600000);

  it("trusted issuers, the list manager's oracles and the engine moved by their new owner: each link reads true", async function () {
    const id = await network.provider.request({ method: "evm_snapshot" });
    try {
      const state = new DemoState();
      state.signers = await ethers.getSigners();
      const logger = new EnhancedLogger();
      const d = new ContractDeployer(state, logger);
      const inv = new InvestorTypeModule(state, logger, ask);
      const gov = new GovernanceModule(state, logger, ask);
      const esc = new EscrowModule(state, logger, ask);
      const dyn = new DynamicListModule(state, logger, ask);
      await capture(async () => {
        await d.deployAllContracts();
        await d.deployComplianceRules();
        await d.deployDigitalTokenSystem();
        await d.deployOracleSystem();
        await inv.deployInvestorTypeSystem();
        await esc.deployEscrowSystem();
        await gov.deployGovernanceSystem();
        await dyn.deployDynamicListSystem();
      });
      const names = [
        "KYC/AML issuers trusted on IdentityRegistry",
        "DynamicListManager oracles as deployed",
        "ConsensusOracle engine on OracleManager",
      ];
      const before = await wiring(state);
      for (const n of names)
        expect(
          before.find((w) => w.name === n),
          n,
        ).to.deep.equal({
          name: n,
          ok: true,
        });
      const vote = state.signers[15];
      const decoy = state.getContract("keyManager").target; // a contract
      const ir = state.getContract("identityRegistry");
      const dlm = state.getContract("dynamicListManager");
      const om = state.getContract("oracleManager");
      for (const c of [ir, dlm, om]) {
        await (await c.transferOwnership(vote.address)).wait();
        await (await c.connect(vote).acceptOwnership()).wait();
      }
      await (
        await ir.connect(vote).addTrustedIssuer(decoy, [KYC_TOPIC])
      ).wait();
      await (
        await ir
          .connect(vote)
          .removeTrustedIssuer(state.getContract("kycIssuer"))
      ).wait();
      await (await dlm.connect(vote).setOracles(decoy, decoy)).wait();
      const engine2 = await (
        await ethers.getContractFactory("ConsensusOracle")
      ).deploy(om.target);
      await engine2.waitForDeployment();
      await (await om.connect(vote).setConsensusEngine(engine2.target)).wait();
      const after = await wiring(state);
      for (const n of names)
        expect(
          after.find((w) => w.name === n),
          n,
        ).to.deep.equal({
          name: n,
          ok: true,
        });
    } finally {
      await network.provider.request({ method: "evm_revert", params: [id] });
    }
  });
});
