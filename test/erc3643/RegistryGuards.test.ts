import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { AML_TOPIC, KYC_TOPIC } from "../helpers/kyc";

// Plan v2 Task 2F.5 (L2, L3). InvestorTypeRegistry side-governance: a
// proposal belongs to the governor set it was created under and expires;
// createProposal checks the tier like updateInvestorTypeConfig.
// IdentityRegistry: governance cannot vote away the last issuer of a
// required topic, nor the last topic (either makes everyone unverified and
// governance can never vote again).
describe("Registry guards (2F.5)", function () {
  const E = ethers.parseEther;
  const DAY = 86400;
  const cfg = (tier = 2) => ({
    maxTransferAmount: E("9000"),
    maxHoldingAmount: E("60000"),
    requiredWhitelistTier: tier,
    transferCooldownMinutes: 30,
    largeTransferThreshold: E("4000"),
    enhancedLogging: false,
    enhancedPrivacy: false,
  });
  const jump = async (s: number) => {
    await ethers.provider.send("evm_increaseTime", [s]);
    await ethers.provider.send("evm_mine", []);
  };

  describe("InvestorTypeRegistry proposals", function () {
    let owner: SignerWithAddress, g1: SignerWithAddress, g2: SignerWithAddress;
    let reg: any;

    beforeEach(async function () {
      [owner, g1, g2] = await ethers.getSigners();
      reg = await (
        await ethers.getContractFactory("InvestorTypeRegistry")
      ).deploy();
      await reg.setGovernor(g1.address, true, 1);
      await reg.setGovernor(g2.address, true, 1);
    });

    async function approvedProposal() {
      await reg.connect(g1).createProposal(1, cfg(), "raise retail");
      await reg.connect(g1).approveProposal(1);
      await reg.connect(g2).approveProposal(1);
      return 1;
    }

    it("createProposal applies the whitelist tier check", async function () {
      for (const tier of [0, 6]) {
        await expect(
          reg.connect(g1).createProposal(1, cfg(tier), "bad tier"),
        ).to.be.revertedWith("Invalid whitelist tier");
      }
    });

    it("an approved proposal executes once the delay passes", async function () {
      const id = await approvedProposal();
      expect(await reg.isProposalOpen(id)).to.equal(true);
      await jump(2 * DAY + 1);
      await reg.executeProposal(id);
      expect((await reg.getInvestorTypeConfig(1)).maxTransferAmount).to.equal(
        E("9000"),
      );
      expect(await reg.isProposalOpen(id)).to.equal(false);
    });

    it("a proposal from an older governor set cannot execute (P0)", async function () {
      // Planted before the ceremony; the ceremony then changes the set.
      const id = await approvedProposal();
      await reg.connect(g1).createProposal(2, cfg(3), "still pending");
      const epoch = await reg.governorEpoch();
      await reg.setGovernor(g2.address, false, 0);
      expect(await reg.governorEpoch()).to.equal(epoch + 1n);
      expect(await reg.isProposalOpen(id)).to.equal(false);
      await jump(2 * DAY + 1);
      await expect(reg.executeProposal(id))
        .to.be.revertedWithCustomError(reg, "GovernorSetChanged")
        .withArgs(id);
      await expect(reg.connect(g1).approveProposal(2))
        .to.be.revertedWithCustomError(reg, "GovernorSetChanged")
        .withArgs(2);
    });

    it("re-adding the same governors does not revive an old proposal", async function () {
      const id = await approvedProposal();
      await reg.setGovernor(g2.address, false, 0);
      await reg.setGovernor(g2.address, true, 1);
      await jump(2 * DAY + 1);
      await expect(reg.executeProposal(id)).to.be.revertedWithCustomError(
        reg,
        "GovernorSetChanged",
      );
    });

    it("a proposal expires 7 days after its execution time", async function () {
      const id = await approvedProposal();
      await jump(2 * DAY + 7 * DAY + 2);
      expect(await reg.isProposalOpen(id)).to.equal(false);
      await expect(reg.executeProposal(id))
        .to.be.revertedWithCustomError(reg, "ProposalExpired")
        .withArgs(id);
    });

    it("an expired or stale proposal is not open; a fresh one is", async function () {
      expect(await reg.isProposalOpen(99)).to.equal(false);
      await reg.connect(g1).createProposal(2, cfg(3), "pending");
      expect(await reg.isProposalOpen(1)).to.equal(true);
      await reg.cancelProposal(1);
      expect(await reg.isProposalOpen(1)).to.equal(false);
    });
  });

  describe("IdentityRegistry claim configuration", function () {
    let reg: any, kyc: string, kyc2: string, aml: string;

    beforeEach(async function () {
      const [owner] = await ethers.getSigners();
      reg = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      const CI = await ethers.getContractFactory("ClaimIssuer");
      const mk = async (n: string) =>
        (await CI.deploy(owner.address, n, n)).getAddress();
      [kyc, kyc2, aml] = [await mk("KYC"), await mk("KYC2"), await mk("AML")];
      await reg.addClaimTopic(KYC_TOPIC);
      await reg.addClaimTopic(AML_TOPIC);
      await reg.addTrustedIssuer(kyc, [KYC_TOPIC]);
      await reg.addTrustedIssuer(aml, [AML_TOPIC]);
    });

    it("refuses removing the last issuer of a required topic", async function () {
      await expect(reg.removeTrustedIssuer(kyc)).to.be.revertedWith(
        "Last issuer for required topic",
      );
      // A second issuer for the topic makes the first removable.
      await reg.addTrustedIssuer(kyc2, [KYC_TOPIC]);
      await reg.removeTrustedIssuer(kyc);
      expect(await reg.getTrustedIssuersForClaimTopic(KYC_TOPIC)).to.deep.equal(
        [kyc2],
      );
    });

    it("an issuer of a topic that is no longer required can go", async function () {
      await reg.removeClaimTopic(AML_TOPIC);
      await reg.removeTrustedIssuer(aml);
      expect(await reg.isTrustedIssuer(aml, AML_TOPIC)).to.equal(false);
    });

    it("refuses removing the last claim topic", async function () {
      await reg.removeClaimTopic(AML_TOPIC);
      await expect(reg.removeClaimTopic(KYC_TOPIC)).to.be.revertedWith(
        "Last claim topic",
      );
      expect(await reg.getClaimTopics()).to.deep.equal([BigInt(KYC_TOPIC)]);
    });
  });
});
