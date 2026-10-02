import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { trustContract } = require("../../demo/utils/GovernedCalls");

// Review L-5 (mutant M10): option 63's trustContract after the handover
// becomes a ComplianceRules proposal and never calls as the deployer; with
// a third owner it refuses and sends nothing.
describe("GovernedCalls after the handover (2F.5 L11)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;

  beforeEach(async function () {
    f = await handoverFixture();
    const { c } = f;
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    const byName: Record<string, any> = {
      complianceRules: c.complianceRules,
      vanguardGovernance: c.governance,
      identityRegistry: c.identityRegistry,
      governanceToken: c.governanceToken,
    };
    state = {
      signers: await ethers.getSigners(),
      getContract: (n: string) => byName[n],
    };
  });

  it("creates a type-1 proposal by a verified holder, never as the deployer", async function () {
    const { c, deployer, stranger } = f;
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const res = await trustContract(state, stranger.address, () => {});
    expect(res.direct).to.equal(undefined);
    expect(res.proposalId).to.be.a("number");
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
    const [p] = await c.governance.getProposal(res.proposalId);
    expect(p.proposalType).to.equal(1n);
    expect(p.proposer).to.equal(f.proposer.address);
    expect(p.target).to.equal(await c.complianceRules.getAddress());
    expect(
      await c.complianceRules.isTrustedContract(stranger.address),
    ).to.equal(false);
  });

  it("refuses when a third party owns ComplianceRules", async function () {
    const { deployer, stranger } = f;
    const other = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(stranger.address, [840], []);
    const real = state.getContract;
    state.getContract = (n: string) =>
      n === "complianceRules" ? other : real(n);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const res = await trustContract(state, stranger.address, () => {});
    expect(res.refused).to.match(/neither the deployer nor governance/);
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
  });
});
