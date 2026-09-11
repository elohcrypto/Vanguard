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
      1, // timeScale: mainnet schedule
    );
    await gov.waitForDeployment();

    // Thresholds exist and are non-zero — they are configured, not absent.
    const t = await gov.proposalThresholds(0);
    expect(t.quorumPercentage).to.be.greaterThan(0n);
  });

  // This slot previously held a SOURCE-TEXT test: it sliced 1600 characters
  // out of executeProposal and asserted the substrings "quorumPercentage",
  // "Quorum not met" and "registeredIdentityCount" appeared. It was brittle in
  // both directions and proved nothing about behaviour.
  //
  // It broke twice for reasons unrelated to correctness. Adding explanatory
  // comments pushed the code past the 1600-character window, so the assertion
  // failed while the logic was right. Then the quorum fix legitimately removed
  // "Quorum not met" (a failed quorum now REJECTS AND REFUNDS instead of
  // reverting) and moved the denominator to a creation-time snapshot, so two
  // more assertions became false while the contract got safer.
  //
  // A test that fails when comments grow, and that pins the exact identifiers
  // a fix must change, blocks correct work and permits incorrect work. The
  // behavioural equivalents live in
  // test/GovernanceComplianceIntegration.test.ts ("Quorum enforcement"):
  // refund below quorum, refund on zero votes, snapshot immunity to mid-vote
  // registration, and advisory/enforcement agreement — all executed on chain.
  //
  // What remains here is the structural fact those tests depend on and cannot
  // easily assert themselves: the thresholds exist and are non-zero.
  it("configures a non-zero quorum for every proposal type", async () => {
    const [owner] = await ethers.getSigners();

    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const cr = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    const gt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", await ir.getAddress(), await cr.getAddress());
    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await gt.getAddress(),
      await ir.getAddress(),
      owner.address,
      owner.address,
      owner.address,
      owner.address,
      1, // timeScale: mainnet schedule
    );
    await gov.waitForDeployment();

    // Ten ProposalType values; every one must define a real bar. A zero quorum
    // would make that type executable by a single voter, which is the
    // vulnerability the behavioural tests guard against.
    for (let t = 0; t < 10; t++) {
      const th = await gov.proposalThresholds(t);
      expect(th.quorumPercentage, `type ${t} quorum`).to.be.greaterThan(0n);
      expect(th.approvalPercentage, `type ${t} approval`).to.be.greaterThan(
        5000n,
      );
    }
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
