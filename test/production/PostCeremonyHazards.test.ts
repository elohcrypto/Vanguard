import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { ageVoters, handoverFixture } from "../helpers/governanceFixture";
import { deployIdentity } from "../helpers/kyc";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  parseNodes,
  runPostCeremony,
} from "../../scripts/production/postCeremonyVotes";

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

  const R = () => require("../../scripts/production/removalHazards");
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
  const pastVote = async (id: number) => {
    const [p] = await f.c.governance.getProposal(id);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await ethers.provider.send("evm_increaseTime", [
      Number(p.votingEnds) - now + 1,
    ]);
    await ethers.provider.send("evm_mine", []);
  };
  const NEW = async () =>
    (await addrs([16, 17, 18])).map((a, k) => `${a}:NODE_${k + 1}`).join(",");

  // Review H-1: investors count in eligibleVotersAtCreation and never
  // vote; two of them make the electorate five, not three.
  const investors = async (n: number) => {
    for (let k = 0; k < n; k++) {
      const a = ethers.Wallet.createRandom().address;
      const id = await deployIdentity(f.factory, a);
      await f.c.identityRegistry.registerIdentity(a, id, 840);
    }
    await ageVoters(f.c.governance);
  };
  // Runs the CLI; once round 2's removals exist, `stranger` runs.
  const runWith = async (o: any, stranger: () => Promise<void>) => {
    const realOpen = Votes.openAll;
    Votes.openAll = async (args: any) => {
      const open = await realOpen(args);
      if (/remove deployer-era/.test(args.items[0]?.label ?? ""))
        await stranger();
      return open;
    };
    const fresh = parseNodes(await NEW());
    try {
      await captured(out, () =>
        runPostCeremony(o, f.proposer, f.voters, fresh, cfg),
      );
    } finally {
      Votes.openAll = realOpen;
    }
  };
  const rotated = async () =>
    expect(
      [...(await f.c.oracleManager.getRegisteredOracles())].sort(),
    ).to.deep.equal([...(await addrs([16, 17, 18]))].sort());

  it("H-1: two unvoted stranger removals among five identities: no hold, no vote, round 2 completes", async function () {
    await investors(2);
    await ceremony();
    const { o } = await derive();
    const theirs: number[] = [];
    await runWith(o, async () => {
      for (const a of await addrs([16, 17]))
        theirs.push(await rm(f.voters[0], a));
    });
    expect(theirs).to.have.length(2);
    for (const id of theirs) expect(await votes(id)).to.deep.equal([0n, 0n]);
    const text = out.join("\n");
    expect(text).to.contain(`removal #${theirs[0]} (`);
    expect(text).to.contain("but nobody voted for it: no vote against");
    expect(text).to.not.contain("round 2 held");
    await rotated();
  });

  it("H-1: ten unvoted spam removals lock nothing; one with a FOR vote is voted against, not passing, no hold", async function () {
    await investors(2);
    await ceremony();
    const { o } = await derive();
    const spam: number[] = [];
    let voted = 0;
    await runWith(o, async () => {
      const n = await addrs([16, 17, 18]);
      for (let k = 0; k < 10; k++) spam.push(await rm(f.voters[0], n[k % 3]));
      voted = await rm(f.voters[0], n[0]);
      await Votes.castAcceptanceVotes(f.c.governance, voted, [f.voters[1]]);
    });
    for (const id of spam) expect(await votes(id)).to.deep.equal([0n, 0n]);
    // voters[1] voted for it; the proposer's vote against: 1 for, 1 against.
    expect(await votes(voted)).to.deep.equal([1n, 1n]);
    expect(out.join("\n")).to.not.contain("round 2 held");
    await rotated();
  });

  it("H-1: a vote against never spends VGT this run's own proposals need; the skip is named", async function () {
    await ceremony();
    const { o } = await derive();
    for (const a of nodes.slice(0, 3)) await rm(f.proposer, a);
    const theirs = await rm(f.voters[0], nodes[3]);
    await rm(f.voters[0], nodes[4]);
    await Votes.castAcceptanceVotes(f.c.governance, theirs, [f.voters[1]]);
    const log: string[] = [];
    const big = 10n ** 9n; // own proposals no wallet here can pay for
    await R().voteAgainstHazards(
      o,
      f.proposer,
      f.voters,
      (l: string) => log.push(l),
      [],
      big,
    );
    expect(await votes(theirs)).to.deep.equal([1n, 0n]);
    expect(log.join("\n")).to.match(
      new RegExp(
        `removal #${theirs}: ${f.proposer.address} skipped, its free VGT .* keeps .* for this run's ${big} own proposal\\(s\\)`,
      ),
    );
  });

  it("a passing foreign hazard holds round 2 with its id and stops an own removal's precheck; cancelled, the hold lifts", async function () {
    await ceremony();
    const { o } = await derive();
    for (const a of nodes.slice(0, 3)) await rm(f.proposer, a);
    const theirs = [
      await rm(f.voters[0], nodes[3]),
      await rm(f.voters[0], nodes[4]),
    ];
    for (const id of theirs)
      await Votes.castAcceptanceVotes(f.c.governance, id, [
        f.proposer,
        f.voters[1],
      ]);
    await pastVote(theirs[1]);
    await expect(
      R().holdForForeignHazards(o, f.proposer, [], () => {}),
    ).to.be.rejectedWith(
      new RegExp(
        `^round 2 held: open removal proposal\\(s\\) #${theirs[0]} \\(${nodes[3]}, by ${f.voters[0].address}: .*its vote is over and it passed: anyone may execute it\\).* pass on the votes cast now`,
      ),
    );
    const {
      removalPrecheck,
    } = require("../../scripts/production/postCeremonyRemovals");
    await expect(removalPrecheck(o, nodes[0], f.proposer)()).to.be.rejectedWith(
      new RegExp(
        `^removing ${nodes[0]} now: round 2 held: .*#${theirs[0]}.*not executed$`,
      ),
    );
    const cand = await R().cancelCandidates(o, f.proposer);
    expect(cand.map((c: any) => c.id)).to.include.members(theirs);
    const {
      cancelHazards,
    } = require("../../scripts/production/postCeremonyRemovals");
    const cancelled: number[] = await captured(out, () =>
      cancelHazards(o, f.proposer, f.voters, cand, console.log),
    );
    expect([...cancelled].sort()).to.deep.equal(theirs);
    await R().holdForForeignHazards(o, f.proposer, [], () => {});
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
