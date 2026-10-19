import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { floorRefusal } from "../../scripts/production/postCeremonyVotes";

const {
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { fewestToReach } = require("../../demo/utils/HandoverNodes");

/**
 * Task 5.17 slice D (deep review contracts L-2): a list oracle's
 * minimumConsensusOracles above the fewest registered nodes that reach
 * the consensus bar makes every verdict unusable (a query resolves at that
 * many votes, takes no more, and the oracle refuses it: TooFewVoters). The
 * contract checks only the lower bound; the preflight, completion and the
 * day-2 audit (HandoverNodes.js) and postCeremonyVotes' registration step
 * refuse it, naming the oracle, the floor and the reachable count.
 */
describe("List oracle floor against the reachable votes (contracts L-2)", function () {
  this.timeout(300_000);

  it("fewestToReach: the heaviest nodes first", function () {
    expect(fewestToReach([500n, 500n, 500n], 66n)).to.equal(2);
    expect(fewestToReach([500n, 500n, 500n], 100n)).to.equal(3);
    expect(fewestToReach([1000n, 1000n, 100n, 100n], 66n)).to.equal(2);
    expect(fewestToReach([], 66n)).to.equal(null);
  });

  it("one node holding the bar alone: no floor fits, the weights must change", async function () {
    // The single-node quorum check refuses it first; the floor row and
    // the registration step still say why no floor can help.
    const { f, nodes, line } = await setup([1000, 100, 100], 2);
    expect((await line()).ok).to.equal(false);
    expect(await floorRefusal(f.args, nodes, facts)).to.match(
      /is 2 but 1 registered node\(s\) reach the 66% bar.*no floor fits \(it is at least 2\): the node weights must change/,
    );
  });

  const facts = { threshold: 66n, minNodes: 2 };

  async function setup(weights: number[] | null, floor: number) {
    const f = await handoverFixture();
    const s = await ethers.getSigners();
    const nodes = [12, 13, 14, 15]
      .slice(0, weights ? weights.length : 3)
      .map((i) => s[i].address);
    const om = f.c.oracleManager.connect(f.deployer);
    for (const a of nodes) await om.registerOracle(a, "N", "node", 500);
    if (weights)
      for (const [i, w] of weights.entries())
        await om.setOracleWeight(nodes[i], w);
    const wl = f.args.oracles[0];
    await (
      await wl.connect(f.deployer).setMinimumConsensusOracles(floor)
    ).wait();
    const args = { ...f.args, oracleNodes: nodes };
    const wlAddr = await wl.getAddress();
    const line = async () =>
      (await assertHandoverComplete(args)).checks.find((c: any) =>
        c.label.includes("the fewest registered nodes that reach"),
      );
    return { f, args, nodes, wlAddr, line };
  }

  it("3 equal nodes at 66%: floor 3 fails everywhere, naming the oracle, floor and count", async function () {
    const { f, args, nodes, wlAddr, line } = await setup(null, 3);
    const row = await line();
    expect(row.ok).to.equal(false);
    expect(row.label).to.contain(`list oracle ${wlAddr}`);
    expect(row.label).to.contain(
      "minimumConsensusOracles (3) <= 2, the fewest registered nodes that reach the 66% bar",
    );
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
      /minimumConsensusOracles is 3 but 2 registered node\(s\) reach the 66% bar: a query resolves at 2 vote\(s\) and takes no more, so every verdict fails TooFewVoters/,
    );
    const why = await floorRefusal(f.args, nodes, facts);
    expect(why).to.match(
      new RegExp(`^list oracle ${wlAddr} minimumConsensusOracles is 3 but 2`),
    );
  });

  it("3 equal nodes, floor 2: passes", async function () {
    const { f, nodes, line } = await setup(null, 2);
    expect((await line()).ok).to.equal(true);
    expect(await floorRefusal(f.args, nodes, facts)).to.equal(null);
  });

  it("two heavy nodes reach the bar alone together: floor 3 fails", async function () {
    const { f, nodes, line } = await setup([1000, 1000, 100, 100], 3);
    const row = await line();
    expect(row.ok).to.equal(false);
    expect(row.label).to.contain("minimumConsensusOracles (3) <= 2");
    expect(await floorRefusal(f.args, nodes, facts)).to.match(
      /is 3 but 2 registered node/,
    );
  });
});
