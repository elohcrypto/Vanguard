import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { registerRegistrar } = require("../../demo/utils/GovernedCalls");
const { voteOnProposal } = require("../../demo/utils/GovernanceVotingFlow");

// Task 5.6 (found writing the runbook): option 77 voted from the chosen
// wallet without approving its VGT fee, so every vote but wallet 0's
// (approved by 75c) reverted ERC20InsufficientAllowance after the
// handover. The option now approves exactly votingCost from the voter.
describe("Option 77 votes from any eligible wallet (Task 5.6)", function () {
  it("approves the voting fee from the voter and casts the vote", async function () {
    const f = await handoverFixture();
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
      digitalToken: c.token,
    };
    const signers = await ethers.getSigners();
    const state = { signers, getContract: (n: string) => byName[n] };
    const res = await registerRegistrar(
      state,
      await c.escrowWalletFactory.getAddress(),
      "MultiSigWallet",
      () => {},
    );
    const id: number = res.proposalId;
    const voter = f.voters[0];
    const index = signers.findIndex((s) => s.address === voter.address);
    expect(index).to.be.within(1, 9);
    const gov = await c.governance.getAddress();
    expect(await c.governanceToken.allowance(voter.address, gov)).to.equal(0n);

    const answers = [String(id), String(index), "y", ""];
    const mod = {
      state,
      promptUser: async () => answers.shift() as string,
      _proposalTypeName: (t: bigint) => String(t),
    };
    const quiet = console.log;
    console.log = () => {};
    try {
      await voteOnProposal(mod);
    } finally {
      console.log = quiet;
    }
    expect(answers).to.deep.equal([]);
    const [p] = await c.governance.getProposal(id);
    expect(p.votesFor).to.equal(1n);
    expect(await c.governanceToken.allowance(voter.address, gov)).to.equal(0n);
  });
});
