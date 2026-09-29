import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";

const {
  castAcceptanceVotes,
  handoverDeployerPowers,
  proposeAcceptOwnership,
  settleProposal,
} = require("../../demo/utils/Handover");
const { planFor } = require("../../demo/utils/HandoverChecks");

// Review M5: scripts/handover.ts resumes after a partial run
// (HANDOVER_PHASE=accept) and checks the proposer and voters before step 1.
describe("Handover CLI (scripts/handover.ts)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let quiet: typeof console.log;

  beforeEach(async function () {
    f = await handoverFixture();
    const a = async (k: string) => f.c[k].getAddress();
    cfg = {
      token: await a("token"),
      governanceToken: await a("governanceToken"),
      identityRegistry: await a("identityRegistry"),
      complianceRules: await a("complianceRules"),
      oracleManager: await a("oracleManager"),
      governance: f.govAddr,
      investorTypeRegistry: await a("investorTypeRegistry"),
      dynamicListManager: await a("dynamicListManager"),
      oracles: [await f.args.oracles[0].getAddress()],
      issuers: [await f.args.issuers[0].getAddress()],
      logChunk: 100,
      // Signer order from handoverFixture.
      ops: 1,
      guardian: 2,
      proposer: 4,
      voters: [5, 6],
    };
    quiet = console.log;
    console.log = () => {};
  });
  afterEach(function () {
    console.log = quiet;
  });

  it("the full phase completes", async function () {
    await runHandover(cfg);
    expect(await f.c.token.owner()).to.equal(f.govAddr);
  });

  it("the accept phase finishes a partial run, registry calls included", async function () {
    const { c, govAddr, proposer, voters } = f;
    // Option 83b gave governance the registry, so step 1 queues its calls
    // as proposals; the queue is then lost (a new process).
    const reg = c.investorTypeRegistry;
    await reg.transferOwnership(govAddr);
    const rid = await proposeAcceptOwnership(
      c.governance,
      proposer,
      reg,
      0,
      "R",
    );
    await castAcceptanceVotes(c.governance, rid, voters);
    await settleProposal(c.governance, rid, "R");
    const report = await handoverDeployerPowers(f.args);
    expect(report.registryProposals).to.have.length(2);
    // Every acceptance but OracleManager's is voted.
    for (const e of planFor(c)) {
      if (e.key === "oracleManager" || e.key === "investorTypeRegistry")
        continue;
      const id = await proposeAcceptOwnership(
        c.governance,
        proposer,
        c[e.key],
        e.proposalType,
        e.label,
      );
      await castAcceptanceVotes(c.governance, id, voters);
      await settleProposal(c.governance, id, e.label);
    }
    expect(await c.oracleManager.owner()).to.equal(f.deployer.address);
    // A full re-run is refused: governance already owns Token.
    await expect(runHandover(cfg)).to.be.rejectedWith(/does not own Token/);

    await runHandover(cfg, "accept");
    expect(await c.oracleManager.owner()).to.equal(govAddr);
    expect(await reg.isComplianceOfficer(f.ops.address)).to.equal(true);
    expect(await reg.isComplianceOfficer(f.deployer.address)).to.equal(false);
  });

  it("refuses an unverified voter before any transaction", async function () {
    cfg.voters = [5, 3]; // 3 is the unverified stranger
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(runHandover(cfg)).to.be.rejectedWith(
      /voter 0x[0-9a-fA-F]+ is not verified/,
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("refuses a voter without VGT for every vote", async function () {
    const bob = f.voters[0];
    const vgt = f.c.governanceToken;
    await vgt
      .connect(bob)
      .transfer(f.proposer.address, (await vgt.balanceOf(bob.address)) - 1n);
    await expect(runHandover(cfg)).to.be.rejectedWith(
      // Eight plan contracts, votingCost 10 VGT each.
      /voter .* holds 0\.0+1 free VGT; 8 proposal\(s\) need 80\.0/,
    );
  });
});
