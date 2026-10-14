import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  GovernanceToken,
  VanguardGovernance,
  InvestorTypeRegistry,
} from "../typechain-types";
import {
  createInvestorTypeConfig,
  deployFairVoting,
} from "./helpers/fairVotingFixture";

describe("Fair Voting System (1 Person = 1 Vote)", function () {
  let governanceToken: GovernanceToken;
  let vanguardGovernance: VanguardGovernance;
  let investorTypeRegistry: InvestorTypeRegistry;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;
  let unverified: SignerWithAddress;

  before(async function () {
    ({
      governanceToken,
      vanguardGovernance,
      investorTypeRegistry,
      owner,
      alice,
      bob,
      carol,
      dave,
      unverified,
    } = await deployFairVoting());
  });

  describe("Governance ownership handover", function () {
    let snapshotId: string;

    before(async function () {
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    after(async function () {
      await ethers.provider.send("evm_revert", [snapshotId]);
    });

    // The registry is Ownable2Step, so a nomination alone changes nothing.
    // VanguardGovernance's only external-call path is executeProposal, so
    // for it to become owner a proposal must be created, voted through the
    // configured quorum and approval thresholds, and executed. This proves
    // the whole chain rather than impersonating the contract.
    it("Should take ownership only after a proposal passes and executes", async function () {
      const registryAddr = await investorTypeRegistry.getAddress();
      const govAddr = await vanguardGovernance.getAddress();

      // Earlier describe blocks snapshot/revert around themselves and
      // set finite allowances, so the MaxUint256 approvals from
      // beforeEach may no longer be in effect by the time this runs.
      // Re-approve so this test does not depend on another block's
      // leftover state.
      for (const s of [alice, bob, carol, dave]) {
        await governanceToken.connect(s).approve(govAddr, ethers.MaxUint256);
      }

      // Reset to a fresh two-step handover: hand the registry back to
      // the deployer, then re-nominate governance.
      await ethers.provider.send("hardhat_impersonateAccount", [govAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        govAddr,
        "0x1000000000000000000",
      ]);
      const asGov = await ethers.getSigner(govAddr);
      await investorTypeRegistry
        .connect(asGov)
        .transferOwnership(owner.address);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [govAddr]);
      await investorTypeRegistry.acceptOwnership();
      expect(await investorTypeRegistry.owner()).to.equal(owner.address);

      // Step 1: nominate governance. Ownership must NOT move yet.
      await investorTypeRegistry.transferOwnership(govAddr);
      expect(await investorTypeRegistry.owner()).to.equal(owner.address);
      expect(await investorTypeRegistry.pendingOwner()).to.equal(govAddr);
      console.log(
        `   Nominated. owner still ${owner.address.slice(0, 10)}…, pending = governance`,
      );

      // Step 2: a real proposal to call acceptOwnership().
      const callData =
        investorTypeRegistry.interface.encodeFunctionData("acceptOwnership");
      const before = await vanguardGovernance.proposalCount();
      await vanguardGovernance.connect(alice).createProposal(
        0, // InvestorTypeConfig: 20% quorum, 60% approval
        "Accept ownership of InvestorTypeRegistry",
        "Complete the Ownable2Step handover to governance",
        registryAddr,
        callData,
      );
      const proposalId = Number(before) + 1;

      // Step 3: vote. Alice proposed, so she may not vote on it.
      await vanguardGovernance.connect(bob).castVote(proposalId, true, "FOR");
      await vanguardGovernance.connect(carol).castVote(proposalId, true, "FOR");
      await vanguardGovernance.connect(dave).castVote(proposalId, true, "FOR");

      const [, totalVotes, participationBps, canExecuteBefore] =
        await vanguardGovernance.getProposal(proposalId);
      console.log(
        `   Votes: ${totalVotes}, turnout ${Number(participationBps) / 100}%`,
      );

      // Still not owner: the vote has not been executed.
      expect(await investorTypeRegistry.owner()).to.equal(owner.address);

      // Voting period + execution delay.
      await ethers.provider.send("evm_increaseTime", [9 * 24 * 60 * 60 + 60]);
      await ethers.provider.send("evm_mine", []);

      const [, , , canExecute] =
        await vanguardGovernance.getProposal(proposalId);
      expect(canExecute, "proposal must clear quorum and approval").to.equal(
        true,
      );

      // Step 4: execute — governance calls acceptOwnership on itself.
      await vanguardGovernance.executeProposal(proposalId);

      expect(await investorTypeRegistry.owner()).to.equal(govAddr);
      expect(await investorTypeRegistry.pendingOwner()).to.equal(
        ethers.ZeroAddress,
      );
      console.log("   ✅ Ownership transferred to governance by vote");

      // The owner-only power now genuinely belongs to governance: the
      // previous owner can no longer change config.
      await expect(
        investorTypeRegistry.updateInvestorTypeConfig(
          2,
          createInvestorTypeConfig("1", "2"),
        ),
      ).to.be.revertedWithCustomError(
        investorTypeRegistry,
        "OwnableUnauthorizedAccount",
      );
      console.log("   ✅ Former owner can no longer update config");
    });

    // A nomination that is never accepted leaves ownership untouched —
    // this is what makes the two-step version safe against a mistyped or
    // non-accepting address.
    it("Should leave ownership unchanged if the nominee never accepts", async function () {
      const startOwner = await investorTypeRegistry.owner();
      const govAddr = await vanguardGovernance.getAddress();

      await ethers.provider.send("hardhat_impersonateAccount", [govAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        govAddr,
        "0x1000000000000000000",
      ]);
      const asGov = await ethers.getSigner(govAddr);
      // Nominate an address that will never call acceptOwnership.
      await investorTypeRegistry
        .connect(asGov)
        .transferOwnership(unverified.address);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [govAddr]);

      expect(await investorTypeRegistry.owner()).to.equal(startOwner);
      expect(await investorTypeRegistry.pendingOwner()).to.equal(
        unverified.address,
      );
      console.log("   ✅ Un-accepted nomination did not move ownership");
    });
  });
});
