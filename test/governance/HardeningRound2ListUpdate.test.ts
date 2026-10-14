import { expect } from "chai";
import { ethers } from "hardhat";
import { govFixture } from "../helpers/governanceFixture";

/**
 * One behavioural test per contract change in hardening round 2. Each was
 * reproduced as a defect before the change; the "before" shape is noted.
 */
describe("Hardening round 2 — contract changes", () => {
  describe("R5: a list-update proposal whose manager call reverts is settled, not stuck", () => {
    const D = 9 * 86400 + 60;
    const LIST_UPDATE = 6;
    async function listFixture() {
      const base = await govFixture();
      const dlm = await (
        await ethers.getContractFactory("DynamicListManager")
      ).deploy(base.owner.address);
      return { ...base, dlm };
    }
    // ListUpdate is a plain call on the manager (plan 2D.1): the proposal's
    // calldata is one of its four add/remove functions.
    async function passedListProposal(
      gov: any,
      alice: any,
      bob: any,
      carol: any,
      dlm: any,
      callData: string,
    ) {
      await gov
        .connect(alice)
        .createProposal(
          LIST_UPDATE,
          "list",
          "d",
          await dlm.getAddress(),
          callData,
        );
      const id = await gov.proposalCount();
      await gov.connect(bob).castVote(id, true, "y");
      await gov.connect(carol).castVote(id, true, "y");
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      return id;
    }
    const addWl = (dlm: any, user: string) =>
      dlm.interface.encodeFunctionData("addToWhitelist", [
        user,
        1,
        1,
        365 * 86400,
        "r",
      ]);

    it("manager call reverts (oracles unset): Rejected, claimable, reason preserved", async () => {
      const { alice, bob, carol, gov, govAddr, dlm, ids } = await listFixture();
      await gov.setDynamicListManager(await dlm.getAddress());
      await dlm.setGovernanceContract(govAddr);
      // The manager fails closed with no oracle to write.
      const id = await passedListProposal(
        gov,
        alice,
        bob,
        carol,
        dlm,
        addWl(dlm, bob.address),
      );
      await expect(gov.executeProposal(id))
        .to.emit(gov, "ProposalExecutionFailed")
        .withArgs(id, (data: string) => {
          const err = gov.interface.parseError(data);
          expect(err?.name).to.equal("Error");
          expect(err?.args[0]).to.equal("DynamicListManager: oracles not set");
          return true;
        });
      const [p] = await gov.getProposal(id);
      expect(p.status).to.equal(3n);
      expect(await gov.getClaimableRefund(id, ids.alice)).to.equal(
        ethers.parseEther("10"),
      );
      expect(await gov.getClaimableRefund(id, ids.bob)).to.equal(
        ethers.parseEther("10"),
      );
    });

    it("manager not authorised settles the same way", async () => {
      const { alice, bob, carol, gov, govAddr, dlm, ids } = await listFixture();
      await gov.setDynamicListManager(await dlm.getAddress());
      // createProposal requires the manager to report this governance, so
      // the unauthorised state arises only after the vote: the manager is
      // re-pointed elsewhere before execution.
      await dlm.setGovernanceContract(govAddr);
      const a = await passedListProposal(
        gov,
        alice,
        bob,
        carol,
        dlm,
        addWl(dlm, bob.address),
      );
      await dlm.setGovernanceContract(alice.address);
      await expect(gov.executeProposal(a))
        .to.emit(gov, "ProposalExecutionFailed")
        .withArgs(
          a,
          (data: string) =>
            gov.interface.parseError(data)?.args[0] ===
            "Only owner or governance",
        );
      expect(await gov.getClaimableRefund(a, ids.alice)).to.equal(
        ethers.parseEther("10"),
      );
    });

    it("manager never set: ListUpdate cannot be proposed at all", async () => {
      // Fail closed at creation: boundTarget(ListUpdate) is address(0), so no
      // vote can be opened that could never execute.
      const { alice, gov, dlm } = await listFixture();
      const target = await dlm.getAddress();
      await expect(
        gov
          .connect(alice)
          .createProposal(
            LIST_UPDATE,
            "list",
            "d",
            target,
            addWl(dlm, alice.address),
          ),
      )
        .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
        .withArgs(LIST_UPDATE, target);
    });

    it("a passed ListUpdate writes a permanent blacklist entry to the oracle", async () => {
      const { alice, bob, carol, gov, govAddr, dlm, ids } = await listFixture();
      const om = await (
        await ethers.getContractFactory("OracleManager")
      ).deploy();
      const omAddr = await om.getAddress();
      const wl = await (
        await ethers.getContractFactory("WhitelistOracle")
      ).deploy(omAddr, "WL", "d");
      const bl = await (
        await ethers.getContractFactory("BlacklistOracle")
      ).deploy(omAddr, "BL", "d");
      const dlmAddr = await dlm.getAddress();
      await dlm.setOracles(await wl.getAddress(), await bl.getAddress());
      await wl.setListManager(dlmAddr);
      await bl.setListManager(dlmAddr);
      await gov.setDynamicListManager(dlmAddr);
      await dlm.setGovernanceContract(govAddr);
      const HIGH = 2;
      const cd = dlm.interface.encodeFunctionData("addToBlacklist", [
        carol.address,
        5,
        HIGH,
        ethers.MaxUint256,
        "r",
      ]);
      const id = await passedListProposal(gov, alice, bob, carol, dlm, cd);
      await expect(gov.executeProposal(id))
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(carol.address, true, HIGH, 0, "r", false);
      await ethers.provider.send("evm_increaseTime", [10 * 365 * 86400]);
      await ethers.provider.send("evm_mine", []);
      expect(await dlm.getUserStatus(carol.address)).to.equal(2n);
      await expect(bl.cleanupExpiredEntries([carol.address])).to.not.emit(
        bl,
        "BlacklistUpdated",
      );
      expect(await bl.isBlacklisted(carol.address)).to.equal(true);
    });

    it("timeScale divides every voting period and delay; 1 is the mainnet schedule", async () => {
      const { owner, gt, ir } = await govFixture();
      const F = await ethers.getContractFactory("VanguardGovernance");
      const args = [
        await gt.getAddress(),
        await ir.getAddress(),
        owner.address,
        owner.address,
        owner.address,
        owner.address,
      ] as const;
      const g1 = await F.deploy(...args, 1);
      const g336 = await F.deploy(...args, 336);
      const DAY = 86400n;
      // Expected mainnet table, straight from _initializeThresholds.
      const expect1: Record<number, [bigint, bigint]> = {
        0: [7n * DAY, 2n * DAY],
        1: [7n * DAY, 2n * DAY],
        2: [7n * DAY, 2n * DAY],
        3: [7n * DAY, 3n * DAY],
        4: [7n * DAY, 2n * DAY],
        5: [3n * DAY, 1n * DAY],
        6: [5n * DAY, 1n * DAY], // ListUpdate
        7: [7n * DAY, 2n * DAY], // IdentityRegistryParameters
        8: [7n * DAY, 3n * DAY], // GovernanceTokenParameters
        9: [7n * DAY, 3n * DAY], // EscrowFactoryParameters
        10: [7n * DAY, 3n * DAY], // IdentityFactoryParameters
        11: [7n * DAY, 3n * DAY], // PrivacyParameters
        12: [7n * DAY, 3n * DAY], // VerifierParameters
      };
      for (let t = 0; t <= 12; t++) {
        const a = await g1.proposalThresholds(t),
          b = await g336.proposalThresholds(t);
        expect(
          [a.votingPeriod, a.executionDelay],
          `type ${t} @1`,
        ).to.deep.equal(expect1[t]);
        expect(
          [b.votingPeriod, b.executionDelay],
          `type ${t} @336`,
        ).to.deep.equal([expect1[t][0] / 336n, expect1[t][1] / 336n]);
        // Percentages are never scaled.
        expect(b.quorumPercentage).to.equal(a.quorumPercentage);
        expect(b.approvalPercentage).to.equal(a.approvalPercentage);
      }
      expect(await g336.TIME_SCALE()).to.equal(336n);
      // 7 days / 336 = 30 minutes exactly.
      expect((await g336.proposalThresholds(0)).votingPeriod).to.equal(1800n);
      // Ceiling: at the max scale the SHORTEST duration in the table (1 day)
      // must still be >= 60s. Integer division floors, and a 0s delay or a
      // 2s vote (seen at scale 100000) makes a proposal unvotable.
      const gMax = await F.deploy(...args, 1440);
      for (let t = 0; t <= 8; t++) {
        const m = await gMax.proposalThresholds(t);
        expect(m.votingPeriod, `type ${t} vote @1440`).to.be.at.least(60n);
        expect(m.executionDelay, `type ${t} delay @1440`).to.be.at.least(60n);
      }
      expect((await gMax.proposalThresholds(5)).executionDelay).to.equal(60n); // 1 day / 1440
      await expect(F.deploy(...args, 0))
        .to.be.revertedWithCustomError(F, "TimeScaleOutOfRange")
        .withArgs(0);
      await expect(F.deploy(...args, 1441))
        .to.be.revertedWithCustomError(F, "TimeScaleOutOfRange")
        .withArgs(1441);
    });

    it("control: a wired manager call executes, writes the WhitelistOracle, and burns", async () => {
      const { owner, alice, bob, carol, gt, gov, govAddr, dlm } =
        await listFixture();
      const om = await (
        await ethers.getContractFactory("OracleManager")
      ).deploy();
      const omAddr = await om.getAddress();
      const wl = await (
        await ethers.getContractFactory("WhitelistOracle")
      ).deploy(omAddr, "WL", "d");
      const bl = await (
        await ethers.getContractFactory("BlacklistOracle")
      ).deploy(omAddr, "BL", "d");
      const dlmAddr = await dlm.getAddress();
      await gov.setDynamicListManager(dlmAddr);
      await dlm.setGovernanceContract(govAddr);
      await dlm.setOracles(await wl.getAddress(), await bl.getAddress());
      await wl.connect(owner).setListManager(dlmAddr);
      await bl.connect(owner).setListManager(dlmAddr);
      expect(await wl.isWhitelisted(bob.address)).to.equal(false);
      const id = await passedListProposal(
        gov,
        alice,
        bob,
        carol,
        dlm,
        addWl(dlm, bob.address),
      );
      const s0 = await gt.totalSupply();
      await expect(gov.executeProposal(id))
        .to.emit(gov, "ProposalExecuted")
        .withArgs(id);
      // The vote reached the oracle ComplianceRules reads: it now gates transfers.
      expect(await wl.isWhitelisted(bob.address)).to.equal(true);
      expect(await dlm.getUserStatus(bob.address)).to.equal(1n); // WHITELISTED
      expect(s0 - (await gt.totalSupply())).to.equal(ethers.parseEther("30"));
    });
  });
});
