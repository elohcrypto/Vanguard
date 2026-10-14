import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { VGT, deployGovernanceToken } from "./helpers/governanceTokenFixture";
import { NOOP } from "./helpers/governanceFixture";

describe("Governance Token System", function () {
  let governanceToken: any;
  let vanguardGovernance: any;
  let identityRegistry: any;
  let complianceRules: any;
  let owner: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let nonVoter: SignerWithAddress;

  beforeEach(async function () {
    ({
      governanceToken,
      vanguardGovernance,
      identityRegistry,
      complianceRules,
      owner,
      voter1,
      voter2,
      nonVoter,
    } = await deployGovernanceToken());
  });

  describe("GovernanceToken Deployment", function () {
    it("Should deploy with correct initial supply", async function () {
      const totalSupply = await governanceToken.totalSupply();
      expect(totalSupply).to.equal(VGT(1_000_000));
    });

    it("Should assign initial supply to owner", async function () {
      const ownerBalance = await governanceToken.balanceOf(owner.address);
      expect(ownerBalance).to.equal(VGT(1_000_000));
    });

    it("Should set correct name and symbol", async function () {
      expect(await governanceToken.name()).to.equal(
        "Vanguard Governance Token",
      );
      expect(await governanceToken.symbol()).to.equal("VGT");
    });

    it("Should set owner voting power equal to balance", async function () {
      const votingPower = await governanceToken.getVotingPower(owner.address);
      expect(votingPower).to.equal(VGT(1_000_000));
    });
  });

  describe("Token Distribution", function () {
    it("Should distribute tokens to verified addresses", async function () {
      await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address],
        [VGT(10000), VGT(20000)],
      );

      expect(await governanceToken.balanceOf(voter1.address)).to.equal(
        VGT(10000),
      );
      expect(await governanceToken.balanceOf(voter2.address)).to.equal(
        VGT(20000),
      );
    });

    it("Should update voting power after distribution", async function () {
      await governanceToken.distributeGovernanceTokens(
        [voter1.address],
        [VGT(10000)],
      );

      expect(await governanceToken.getVotingPower(voter1.address)).to.equal(
        VGT(10000),
      );
    });

    it("Should fail to distribute to non-verified address", async function () {
      // Verify nonVoter is NOT registered
      const isVerified = await identityRegistry.isVerified(nonVoter.address);
      expect(isVerified).to.be.false;

      // Distribution should fail because nonVoter is not KYC/AML verified
      // The transfer() function enforces the whenTransferAllowed modifier
      try {
        await governanceToken.distributeGovernanceTokens(
          [nonVoter.address],
          [VGT(10000)],
        );
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.include("Recipient not verified");
      }
    });
  });

  describe("Voting Power Delegation", function () {
    beforeEach(async function () {
      await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address],
        [VGT(10000), VGT(20000)],
      );
    });

    it("Should allow delegation of voting power", async function () {
      await governanceToken.connect(voter1).delegate(voter2.address);

      const voter1Power = await governanceToken.getVotingPower(voter1.address);
      const voter2Power = await governanceToken.getVotingPower(voter2.address);

      expect(voter1Power).to.equal(VGT(10000)); // Still has tokens
      expect(voter2Power).to.equal(VGT(30000)); // 20000 + 10000 delegated
    });

    it("Should emit DelegateChanged event", async function () {
      await expect(governanceToken.connect(voter1).delegate(voter2.address))
        .to.emit(governanceToken, "DelegateChanged")
        .withArgs(voter1.address, ethers.ZeroAddress, voter2.address);
    });

    it("Should not allow delegation to self", async function () {
      await expect(
        governanceToken.connect(voter1).delegate(voter1.address),
      ).to.be.revertedWith("Cannot delegate to self");
    });

    it("Should not allow delegation to zero address", async function () {
      await expect(
        governanceToken.connect(voter1).delegate(ethers.ZeroAddress),
      ).to.be.revertedWith("Cannot delegate to zero address");
    });
  });

  describe("VanguardGovernance - Proposal Creation", function () {
    beforeEach(async function () {
      await governanceToken.distributeGovernanceTokens(
        [voter1.address],
        [VGT(15000)], // Above 10,000 threshold
      );
    });

    it("Should create proposal with sufficient tokens", async function () {
      // Approve VanguardGovernance to spend tokens for proposal creation
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      await governanceToken
        .connect(voter1)
        .approve(await vanguardGovernance.getAddress(), proposalCost);

      await expect(
        vanguardGovernance.connect(voter1).createProposal(
          1, // ComplianceRules
          "Test Proposal",
          "Test Description",
          await complianceRules.getAddress(),
          NOOP,
        ),
      ).to.emit(vanguardGovernance, "ProposalCreated");
    });

    it("Should fail to create proposal without sufficient tokens", async function () {
      await expect(
        vanguardGovernance
          .connect(voter2)
          .createProposal(
            1,
            "Test Proposal",
            "Test Description",
            await complianceRules.getAddress(),
            NOOP,
          ),
      ).to.be.revertedWith("Insufficient tokens for proposal creation");
    });
  });
});
