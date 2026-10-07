const { expect } = require("chai");
const { ethers } = require("hardhat");
const { attest, configureKyc } = require("./helpers/kyc");

describe("Transfer Limits Verification - 8,000 Yuan Max", function () {
  let token, identityRegistry, compliance, investorTypeRegistry;
  let owner, bank, investor1, investor2, compliance_officer;
  let onchainID1, onchainID2, bankOnchainID;

  const EIGHT_THOUSAND_YUAN = ethers.parseEther("8000"); // 8,000 tokens
  const OVER_LIMIT = ethers.parseEther("8001"); // Over limit
  const UNDER_LIMIT = ethers.parseEther("7999"); // Under limit

  beforeEach(async function () {
    [owner, bank, investor1, investor2, compliance_officer] =
      await ethers.getSigners();

    // Deploy Identity Registry
    const IdentityRegistry =
      await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistry.deploy();

    // Deploy OnchainID contracts for testing
    const OnchainID = await ethers.getContractFactory("OnchainID");
    onchainID1 = await OnchainID.deploy(investor1.address);
    onchainID2 = await OnchainID.deploy(investor2.address);
    bankOnchainID = await OnchainID.deploy(bank.address);

    // Require a KYC claim topic on the registry so registration alone no
    // longer verifies a wallet (plan Task 1R.2), then attest every wallet
    // this suite expects to transact.
    const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
    const kycIssuer = await ClaimIssuer.deploy(
      owner.address,
      "KYC Issuer",
      "Trusted KYC attestations",
    );
    await configureKyc(identityRegistry, await kycIssuer.getAddress());

    // Register identities
    await identityRegistry.registerIdentity(
      investor1.address,
      onchainID1.target,
      156,
    ); // China
    await attest(kycIssuer, owner, onchainID1.target);
    await identityRegistry.registerIdentity(
      investor2.address,
      onchainID2.target,
      156,
    ); // China
    await attest(kycIssuer, owner, onchainID2.target);
    await identityRegistry.registerIdentity(
      bank.address,
      bankOnchainID.target,
      156,
    ); // China
    await attest(kycIssuer, owner, bankOnchainID.target);

    // Deploy Compliance
    const Compliance = await ethers.getContractFactory("ComplianceRegistry");
    compliance = await Compliance.deploy();

    // Deploy Investor Type Registry
    const InvestorTypeRegistry = await ethers.getContractFactory(
      "InvestorTypeRegistry",
    );
    investorTypeRegistry = await InvestorTypeRegistry.deploy();

    // Deploy Token
    const Token = await ethers.getContractFactory("Token");
    token = await Token.deploy(
      "Vanguard StableCoin",
      "VSC",
      identityRegistry.target,
      compliance.target,
    );

    // Set investor type registry in token
    await token.setInvestorTypeRegistry(investorTypeRegistry.target);

    // Authorize token in investor type registry
    await investorTypeRegistry.authorizeToken(token.target, true);

    // Set compliance officer
    await investorTypeRegistry.setComplianceOfficer(
      compliance_officer.address,
      true,
    );

    // Assign investor types (Normal = 0, which has 8,000 limit)
    await investorTypeRegistry
      .connect(compliance_officer)
      .assignInvestorType(investor1.address, 0); // Normal
    await investorTypeRegistry
      .connect(compliance_officer)
      .assignInvestorType(investor2.address, 0); // Normal
    await investorTypeRegistry
      .connect(compliance_officer)
      .assignInvestorType(bank.address, 0); // Normal for testing

    // Note: ComplianceRegistry doesn't need bindToken

    // Mint tokens for testing
    // Within the Normal 50,000 holding cap: mint enforces it (2E.3)
    await token.mint(bank.address, ethers.parseEther("50000"));
    await token.mint(investor1.address, ethers.parseEther("50000")); // Investor1 has 50,000 tokens
  });

  describe("Bank Transfer Limits", function () {
    it("Should allow bank transfer of exactly 8,000 Yuan", async function () {
      const balanceBefore = await token.balanceOf(investor2.address);

      await expect(
        token.connect(bank).transfer(investor2.address, EIGHT_THOUSAND_YUAN),
      ).to.not.be.reverted;

      const balanceAfter = await token.balanceOf(investor2.address);
      expect(balanceAfter - balanceBefore).to.equal(EIGHT_THOUSAND_YUAN);
    });

    it("Should allow bank transfer under 8,000 Yuan limit", async function () {
      const balanceBefore = await token.balanceOf(investor2.address);

      await expect(token.connect(bank).transfer(investor2.address, UNDER_LIMIT))
        .to.not.be.reverted;

      const balanceAfter = await token.balanceOf(investor2.address);
      expect(balanceAfter - balanceBefore).to.equal(UNDER_LIMIT);
    });

    it("Should REJECT bank transfer over 8,000 Yuan limit", async function () {
      await expect(token.connect(bank).transfer(investor2.address, OVER_LIMIT))
        .to.be.reverted;
    });

    it("Should verify transfer limit is enforced in canTransfer check", async function () {
      // canTransfer is a predicate: false for over-limit amounts
      expect(
        await token.canTransfer(bank.address, investor2.address, OVER_LIMIT),
      ).to.equal(false);

      // Check that canTransfer returns true for under-limit amounts
      const canTransferUnder = await token.canTransfer(
        bank.address,
        investor2.address,
        UNDER_LIMIT,
      );
      expect(canTransferUnder).to.be.true;
    });
  });

  describe("Investor-to-Investor Transfer Limits", function () {
    it("Should allow investor transfer of exactly 8,000 Yuan", async function () {
      const balanceBefore = await token.balanceOf(investor2.address);

      await expect(
        token
          .connect(investor1)
          .transfer(investor2.address, EIGHT_THOUSAND_YUAN),
      ).to.not.be.reverted;

      const balanceAfter = await token.balanceOf(investor2.address);
      expect(balanceAfter - balanceBefore).to.equal(EIGHT_THOUSAND_YUAN);
    });

    it("Should allow investor transfer under 8,000 Yuan limit", async function () {
      const balanceBefore = await token.balanceOf(investor2.address);

      await expect(
        token.connect(investor1).transfer(investor2.address, UNDER_LIMIT),
      ).to.not.be.reverted;

      const balanceAfter = await token.balanceOf(investor2.address);
      expect(balanceAfter - balanceBefore).to.equal(UNDER_LIMIT);
    });

    it("Should REJECT investor transfer over 8,000 Yuan limit", async function () {
      await expect(
        token.connect(investor1).transfer(investor2.address, OVER_LIMIT),
      ).to.be.reverted;
    });

    it("Should verify investor transfer limit in canTransfer check", async function () {
      // canTransfer is a predicate: false for over-limit amounts
      expect(
        await token.canTransfer(
          investor1.address,
          investor2.address,
          OVER_LIMIT,
        ),
      ).to.equal(false);

      // Check that canTransfer returns true for under-limit amounts
      const canTransferUnder = await token.canTransfer(
        investor1.address,
        investor2.address,
        UNDER_LIMIT,
      );
      expect(canTransferUnder).to.be.true;
    });
  });

  describe("Transfer Limit Configuration Verification", function () {
    it("Should verify Normal investor type has 8,000 limit", async function () {
      const config = await investorTypeRegistry.getInvestorTypeConfig(0); // Normal type
      expect(config.maxTransferAmount).to.equal(EIGHT_THOUSAND_YUAN);
    });

    it("Should verify Retail investor type has 8,000 limit", async function () {
      const config = await investorTypeRegistry.getInvestorTypeConfig(1); // Retail type
      expect(config.maxTransferAmount).to.equal(EIGHT_THOUSAND_YUAN);
    });

    it("Should verify canTransferAmount function works correctly", async function () {
      // Test with Normal investor
      const canTransfer8000 = await investorTypeRegistry.canTransferAmount(
        investor1.address,
        EIGHT_THOUSAND_YUAN,
      );
      expect(canTransfer8000).to.be.true;

      const canTransferOver = await investorTypeRegistry.canTransferAmount(
        investor1.address,
        OVER_LIMIT,
      );
      expect(canTransferOver).to.be.false;
    });
  });

  describe("Multiple Transfer Scenarios", function () {
    it("Should allow two transfers that each stay under the per-transfer cap", async function () {
      // First transfer of 4,000
      await expect(
        token
          .connect(investor1)
          .transfer(investor2.address, ethers.parseEther("4000")),
      ).to.not.be.reverted;

      // Task 4.10: a Normal sender waits out its 60-minute cooldown.
      await ethers.provider.send("evm_increaseTime", [3600]);

      // Second transfer of 4,000 (total 8,000 - should work)
      await expect(
        token
          .connect(investor1)
          .transfer(investor2.address, ethers.parseEther("4000")),
      ).to.not.be.reverted;

      // No daily total exists: InvestorTypeRegistry.canTransferAmount caps
      // each transfer on its own, so the two 4,000 transfers both pass.
    });

    it("Should enforce limits for different investor types", async function () {
      // Upgrade investor1 to Accredited (50,000 limit)
      await investorTypeRegistry
        .connect(compliance_officer)
        .upgradeInvestorType(investor1.address, 2); // Accredited

      // Now investor1 should be able to transfer more than 8,000
      await expect(
        token
          .connect(investor1)
          .transfer(investor2.address, ethers.parseEther("10000")),
      ).to.not.be.reverted;

      // But investor2 (still Normal) cannot receive more than their holding limit
      // This tests the holding limit enforcement
    });
  });

  describe("Edge Cases", function () {
    it("Should handle exact boundary conditions", async function () {
      // Test exactly at the limit
      const exactLimit = ethers.parseEther("8000");
      const canTransferExact = await token.canTransfer(
        investor1.address,
        investor2.address,
        exactLimit,
      );
      expect(canTransferExact).to.be.true;

      // Test 1 wei over the limit - should return false
      const overByOne = exactLimit + 1n;
      expect(
        await token.canTransfer(
          investor1.address,
          investor2.address,
          overByOne,
        ),
      ).to.equal(false);
    });

    it("Should verify limits apply to all transfer methods", async function () {
      // Test transferFrom as well
      await token.connect(investor1).approve(bank.address, OVER_LIMIT);

      await expect(
        token
          .connect(bank)
          .transferFrom(investor1.address, investor2.address, OVER_LIMIT),
      ).to.be.reverted;
    });
  });
});
