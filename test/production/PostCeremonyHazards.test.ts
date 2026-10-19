import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
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

  it("a stranger's hazardous removal that cannot pass: voted against, round 2 not held and completes", async function () {
    await ceremony();
    const { o } = await derive();
    const realOpen = Votes.openAll;
    const theirs: number[] = [];
    // Once round 2's removals exist, a stranger proposes two more.
    Votes.openAll = async (args: any) => {
      const open = await realOpen(args);
      if (/remove deployer-era/.test(args.items[0]?.label ?? "")) {
        const [n16, n17] = await addrs([16, 17]);
        theirs.push(await rm(f.voters[0], n16), await rm(f.voters[0], n17));
      }
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
    expect(theirs).to.have.length(2);
    // The proposer and voters[1] vote against (voters[0] proposed them).
    for (const id of theirs) expect(await votes(id)).to.deep.equal([0n, 2n]);
    const text = out.join("\n");
    expect(text).to.contain(`removal #${theirs[0]} (`);
    expect(text).to.contain("voting against while it votes");
    expect(text).to.contain("but it cannot pass: not holding round 2");
    expect(
      [...(await f.c.oracleManager.getRegisteredOracles())].sort(),
    ).to.deep.equal([...(await addrs([16, 17, 18]))].sort());
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
        `^round 2 held: open removal proposal\\(s\\) #${theirs[0]} \\(${nodes[3]}, by ${f.voters[0].address}: .*can pass`,
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
