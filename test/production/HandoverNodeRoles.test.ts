import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

/**
 * Task 5.17 slice C, the node checks of the preflight, completion and
 * day-2 audit (demo/utils/HandoverNodes.js):
 *  - deep review M-5 (D25 b, a node is a key of its own): ops, the
 *    guardian, the issuer admin, the proposer, a voter and an
 *    IdentityRegistry agent registered as nodes are refused, the line
 *    naming the node and its role;
 *  - deep review M-4: a node set of 1 to MIN_NODES - 1 (after removals)
 *    FAILS completion with a MIN_NODES line, and its weight share reads
 *    n/a; at MIN_NODES or more it passes.
 */
describe("Handover node checks: role keys and MIN_NODES (M-4, M-5)", function () {
  this.timeout(300_000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let args: Record<string, any>;
  const ROLE_LINE =
    "no OracleManager node is ops, the guardian, the issuer admin, the proposer, a voter or a registry/VGT agent";

  beforeEach(async function () {
    f = await handoverFixture();
    args = {
      ...f.args,
      // As handoverArgs gives them: the proposer first, then the voters.
      voterWallets: [f.proposer, ...f.voters],
    };
  });
  const om = () => f.c.oracleManager;

  for (const [who, pick] of [
    ["ops", () => f.ops],
    ["the guardian", () => f.guardian],
    ["the issuer admin", () => f.issuerAdmin],
    ["the proposer", () => f.proposer],
    ["a voter", () => f.voters[1]],
  ] as const) {
    it(`refuses ${who} as a node in the preflight and fails it in completion`, async function () {
      const a = (pick() as any).address;
      await om().registerOracle(a, "ROLE", "", 500);
      args.oracleNodes = [a];
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        `OracleManager node(s) ${a} (${who}) hold a role key: a node is a key of its own (D25 b)`,
      );
      const { failures } = await assertHandoverComplete(args);
      expect(failures).to.include(ROLE_LINE);
    });
  }

  it("refuses an IdentityRegistry agent as a node", async function () {
    const a = f.stranger.address;
    await f.c.identityRegistry.addAgent(a);
    await om().registerOracle(a, "AGENT", "", 500);
    args.oracleNodes = [a];
    const { failures } = await assertHandoverComplete(args);
    expect(failures).to.include(ROLE_LINE);
  });

  it("fails completion below MIN_NODES (weight share n/a); no such line at three", async function () {
    const signers = await ethers.getSigners();
    const nodes = [signers[12], signers[13], signers[14]].map((s) => s.address);
    for (const [i, a] of nodes.entries())
      await om().registerOracle(a, `N${i}`, "", 500);
    args.oracleNodes = nodes;
    const row = (r: any) =>
      r.checks.find((c: any) =>
        c.label.startsWith("no OracleManager node alone reaches"),
      );
    const full = await assertHandoverComplete(args);
    expect(
      full.failures.filter((l: string) => /MIN_NODES/.test(l)),
    ).to.deep.equal([]);
    // Two of three removed: one node left, no query can open.
    await om().removeOracle(nodes[0], "test");
    await om().removeOracle(nodes[1], "test");
    args.oracleNodes = [nodes[2]];
    const one = await assertHandoverComplete(args);
    expect(one.ok).to.equal(false);
    expect(one.failures).to.include(
      "OracleManager has 1 registered node(s), at least ConsensusOracle.MIN_NODES (2)",
    );
    expect(row(one).label).to.include("weight shares: n/a (below MIN_NODES)");
    expect(row(one).label).to.not.include("100%");
  });
});
