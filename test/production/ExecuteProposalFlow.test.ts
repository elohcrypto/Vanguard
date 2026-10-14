import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const {
  acceptAllByVote,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const {
  proposeCall,
  castAcceptanceVotes,
} = require("../../demo/utils/HandoverVotes");
const { nodeFacts } = require("../../demo/utils/HandoverNodes");
const { executeProposal } = require("../../demo/utils/GovernanceVotingFlow");

const ORACLE = 2; // ProposalType.OracleParameters
const EXECUTED = 4n; // ProposalStatus.Executed

// Task 5.6b (found writing the runbook): option 78 executed every
// proposal as signers[0], the deployer. executeProposal is permissionless
// and the ceremony attributes a node to the sender of its registration
// (D50), so a node registered by vote read "registered by the deployer".
// Option 78 now executes from the proposer or a voter, never wallet 0
// after the ceremony, and asks only when no such key is the demo's.
describe("Option 78 executes from a non-deployer wallet (Task 5.6b)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  const node = () => f.stranger.address;

  async function ceremony() {
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  /** A voted, matured OracleParameters proposal; returns its id. */
  async function voted(callData: string): Promise<number> {
    const g = f.c.governance;
    const om = f.c.oracleManager;
    const id = await proposeCall(g, f.proposer, ORACLE, om, callData, "N");
    await castAcceptanceVotes(g, id, f.voters);
    const [p] = await g.getProposal(id);
    await time.increaseTo(
      (p.executionTime > p.votingEnds ? p.executionTime : p.votingEnds) + 1n,
    );
    return id;
  }
  const register = () =>
    f.c.oracleManager.interface.encodeFunctionData("registerOracle", [
      node(),
      "NODE_1",
      "production node",
      500,
    ]);

  /** Option 78 with `signers` as the demo's wallets; returns the log. */
  async function option78(signers: any[], answers: string[]) {
    const out: string[] = [];
    const mod = {
      state: {
        signers,
        getContract: (n: string) =>
          n === "vanguardGovernance" ? f.c.governance : undefined,
      },
      promptUser: async () => answers.shift() as string,
      _proposalTypeName: (t: bigint) => String(t),
      _thresholdsFor: async () => ({ quorumPct: 0, approvalPct: 0 }),
    };
    const quiet = console.log;
    console.log = (m: string) => out.push(String(m));
    try {
      await executeProposal(mod);
    } finally {
      console.log = quiet;
    }
    expect(answers, "every answer used, no extra prompt").to.deep.equal([]);
    return out.join("\n");
  }
  const status = async (id: number) =>
    (await f.c.governance.getProposal(id))[0].status;

  beforeEach(async function () {
    f = await handoverFixture();
  });

  it("executes a voted node registration from the proposer, not the deployer", async function () {
    await ceremony();
    const id = await voted(register());
    const signers = await ethers.getSigners();
    const log = await option78(signers, [String(id), "y"]);
    expect(log).to.include(
      `   Executing from ${f.proposer.address} (the proposer)`,
    );
    expect(await status(id)).to.equal(EXECUTED);
    const [n] = (await nodeFacts(f.args)).nodes;
    expect(n.registeredBy).to.equal(f.proposer.address);
    expect(n.registeredBy).to.not.equal(f.deployer.address);
  });

  it("after the ceremony skips wallet 0 for a voter, else asks and refuses 0", async function () {
    await ceremony();
    const [bob, carol] = f.voters;
    // The proposer is the demo's wallet 0 here: a voter executes.
    const id = await voted(register());
    let log = await option78([f.proposer, bob, carol], [String(id), "y"]);
    expect(log).to.include(`   Executing from ${bob.address} (a voter on it)`);
    expect(await status(id)).to.equal(EXECUTED);
    // Neither the proposer nor a voter is the demo's: it asks.
    const om = f.c.oracleManager;
    const id2 = await voted(
      om.interface.encodeFunctionData("removeOracle", [node(), "D50"]),
    );
    const mine = [f.deployer, f.ops, f.guardian, f.stranger];
    log = await option78(mine, [String(id2), "y", "0"]);
    expect(log).to.include(
      'Execution refused: wallet "0" is not a wallet index 1-3',
    );
    expect(await status(id2)).to.not.equal(EXECUTED);
    log = await option78(mine, [String(id2), "y", "3"]);
    expect(log).to.include(
      `   Executing from ${f.stranger.address} (wallet 3)`,
    );
    expect(await status(id2)).to.equal(EXECUTED);
  });

  it("before the ceremony executes from wallet 0 without asking", async function () {
    const owner = f.c.oracleManager.interface.encodeFunctionData("owner");
    const id = await voted(owner);
    const log = await option78([f.deployer, f.ops], [String(id), "y"]);
    expect(log).to.include(
      `   Executing from ${f.deployer.address} (wallet 0, before the ceremony)`,
    );
    expect(await status(id)).to.equal(EXECUTED);
  });
});
