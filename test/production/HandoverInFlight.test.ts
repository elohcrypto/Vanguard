import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig, captured } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";

const Votes = require("../../demo/utils/HandoverVotes");

/**
 * Task 5.17 slice C (deep review M-3): a re-run that starts while the
 * killed run's own createProposal or castVote is still unmined (automine
 * off here; a 12 s block on Sepolia) used to read the chain without it and
 * propose a duplicate, or approve again and fail castVote "Already voted".
 * openAll now waits for every sender's pending transactions to mine first
 * (demo/utils/PendingNonces.js); and a duplicate an earlier run left is not
 * voted on and is settled once its vote ends.
 */
describe("Handover votes with a transaction in flight (M-3)", function () {
  this.timeout(600_000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  const out: string[] = [];
  const SYSTEM = 4;
  const text = () => out.join("\n");

  beforeEach(async function () {
    f = await handoverFixture();
    const { cfg, cfgPath } = await cliConfig(f);
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    out.length = 0;
  });
  afterEach(async () => {
    await network.provider.send("evm_setAutomine", [true]);
  });
  const g = () => f.c.governance;
  const call = (vgt: number) =>
    g().interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther(String(vgt)),
    ]);
  const item = (vgt: number) => ({
    label: `voting cost ${vgt}`,
    proposalType: SYSTEM,
    target: g(),
    callData: call(vgt),
  });
  /** `run` with mining paused; mining resumes after `ms`. */
  async function minedLater<T>(run: () => Promise<T>, ms = 3000) {
    const resume = new Promise<void>((ok) =>
      setTimeout(async () => {
        await network.provider.send("evm_setAutomine", [true]);
        await network.provider.send("evm_mine", []);
        ok();
      }, ms),
    );
    const r = await captured(out, run);
    await resume;
    return r;
  }

  it("a pending createProposal is adopted after it mines, not proposed again", async function () {
    const gov = g();
    await (
      await (
        await ethers.getContractAt(
          "GovernanceToken",
          await gov.governanceToken(),
        )
      )
        .connect(f.proposer)
        .approve(await gov.getAddress(), await gov.proposalCreationCost())
    ).wait();
    const before = Number(await gov.proposalCount());
    await network.provider.send("evm_setAutomine", [false]);
    // The killed run's last send: in the mempool, never mined before it died.
    await gov
      .connect(f.proposer)
      .createProposal(
        SYSTEM,
        "t",
        "t (killed run)",
        await gov.getAddress(),
        call(13),
      );
    await minedLater(() =>
      Votes.voteAll({
        governance: gov,
        proposer: f.proposer,
        voters: f.voters,
        log: console.log,
        items: [item(13)],
      }),
    );
    expect(text()).to.match(
      /⏳ the proposals \(proposer and voters\): waiting for pending transactions to mine first/,
    );
    expect(text()).to.contain(`proposal #${before + 1} already open; adopted`);
    expect(Number(await gov.proposalCount())).to.equal(before + 1);
    expect(await gov.votingCost()).to.equal(ethers.parseEther("13"));
  });

  it("a pending castVote is seen after it mines: no second approve, no Already voted", async function () {
    const gov = g();
    const id = await Votes.proposeCall(
      gov,
      f.proposer,
      SYSTEM,
      gov,
      call(14),
      "t",
    );
    const v = f.voters[0];
    const vgt = await ethers.getContractAt(
      "GovernanceToken",
      await gov.governanceToken(),
    );
    await (
      await vgt
        .connect(v)
        .approve(await gov.getAddress(), await gov.votingCost())
    ).wait();
    await network.provider.send("evm_setAutomine", [false]);
    await gov.connect(v).castVote(id, true, "killed run's vote");
    const sent = await ethers.provider.getTransactionCount(
      v.address,
      "pending",
    );
    await minedLater(() =>
      Votes.voteAll({
        governance: gov,
        proposer: f.proposer,
        voters: f.voters,
        log: console.log,
        items: [item(14)],
      }),
    );
    expect(text()).to.contain(`proposal #${id} already open; adopted`);
    // The voter sent nothing more: its vote was already cast.
    expect(
      await ethers.provider.getTransactionCount(v.address, "latest"),
    ).to.equal(sent);
    const [p] = await gov.getProposal(id);
    expect(Number(p.status)).to.equal(4);
    expect(await gov.votingCost()).to.equal(ethers.parseEther("14"));
  });

  it("an orphan duplicate from an earlier run is not voted on and is settled", async function () {
    const gov = g();
    const voted = await Votes.proposeCall(
      gov,
      f.proposer,
      SYSTEM,
      gov,
      call(15),
      "t",
    );
    await Votes.castAcceptanceVotes(gov, voted, f.voters);
    const orphan = await Votes.proposeCall(
      gov,
      f.proposer,
      SYSTEM,
      gov,
      call(15),
      "t",
    );
    await captured(out, () =>
      Votes.voteAll({
        governance: gov,
        proposer: f.proposer,
        voters: f.voters,
        log: console.log,
        items: [item(15)],
      }),
    );
    expect(text()).to.contain(`proposal #${voted} already open; adopted`);
    expect(text()).to.contain(
      `proposal #${orphan} duplicates #${voted} (an earlier run's orphan): not voted on`,
    );
    expect(text()).to.match(
      new RegExp(
        `🧹 duplicate proposal #${orphan} \\(voting cost 15\\) settled as Rejected`,
      ),
    );
    const [o] = await gov.getProposal(orphan);
    expect(Number(o.status)).to.equal(3);
    expect(o.votesFor).to.equal(0n);
    const [p] = await gov.getProposal(voted);
    expect(Number(p.status)).to.equal(4);
  });

  it("refuses after the timeout while a transaction stays pending", async function () {
    const { awaitSettledNonces } = require("../../demo/utils/PendingNonces");
    await network.provider.send("evm_setAutomine", [false]);
    await f.proposer.sendTransaction({ to: f.proposer.address, value: 1 });
    await expect(
      awaitSettledNonces([f.proposer], "the probe", {
        timeoutS: 1,
        pollMs: 200,
        log: () => {},
      }),
    ).to.be.rejectedWith(
      new RegExp(
        `the probe: transactions still pending after 1 s from ${f.proposer.address} \\(nonce \\d+\\.\\.\\d+\\); refusing`,
      ),
    );
  });
});
