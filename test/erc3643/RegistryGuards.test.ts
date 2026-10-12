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

    // Task 4.15 (C §2 InvestorTypeGovernance rows, M13, N20). The
    // "Invalid investor type" require (type > Institutional) is unreachable
    // from outside: the ABI decoder refuses a value outside the enum first.
    it("createProposal checks the amounts and the cooldown bound", async function () {
      const c = cfg();
      await expect(
        reg.connect(g1).createProposal(1, { ...c, maxTransferAmount: 0 }, ""),
      ).to.be.revertedWith("Invalid max transfer amount");
      await expect(
        reg.connect(g1).createProposal(1, { ...c, maxHoldingAmount: 0 }, ""),
      ).to.be.revertedWith("Invalid max holding amount");
      await expect(
        reg
          .connect(g1)
          .createProposal(1, { ...c, transferCooldownMinutes: 43_201 }, ""),
      )
        .to.be.revertedWithCustomError(reg, "CooldownAboveMax")
        .withArgs(43_201, 43_200);
      await expect(reg.connect(owner).connect(g2).createProposal(1, c, "")).to
        .not.be.reverted;
    });

    it("approve, execute and cancel refuse an unknown id, a cancelled and an executed proposal", async function () {
      for (const call of [
        async () => reg.connect(g1).approveProposal(99),
        async () => reg.executeProposal(99),
        async () => reg.cancelProposal(99),
      ])
        await expect(call()).to.be.revertedWith("Proposal does not exist");
      await reg.connect(g1).createProposal(1, cfg(), "to cancel");
      await reg.cancelProposal(1);
      await expect(reg.connect(g1).approveProposal(1)).to.be.revertedWith(
        "Proposal not active",
      );
      await expect(reg.executeProposal(1)).to.be.revertedWith(
        "Proposal not executable",
      );
      await reg.connect(g1).createProposal(1, cfg(), "to execute"); // id 2
      await reg.connect(g1).approveProposal(2);
      await reg.connect(g2).approveProposal(2);
      await jump(2 * DAY + 1);
      await reg.executeProposal(2);
      await expect(reg.cancelProposal(2)).to.be.revertedWith(
        "Proposal not cancellable",
      );
    });

    it("setGovernor, cancelProposal, authorizeToken and the parameters are the owner's (M13, N20)", async function () {
      const s = reg.connect(g1);
      for (const call of [
        async () => s.setGovernor(g1.address, true, 1),
        async () => s.cancelProposal(1),
        async () => s.authorizeToken(await reg.getAddress(), true),
        async () => s.updateGovernanceParameters(DAY, 1),
      ])
        await expect(call())
          .to.be.revertedWithCustomError(reg, "OwnableUnauthorizedAccount")
          .withArgs(g1.address);
      await expect(
        reg.setGovernor(ethers.ZeroAddress, true, 1),
      ).to.be.revertedWith("Invalid governor address");
    });

    it("governance parameters are bounded (N20)", async function () {
      await expect(reg.updateGovernanceParameters(3599, 1)).to.be.revertedWith(
        "Delay too short",
      );
      await expect(
        reg.updateGovernanceParameters(30 * DAY + 1, 1),
      ).to.be.revertedWith("Delay too long");
      await expect(reg.updateGovernanceParameters(3600, 0)).to.be.revertedWith(
        "Need at least 1 approval",
      );
      await expect(reg.updateGovernanceParameters(3600, 3))
        .to.emit(reg, "GovernanceParametersUpdated")
        .withArgs(3600, 3);
      expect(await reg.governanceDelay()).to.equal(3600);
      expect(await reg.requiredApprovals()).to.equal(3);
    });
  });

  // Task 4.15 (C §2: M14, N30, N32, N78, N31). Every registry write is an
  // agent's; the owner is an agent by construction and stays one when its
  // flag is cleared (the modifier's second arm).
  describe("IdentityRegistry agent gate", function () {
    let owner: SignerWithAddress, agent: SignerWithAddress;
    let stranger: SignerWithAddress, alice: SignerWithAddress;
    let bob: SignerWithAddress, carol: SignerWithAddress;
    let reg: any, idA: string, idB: string;
    const NOT_AGENT = "Not authorized agent";
    const keyOf = (a: string) =>
      ethers.solidityPackedKeccak256(["address"], [a]);

    beforeEach(async function () {
      [owner, agent, stranger, alice, bob, carol] = await ethers.getSigners();
      reg = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      const OID = await ethers.getContractFactory("OnchainID");
      const mk = async (w: SignerWithAddress) =>
        (await OID.deploy(w.address)).getAddress();
      [idA, idB] = [await mk(alice), await mk(bob)];
      await reg.registerIdentity(alice.address, idA, 840);
      await reg.addAgent(agent.address);
    });

    it("every write is refused to a stranger (M14, N30, N32)", async function () {
      const r = reg.connect(stranger);
      await expect(
        r.registerIdentity(bob.address, idB, 840),
      ).to.be.revertedWith(NOT_AGENT);
      await expect(
        r.batchRegisterIdentity([bob.address], [idB], [840]),
      ).to.be.revertedWith(NOT_AGENT);
      await expect(r.updateIdentity(alice.address, idA)).to.be.revertedWith(
        NOT_AGENT,
      );
      await expect(r.updateCountry(alice.address, 344)).to.be.revertedWith(
        NOT_AGENT,
      );
      await expect(
        r.moveIdentity(alice.address, carol.address),
      ).to.be.revertedWith(NOT_AGENT);
      await expect(r.deleteIdentity(alice.address)).to.be.revertedWith(
        NOT_AGENT,
      );
      expect(await reg.identity(alice.address)).to.equal(idA);
    });

    it("an agent that is not the owner, and the owner without its flag, take every path", async function () {
      const a = reg.connect(agent);
      await a.batchRegisterIdentity([bob.address], [idB], [840]);
      await a.updateCountry(alice.address, 344);
      expect(await reg.investorCountry(alice.address)).to.equal(344);
      await a.updateIdentity(alice.address, idA);
      // carol controls bob's identity through an ACTION key (D41).
      const id = await ethers.getContractAt("OnchainID", idB);
      await id.connect(bob).addKey(keyOf(carol.address), 2, 1);
      await a.moveIdentity(bob.address, carol.address);
      expect(await reg.identity(carol.address)).to.equal(idB);
      await a.deleteIdentity(carol.address);
      expect(await reg.identity(carol.address)).to.equal(ethers.ZeroAddress);
      // The owner's own flag cleared: still an agent through owner().
      await reg.removeAgent(owner.address);
      expect(await reg.isAgent(owner.address)).to.equal(false);
      await reg.updateCountry(alice.address, 840);
      expect(await reg.investorCountry(alice.address)).to.equal(840);
    });

    it("deleteIdentity of an unregistered wallet: Identity not found (N78)", async function () {
      await expect(reg.deleteIdentity(bob.address)).to.be.revertedWith(
        "Identity not found",
      );
      await expect(reg.updateCountry(bob.address, 1)).to.be.revertedWith(
        "Identity not registered",
      );
    });

    it("moveIdentity refuses a taken wallet, an unregistered source and zero (N31)", async function () {
      await reg.registerIdentity(bob.address, idB, 840);
      await expect(reg.moveIdentity(alice.address, bob.address))
        .to.be.revertedWithCustomError(reg, "WalletAlreadyHasIdentity")
        .withArgs(bob.address);
      await expect(reg.moveIdentity(carol.address, stranger.address))
        .to.be.revertedWithCustomError(reg, "IdentityNotRegistered")
        .withArgs(carol.address);
      await expect(
        reg.moveIdentity(alice.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(reg, "InvalidNewWallet");
      expect(await reg.identity(alice.address)).to.equal(idA);
    });

    it("addAgent, removeAgent and setComplianceRules are the owner's; no zero agent", async function () {
      const s = reg.connect(stranger);
      for (const call of [
        async () => s.addAgent(stranger.address),
        async () => s.removeAgent(agent.address),
        async () =>
          s.setComplianceRules(await reg.getAddress(), await reg.getAddress()),
      ])
        await expect(call())
          .to.be.revertedWithCustomError(reg, "OwnableUnauthorizedAccount")
          .withArgs(stranger.address);
      await expect(reg.addAgent(ethers.ZeroAddress)).to.be.revertedWith(
        "Invalid agent address",
      );
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
      // An issuer first, then its topic (2F.5 review L-1).
      await reg.addTrustedIssuer(kyc, [KYC_TOPIC]);
      await reg.addTrustedIssuer(aml, [AML_TOPIC]);
      await reg.addClaimTopic(KYC_TOPIC);
      await reg.addClaimTopic(AML_TOPIC);
    });

    it("refuses requiring a topic no trusted issuer covers (review L-1)", async function () {
      await expect(reg.addClaimTopic(99)).to.be.revertedWith(
        "No trusted issuer for topic",
      );
      await reg.addTrustedIssuer(kyc2, [99]);
      await reg.addClaimTopic(99);
      expect(await reg.getClaimTopics()).to.deep.include(99n);
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

    // Task 4.15 (C §2 RegistryVerification rows: N26, N27, N28, N79).
    it("the four admin calls are the owner's (N26, N27, N79)", async function () {
      const [, stranger] = await ethers.getSigners();
      const s = reg.connect(stranger);
      for (const call of [
        async () => s.addTrustedIssuer(kyc2, [KYC_TOPIC]),
        async () => s.removeTrustedIssuer(kyc),
        async () => s.addClaimTopic(99),
        async () => s.removeClaimTopic(AML_TOPIC),
      ])
        await expect(call())
          .to.be.revertedWithCustomError(reg, "OwnableUnauthorizedAccount")
          .withArgs(stranger.address);
      expect(await reg.isTrustedIssuer(kyc, KYC_TOPIC)).to.equal(true);
      expect(await reg.getClaimTopics()).to.have.lengthOf(2);
    });

    it("an issuer is a contract with at least one topic (N28); the topic lists are kept honest", async function () {
      const [, stranger] = await ethers.getSigners();
      await expect(reg.addTrustedIssuer(stranger.address, [KYC_TOPIC]))
        .to.be.revertedWithCustomError(reg, "IssuerNotAContract")
        .withArgs(stranger.address);
      await expect(reg.addTrustedIssuer(kyc2, [])).to.be.revertedWith(
        "No topics",
      );
      await expect(reg.addClaimTopic(KYC_TOPIC)).to.be.revertedWith(
        "Topic already required",
      );
      await expect(reg.removeClaimTopic(99)).to.be.revertedWith(
        "Topic not required",
      );
      await expect(reg.removeTrustedIssuer(kyc2)).to.be.revertedWith(
        "Issuer not trusted",
      );
    });

    it("at most MAX_TRUSTED_ISSUERS_PER_TOPIC issuers per topic; a repeat is skipped", async function () {
      const [owner] = await ethers.getSigners();
      const CI = await ethers.getContractFactory("ClaimIssuer");
      const max = Number(await reg.MAX_TRUSTED_ISSUERS_PER_TOPIC());
      for (let i = 1; i < max; i++) {
        const issuer = await CI.deploy(owner.address, `I${i}`, `I${i}`);
        await reg.addTrustedIssuer(await issuer.getAddress(), [KYC_TOPIC]);
      }
      expect(
        await reg.getTrustedIssuersForClaimTopic(KYC_TOPIC),
      ).to.have.lengthOf(max);
      await expect(reg.addTrustedIssuer(kyc2, [KYC_TOPIC]))
        .to.be.revertedWithCustomError(reg, "TooManyTrustedIssuers")
        .withArgs(KYC_TOPIC);
      // Already trusted for the topic: skipped, not counted twice.
      await reg.addTrustedIssuer(kyc, [KYC_TOPIC, 99]);
      expect(
        await reg.getTrustedIssuersForClaimTopic(KYC_TOPIC),
      ).to.have.lengthOf(max);
      expect(await reg.isTrustedIssuer(kyc, 99)).to.equal(true);
    });
  });
});
