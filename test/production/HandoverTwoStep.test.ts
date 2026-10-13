import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

// Plan v2 Task 5.1. Q7: the list oracles are Ownable2Step, so step 2
// nominates ops and ops accepts; a nomination left on an ops-owned oracle
// is refused before the first transaction. A1F-4: the ceremony prints each
// node's weight share and fails when one node alone reaches the bar.
describe("Handover: two-step oracle ownership and node weight shares (Task 5.1)", function () {
  let f: any;
  const quiet = () => {};

  async function ceremony() {
    const steps: string[] = [];
    const report = await handoverDeployerPowers({
      ...f.args,
      log: (m: string) => steps.push(m),
    });
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: quiet,
    });
    return steps;
  }

  beforeEach(async function () {
    f = await handoverFixture();
  });

  it("step 2 nominates ops and ops accepts each list oracle", async function () {
    const steps = await ceremony();
    for (const o of f.args.oracles) {
      expect(await o.owner()).to.equal(f.ops.address);
      expect(await o.pendingOwner()).to.equal(ethers.ZeroAddress);
      const line = `oracle ${await o.getAddress()} owner: ops (nominated and accepted)`;
      expect(steps.some((s) => s.includes(line))).to.equal(true);
    }
    const { ok, checks } = await assertHandoverComplete(f.args);
    expect(ok).to.equal(true);
    const [o] = f.args.oracles;
    expect(checks).to.deep.include({
      label: `oracle ${await o.getAddress()} has no pending owner`,
      ok: true,
    });
  });

  it("a nomination of ops already made is accepted, not repeated", async function () {
    const [o] = f.args.oracles;
    await o.transferOwnership(f.ops.address);
    await ceremony();
    expect(await o.owner()).to.equal(f.ops.address);
    expect(await o.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("refuses an ops-owned oracle with a pending nominee before any transaction", async function () {
    const [o] = f.args.oracles;
    await o.transferOwnership(f.ops.address);
    await o.connect(f.ops).acceptOwnership();
    await o.connect(f.ops).transferOwnership(f.stranger.address);
    const before = await ethers.provider.getTransactionCount(
      f.deployer.address,
    );
    await expect(handoverDeployerPowers(f.args)).to.be.rejectedWith(
      new RegExp(`is ops-owned with pending owner ${f.stranger.address}`),
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(before);
  });

  it("completion prints node weight shares and fails a node that reaches the bar alone", async function () {
    const nodes = (await ethers.getSigners())
      .slice(9, 12)
      .map((s) => s.address);
    for (const n of nodes)
      await f.c.oracleManager.registerOracle(n, "node", "", 500);
    f.args.oracleNodes = nodes;
    await ceremony();
    const share = (r: any) =>
      r.checks.find((x: any) =>
        x.label.startsWith("no OracleManager node alone reaches the 66% bar"),
      );
    const pass = share(await assertHandoverComplete(f.args));
    expect(pass.ok).to.equal(true);
    expect(pass.label).to.include(`${nodes[0]} 100 (33.3%)`);
    // Governance (the manager's owner now) re-weights one node to 70%.
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(f.govAddr);
    await f.c.oracleManager.connect(gov).setOracleWeight(nodes[0], 467);
    const fail = share(await assertHandoverComplete(f.args));
    expect(fail.ok).to.equal(false);
    expect(fail.label).to.include(`${nodes[0]} 467 (70%)`);
  });

  // Task 5.1 review I5: an engine that does not answer fails the row.
  it("an unreadable node weight fails the weight-share row", async function () {
    const nodes = (await ethers.getSigners())
      .slice(9, 12)
      .map((s) => s.address);
    for (const n of nodes)
      await f.c.oracleManager.registerOracle(n, "node", "", 500);
    f.args.oracleNodes = nodes;
    await ceremony();
    const stub = await (
      await ethers.getContractFactory("WeightlessEngine")
    ).deploy();
    await network.provider.send("hardhat_setCode", [
      await f.c.oracleManager.consensusEngine(),
      await ethers.provider.getCode(await stub.getAddress()),
    ]);
    const row = (await assertHandoverComplete(f.args)).checks.find((x: any) =>
      x.label.startsWith("no OracleManager node alone reaches the"),
    );
    expect(row.ok).to.equal(false);
    expect(row.label).to.include("the 66% bar; weight shares: unreadable");
  });
});
