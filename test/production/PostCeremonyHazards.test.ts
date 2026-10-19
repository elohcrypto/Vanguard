import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";

const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");

/**
 * Task 5.17 slice C (deep review L-3): the post-ceremony CLI checked a
 * removal's node set only just before it executed it, after its vote,
 * when anyone may already have executed it. Now every open removal
 * (anyone's) is checked with the others in every order at each run's
 * start and before each vote; a hazardous one gets votes against while
 * it still votes. Same setup as PostCeremonyVotes.test.ts: three
 * deployer-era nodes (wallets 9-11).
 */
describe("Post-ceremony votes: hazardous open removals (L-3)", function () {
  this.timeout(600_000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  let dir: string;
  const out: string[] = [];
  const addrs = async (is: number[]) => {
    const s = await ethers.getSigners();
    return is.map((i) => s[i].address);
  };

  let nodes: string[];
  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    out.length = 0;
    // Six deployer-era nodes, all acknowledged.
    nodes = await addrs([9, 10, 11, 13, 14, 15]);
    const om = f.c.oracleManager.connect(f.deployer);
    for (const a of nodes)
      await om.registerOracle(a, `DEP_${a.slice(2, 6)}`, "deployer era", 500);
    cfg.oracleNodes = nodes;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ceremony = () => captured(out, () => runHandover(cfg, "full", cfgPath));
  const derive = async () => {
    const { args } = await handoverArgs(cfg, "audit", cfgPath);
    return { o: await withDerivedContracts(args) };
  };

  const R = () => require("../../scripts/production/postCeremonyRemovals");
  const rm = (by: any, a: string) =>
    Votes.proposeCall(
      f.c.governance,
      by,
      2,
      f.c.oracleManager,
      f.c.oracleManager.interface.encodeFunctionData("removeOracle", [a, "x"]),
      `remove ${a}`,
    );
  const votes = async (id: number) => {
    const [p] = await f.c.governance.getProposal(id);
    return [p.votesFor, p.votesAgainst];
  };

  it("a stranger's removals that break the operator's safe plan: only theirs voted against; round 2 held", async function () {
    await ceremony();
    const { o } = await derive();
    // The operator's own plan: three removals, three nodes left (safe).
    const own = [];
    for (const a of nodes.slice(0, 3)) own.push(await rm(f.proposer, a));
    // A stranger (a voter) removes two more: with the plan, one node left.
    const theirs = [
      await rm(f.voters[0], nodes[3]),
      await rm(f.voters[0], nodes[4]),
    ];
    const { hazards, foreign } = await R().assessRemovals(o, f.proposer);
    expect([...foreign].sort()).to.deep.equal(theirs);
    for (const id of own) expect(hazards.has(id), `#${id}`).to.equal(false);
    await captured(out, () =>
      R().voteAgainstHazards(o, f.proposer, f.voters, console.log),
    );
    // voters[0] proposed them and cannot vote on them; voters[1] votes against.
    for (const id of theirs) expect(await votes(id)).to.deep.equal([0n, 1n]);
    for (const id of own) expect(await votes(id)).to.deep.equal([0n, 0n]);
    expect(out.join("\n")).to.contain(
      `removal #${theirs[0]} (${nodes[3]}, proposed by ${f.voters[0].address}) with the other open removals 1 node(s) would remain, below MIN_NODES (2): voting against while it votes (a cancel vote is no guard once it has passed)`,
    );
    await expect(R().holdForForeignHazards(o, f.proposer)).to.be.rejectedWith(
      new RegExp(
        `^round 2 held: open removal proposal\\(s\\) #${theirs[0]} \\(${nodes[3]}, by ${f.voters[0].address}: .*vote them down or cancel them by vote`,
      ),
    );
  });

  it("a stranger's PASSED hazardous removals are cancelled by vote, then round 2 may go", async function () {
    await ceremony();
    const { o } = await derive();
    for (const a of nodes.slice(0, 3)) await rm(f.proposer, a);
    const theirs = [
      await rm(f.voters[0], nodes[3]),
      await rm(f.voters[0], nodes[4]),
    ];
    // Passed: the proposer and voters[1] vote for them; the vote ends.
    for (const id of theirs)
      await Votes.castAcceptanceVotes(f.c.governance, id, [
        f.proposer,
        f.voters[1],
      ]);
    const [p] = await f.c.governance.getProposal(theirs[1]);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await ethers.provider.send("evm_increaseTime", [
      Number(p.votingEnds) - now + 1,
    ]);
    await ethers.provider.send("evm_mine", []);
    const cand = await R().cancelCandidates(o, f.proposer);
    expect(cand.map((c: any) => c.id)).to.include.members(theirs);
    const cancelled: number[] = await captured(out, () =>
      R().cancelHazards(o, f.proposer, f.voters, cand, console.log),
    );
    expect([...cancelled].sort()).to.deep.equal(theirs);
    for (const id of theirs)
      expect(Number((await f.c.governance.getProposal(id))[0].status)).to.equal(
        5,
      );
    await R().holdForForeignHazards(o, f.proposer);
  });

  it("fails closed past 12 distinct nodes under removal; one node's duplicates count once", async function () {
    const extra = Array.from(
      { length: 8 },
      () => ethers.Wallet.createRandom().address,
    );
    const om = f.c.oracleManager.connect(f.deployer);
    for (const a of extra) await om.registerOracle(a, "X", "x", 500);
    cfg.oracleNodes = [...nodes, ...extra];
    await ceremony();
    const { o } = await derive();
    const all = [...nodes, ...extra]; // 14 live nodes
    const ids = [];
    for (const a of all.slice(0, 13)) ids.push(await rm(f.voters[0], a));
    const dup = await rm(f.voters[0], all[0]);
    const { hazards } = await R().assessRemovals(o, f.proposer);
    const capped = ids.filter((id) =>
      /beyond the 12 removals checked together: refused \(fail closed\)/.test(
        hazards.get(id) ?? "",
      ),
    );
    expect(capped).to.have.length(1);
    // The duplicate of node 0 shares its group's verdict, not a slot.
    expect(hazards.get(dup)).to.equal(hazards.get(ids[0]));
  });
});
