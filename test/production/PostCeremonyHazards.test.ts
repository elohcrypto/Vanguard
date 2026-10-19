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

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    out.length = 0;
    const om = f.c.oracleManager.connect(f.deployer);
    for (const a of await addrs([9, 10, 11]))
      await om.registerOracle(a, `DEP_${a.slice(2, 6)}`, "deployer era", 500);
    cfg.oracleNodes = await addrs([9, 10, 11]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ceremony = () => captured(out, () => runHandover(cfg, "full", cfgPath));
  const derive = async () => {
    const { args } = await handoverArgs(cfg, "audit", cfgPath);
    return { o: await withDerivedContracts(args) };
  };

  // Task 5.17 (deep review L-3): open removals (anyone's) are checked
  // together at the run's start; one that could leave an invalid node
  // set gets votes against while it still votes; a safe one does not.
  it("votes against open removals that together leave too few nodes", async function () {
    await ceremony();
    const { o } = await derive();
    const om = f.c.oracleManager;
    const [n9, n10] = await addrs([9, 10]);
    const rm = (a: string) =>
      Votes.proposeCall(
        f.c.governance,
        f.voters[0],
        2,
        om,
        om.interface.encodeFunctionData("removeOracle", [a, "x"]),
        `remove ${a}`,
      );
    const one = await rm(n9);
    const {
      voteAgainstHazards,
    } = require("../../scripts/production/postCeremonyRemovals");
    const voters = [f.proposer, f.voters[1]];
    await captured(out, () => voteAgainstHazards(o, voters, console.log));
    // One removal leaves two nodes: safe, no vote cast.
    expect((await f.c.governance.getProposal(one))[0].votesAgainst).to.equal(
      0n,
    );
    const two = await rm(n10);
    out.length = 0;
    await captured(out, () => voteAgainstHazards(o, voters, console.log));
    for (const id of [one, two]) {
      const [p] = await f.c.governance.getProposal(id);
      expect([p.votesFor, p.votesAgainst], `#${id}`).to.deep.equal([0n, 2n]);
    }
    expect(out.join("\n")).to.contain(
      `removal #${two} (${n10}) could leave an invalid node set with the other open removals: voting against while it votes (a cancel vote is no guard once it has passed)`,
    );
  });
});
