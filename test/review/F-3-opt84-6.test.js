// Review F-3, round 6 (the round-5 attacker G's G5 = lane D's option 84,
// inverted): option 84's DynamicListManager deploy goes through the same
// code check as every other deploy site, so a creation mined without its
// contract stops the option naming it before demo state holds it.
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask, skip } = require("../helpers/deployFlows");
const {
  deployDynamicListSystem,
} = require("../../demo/utils/DynamicListStatusFlow");

describe("F-3 round 6: option 84 checks its DynamicListManager's code", function () {
  this.timeout(600000);

  it("B (G5): a DynamicListManager deploy mined without creating it stops option 84 naming it; state holds no dynamicListManager", async function () {
    const id = await network.provider.request({ method: "evm_snapshot" });
    try {
      const state = new DemoState();
      state.signers = await ethers.getSigners();
      const logger = new EnhancedLogger();
      const deployer = new ContractDeployer(state, logger);
      const [ok] = await capture(() =>
        deployer.deployEverything({
          investorType: new InvestorTypeModule(state, logger, ask),
          governance: new GovernanceModule(state, logger, ask),
        }),
      );
      expect(ok).to.equal(true);
      const { bytecode } = await artifacts.readArtifact("DynamicListManager");
      const p = network.provider;
      const [request, send] = [p.request.bind(p), p.send.bind(p)];
      let hits = 0;
      const shim = async (a) => {
        const tx = a.method === "eth_sendTransaction" ? a.params[0] : null;
        const d = String(tx?.data ?? tx?.input ?? "").toLowerCase();
        if (tx && !tx.to && !hits && d.startsWith(bytecode.toLowerCase())) {
          hits++;
          return request({ method: a.method, params: [skip(tx)] });
        }
        return request(a);
      };
      p.request = shim;
      p.send = (m, x) => shim({ method: m, params: x ?? [] });
      let lines;
      try {
        [, lines] = await capture(() =>
          deployDynamicListSystem({ state, _wireOracles: async () => {} }),
        );
      } finally {
        [p.request, p.send] = [request, send];
      }
      const text = lines.join("\n");
      expect(hits).to.equal(1);
      expect(text).to.match(
        /DynamicListManager at 0x[0-9a-fA-F]{40} has no code: its deploy transaction mined without creating it/,
      );
      expect(text).to.not.contain("DynamicListManager deployed at");
      expect(text).to.not.contain("Governance contract set");
      expect(state.getContract("dynamicListManager")).to.equal(undefined);
    } finally {
      await network.provider.request({ method: "evm_revert", params: [id] });
    }
  });
});
