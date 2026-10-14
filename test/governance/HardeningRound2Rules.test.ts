import { expect } from "chai";
import { ethers } from "hardhat";
import { govFixture, NOOP } from "../helpers/governanceFixture";

/**
 * One behavioural test per contract change in hardening round 2. Each was
 * reproduced as a defect before the change; the "before" shape is noted.
 */
describe("Hardening round 2 — contract changes", () => {
  describe("B2: cost setters are bounded, observable, ownership two-step", () => {
    it("emits old and new on both setters", async () => {
      const { owner, gov } = await govFixture();
      const ten = ethers.parseEther("10"),
        fifty = ethers.parseEther("50");
      await expect(gov.connect(owner).setVotingCost(fifty))
        .to.emit(gov, "VotingCostUpdated")
        .withArgs(ten, fifty);
      await expect(gov.connect(owner).setProposalCreationCost(fifty))
        .to.emit(gov, "ProposalCreationCostUpdated")
        .withArgs(ten, fifty);
    });

    it("rejects zero and anything above MAX_COST, accepts MAX_COST", async () => {
      const { owner, gov } = await govFixture();
      const max = await gov.MAX_COST();
      // Before: any uint256 was accepted, so cost > every balance froze voting.
      await expect(
        gov.connect(owner).setVotingCost(0),
      ).to.be.revertedWithCustomError(gov, "CostOutOfRange");
      await expect(
        gov.connect(owner).setVotingCost(max + 1n),
      ).to.be.revertedWithCustomError(gov, "CostOutOfRange");
      await gov.connect(owner).setVotingCost(max);
      expect(await gov.votingCost()).to.equal(max);
    });

    it("transferOwnership alone does not move ownership", async () => {
      const { owner, alice, gov } = await govFixture();
      await gov.connect(owner).transferOwnership(alice.address);
      expect(await gov.owner()).to.equal(owner.address);
      expect(await gov.pendingOwner()).to.equal(alice.address);
      await gov.connect(alice).acceptOwnership();
      expect(await gov.owner()).to.equal(alice.address);
    });
  });

  describe("B3: agent changes are on the log", () => {
    it("Token emits AgentAdded/AgentRemoved and rejects address(0)", async () => {
      const { owner, alice, ir, cr } = await govFixture();
      const token = await (
        await ethers.getContractFactory("Token")
      ).deploy("VSC", "VSC", await ir.getAddress(), await cr.getAddress());
      await expect(token.connect(owner).addAgent(alice.address))
        .to.emit(token, "AgentAdded")
        .withArgs(alice.address);
      expect(await token.isAgent(alice.address)).to.equal(true);
      await expect(token.connect(owner).removeAgent(alice.address))
        .to.emit(token, "AgentRemoved")
        .withArgs(alice.address);
      await expect(
        token.connect(owner).addAgent(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(token, "ZeroAgent");
    });

    it("IdentityRegistry emits AgentAdded/AgentRemoved", async () => {
      const { owner, alice, ir } = await govFixture();
      await expect(ir.connect(owner).addAgent(alice.address))
        .to.emit(ir, "AgentAdded")
        .withArgs(alice.address);
      await expect(ir.connect(owner).removeAgent(alice.address))
        .to.emit(ir, "AgentRemoved")
        .withArgs(alice.address);
    });
  });

  describe("B4: ComplianceRules has no module surface", () => {
    it("addModule/removeModule/getModules are not in the ABI; hooks remain", async () => {
      const { owner } = await govFixture();
      const cr = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(owner.address, [840], [643]);
      for (const n of ["addModule", "removeModule", "getModules"])
        expect(
          cr.interface.fragments.some((f: any) => f.name === n),
          n,
        ).to.equal(false);
      for (const n of [
        "transferred",
        "created",
        "destroyed",
        "canTransfer",
        "isTrustedContract",
        "isProductionCompliance",
      ])
        expect(
          cr.interface.fragments.some((f: any) => f.name === n),
          n,
        ).to.equal(true);
    });
  });

  describe("B5-C1: voting power is balance plus delegated, no mirror", () => {
    it("getVotingPower tracks balanceOf through transfers and delegation", async () => {
      const { alice, bob, gt } = await govFixture();
      expect(await gt.getVotingPower(alice.address)).to.equal(
        await gt.balanceOf(alice.address),
      );
      await gt.connect(alice).transfer(bob.address, ethers.parseEther("100"));
      expect(await gt.getVotingPower(alice.address)).to.equal(
        ethers.parseEther("900"),
      );
      expect(await gt.getVotingPower(bob.address)).to.equal(
        ethers.parseEther("1100"),
      );
      await gt.connect(alice).delegate(bob.address);
      expect(await gt.getVotingPower(bob.address)).to.equal(
        ethers.parseEther("2000"),
      );
    });
  });

  describe("B5-C2: the fake snapshot API is gone", () => {
    it("GovernanceToken ABI has no snapshot functions or event", async () => {
      const { gt } = await govFixture();
      for (const n of [
        "snapshot",
        "getVotingPowerAt",
        "setSnapshotVotingPower",
        "getCurrentSnapshotId",
        "SnapshotCreated",
      ])
        expect(
          gt.interface.fragments.some((f: any) => f.name === n),
          n,
        ).to.equal(false);
      // The parts that are real stay.
      for (const n of [
        "getVotingPower",
        "delegate",
        "distributeGovernanceTokens",
        "burn",
      ])
        expect(
          gt.interface.fragments.some((f: any) => f.name === n),
          n,
        ).to.equal(true);
    });

    it("ProposalCreated has four args and the struct has no snapshotId", async () => {
      const { owner, alice, gov } = await govFixture();
      const ev = gov.interface.getEvent("ProposalCreated")!;
      expect(ev.inputs.map((i) => i.name)).to.deep.equal([
        "proposalId",
        "proposer",
        "proposalType",
        "title",
      ]);
      await expect(
        gov.connect(alice).createProposal(0, "t", "d", owner.address, NOOP),
      )
        .to.emit(gov, "ProposalCreated")
        .withArgs(1n, alice.address, 0n, "t");
      const [p] = await gov.getProposal(1);
      expect((p as any).snapshotId).to.equal(undefined);
      expect(p.eligibleVotersAtCreation).to.equal(4n); // voters only (D21)
    });
  });
});
