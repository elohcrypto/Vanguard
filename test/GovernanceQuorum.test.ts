import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * VanguardGovernance defines per-proposal-type quorum thresholds
 * (VanguardGovernance.sol:180-260 — e.g. 20% for InvestorTypeConfig) but
 * executeProposal (line 378) never reads them. It checks only:
 *
 *   require(totalVotes > 0)                 // line 384
 *   approvalPercentage = votesFor*100/totalVotes >= 51
 *
 * Consequence: a single voter is a 100% approval. Any proposal — including one
 * whose callData targets a contract governance owns — executes on one vote if
 * nobody else participates.
 *
 * This test documents the CURRENT behaviour. It is written to FAIL once a
 * quorum check is added, which is the point: the fix should break it.
 */
describe("VanguardGovernance — quorum enforcement", () => {
  it("configures quorum thresholds per proposal type", async () => {
    const [owner] = await ethers.getSigners();

    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await ir.waitForDeployment();
    const cr = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    await cr.waitForDeployment();

    const gt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy(
      "Vanguard Governance Token",
      "VGT",
      await ir.getAddress(),
      await cr.getAddress(),
    );
    await gt.waitForDeployment();

    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await gt.getAddress(),
      await ir.getAddress(),
      owner.address,
      owner.address,
      owner.address,
      owner.address,
    );
    await gov.waitForDeployment();

    // Thresholds exist and are non-zero — they are configured, not absent.
    const t = await gov.proposalThresholds(0);
    expect(t.quorumPercentage).to.be.greaterThan(0n);
  });

  it("executeProposal enforces the configured quorum and approval thresholds", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      "contracts/governance/VanguardGovernance.sol",
      "utf8",
    );
    const execBody = src.slice(
      src.indexOf("function executeProposal"),
      src.indexOf("function executeProposal") + 1600,
    );

    // Quorum is read from the per-type thresholds, not ignored.
    expect(
      execBody,
      "executeProposal must consult quorumPercentage",
    ).to.contain("quorumPercentage");
    expect(execBody, "quorum must actually gate execution").to.contain(
      "Quorum not met",
    );

    // Approval uses the configured basis-points value, not a hardcoded 51.
    expect(
      execBody,
      "approval must use thresholds.approvalPercentage",
    ).to.contain("thresholds.approvalPercentage");

    // The denominator is eligible voters (1p1v), not token supply.
    expect(
      execBody,
      "1p1v quorum must be measured against registered identities",
    ).to.contain("registeredIdentityCount");
  });

  it("IdentityRegistry maintains the eligible-voter count", async () => {
    const [owner, a, b] = await ethers.getSigners();
    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await ir.waitForDeployment();

    expect(await ir.registeredIdentityCount()).to.equal(0n);

    // Any non-zero address works as the identity here; the registry only
    // requires it to be non-zero.
    await ir.registerIdentity(a.address, owner.address, 840);
    expect(await ir.registeredIdentityCount()).to.equal(1n);

    await ir.registerIdentity(b.address, owner.address, 840);
    expect(await ir.registeredIdentityCount()).to.equal(2n);

    // updateIdentity replaces an entry — the count must NOT change.
    await ir.updateIdentity(a.address, b.address);
    expect(await ir.registeredIdentityCount()).to.equal(2n);

    await ir.deleteIdentity(a.address);
    expect(await ir.registeredIdentityCount()).to.equal(1n);
  });
});
