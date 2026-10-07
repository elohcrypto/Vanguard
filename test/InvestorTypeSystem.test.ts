import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { InvestorTypeRegistry, IdentityRegistry } from "../typechain-types";
import { configureKyc } from "./helpers/kyc";

describe("Investor Type System", function () {
  let investorTypeRegistry: InvestorTypeRegistry;
  let identityRegistry: IdentityRegistry;

  let owner: SignerWithAddress;
  let complianceOfficer: SignerWithAddress;
  let normalInvestor: SignerWithAddress;
  let retailInvestor: SignerWithAddress;
  let accreditedInvestor: SignerWithAddress;
  let institutionalInvestor: SignerWithAddress;
  let recipient: SignerWithAddress;

  const VSC_DECIMALS = 18;
  const VSC = (amount: number) =>
    ethers.parseUnits(amount.toString(), VSC_DECIMALS);

  beforeEach(async function () {
    [
      owner,
      complianceOfficer,
      normalInvestor,
      retailInvestor,
      accreditedInvestor,
      institutionalInvestor,
      recipient,
    ] = await ethers.getSigners();

    // Deploy InvestorTypeRegistry
    const InvestorTypeRegistryFactory = await ethers.getContractFactory(
      "InvestorTypeRegistry",
    );
    investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
    await investorTypeRegistry.waitForDeployment();

    // Deploy IdentityRegistry
    const IdentityRegistryFactory =
      await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistryFactory.deploy();
    await identityRegistry.waitForDeployment();

    // Registration alone no longer verifies (plan Task 1R.2). This suite
    // never asserts isVerified/mint/transfer, so no wallet here needs a
    // claim, but the registry still requires a configured KYC issuer so it
    // is not left running in permissive mode.
    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(identityRegistry, await kycIssuer.getAddress());

    // Set up compliance officer
    await investorTypeRegistry.setComplianceOfficer(
      complianceOfficer.address,
      true,
    );

    // Register identities for testing
    await identityRegistry.registerIdentity(
      normalInvestor.address,
      normalInvestor.address,
      1,
    ); // US
    await identityRegistry.registerIdentity(
      retailInvestor.address,
      retailInvestor.address,
      1,
    ); // US
    await identityRegistry.registerIdentity(
      accreditedInvestor.address,
      accreditedInvestor.address,
      1,
    ); // US
    await identityRegistry.registerIdentity(
      institutionalInvestor.address,
      institutionalInvestor.address,
      1,
    ); // US
    await identityRegistry.registerIdentity(
      recipient.address,
      recipient.address,
      1,
    ); // US
  });

  describe("InvestorTypeRegistry", function () {
    it("Should have correct default configurations", async function () {
      const [
        normalConfig,
        retailConfig,
        accreditedConfig,
        institutionalConfig,
      ] = await investorTypeRegistry.getAllInvestorTypeConfigs();

      // Normal Investor
      expect(normalConfig.maxTransferAmount).to.equal(VSC(8000));
      expect(normalConfig.maxHoldingAmount).to.equal(VSC(50000));
      expect(normalConfig.requiredWhitelistTier).to.equal(1);
      expect(normalConfig.transferCooldownMinutes).to.equal(60);
      expect(normalConfig.enhancedLogging).to.equal(false);

      // Retail Investor
      expect(retailConfig.maxTransferAmount).to.equal(VSC(8000));
      expect(retailConfig.maxHoldingAmount).to.equal(VSC(50000));
      expect(retailConfig.requiredWhitelistTier).to.equal(2);
      expect(retailConfig.transferCooldownMinutes).to.equal(60);

      // Accredited Investor
      expect(accreditedConfig.maxTransferAmount).to.equal(VSC(50000));
      expect(accreditedConfig.maxHoldingAmount).to.equal(VSC(500000));
      expect(accreditedConfig.requiredWhitelistTier).to.equal(3);
      expect(accreditedConfig.transferCooldownMinutes).to.equal(30);
      expect(accreditedConfig.enhancedLogging).to.equal(true);

      // Institutional Investor
      expect(institutionalConfig.maxTransferAmount).to.equal(VSC(500000));
      expect(institutionalConfig.maxHoldingAmount).to.equal(VSC(5000000));
      expect(institutionalConfig.requiredWhitelistTier).to.equal(4);
      expect(institutionalConfig.transferCooldownMinutes).to.equal(15);
      expect(institutionalConfig.enhancedLogging).to.equal(true);
    });

    it("Should allow compliance officer to assign investor types", async function () {
      // Assign investor types
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(normalInvestor.address, 0); // Normal
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(retailInvestor.address, 1); // Retail
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(accreditedInvestor.address, 2); // Accredited
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(institutionalInvestor.address, 3); // Institutional

      // Verify assignments
      expect(
        await investorTypeRegistry.getInvestorType(normalInvestor.address),
      ).to.equal(0);
      expect(
        await investorTypeRegistry.getInvestorType(retailInvestor.address),
      ).to.equal(1);
      expect(
        await investorTypeRegistry.getInvestorType(accreditedInvestor.address),
      ).to.equal(2);
      expect(
        await investorTypeRegistry.getInvestorType(
          institutionalInvestor.address,
        ),
      ).to.equal(3);
    });

    it("Should allow compliance officer to upgrade investor types", async function () {
      // Assign initial type
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(normalInvestor.address, 0); // Normal

      // Upgrade to retail
      await expect(
        investorTypeRegistry
          .connect(complianceOfficer)
          .upgradeInvestorType(normalInvestor.address, 1),
      )
        .to.emit(investorTypeRegistry, "InvestorTypeUpgraded")
        .withArgs(normalInvestor.address, 0, 1, complianceOfficer.address);

      expect(
        await investorTypeRegistry.getInvestorType(normalInvestor.address),
      ).to.equal(1);
    });

    it("Should allow compliance officer to downgrade investor types", async function () {
      // Assign initial type
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(accreditedInvestor.address, 2); // Accredited

      // Downgrade to retail
      await expect(
        investorTypeRegistry
          .connect(complianceOfficer)
          .downgradeInvestorType(accreditedInvestor.address, 1),
      )
        .to.emit(investorTypeRegistry, "InvestorTypeDowngraded")
        .withArgs(accreditedInvestor.address, 2, 1, complianceOfficer.address);

      expect(
        await investorTypeRegistry.getInvestorType(accreditedInvestor.address),
      ).to.equal(1);
    });

    it("Should validate transfer amounts based on investor type", async function () {
      // Assign investor types
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(normalInvestor.address, 0); // Normal
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(accreditedInvestor.address, 2); // Accredited

      // Normal investor - should be limited to 8,000 VSC
      expect(
        await investorTypeRegistry.canTransferAmount(
          normalInvestor.address,
          VSC(8000),
        ),
      ).to.be.true;
      expect(
        await investorTypeRegistry.canTransferAmount(
          normalInvestor.address,
          VSC(8001),
        ),
      ).to.be.false;

      // Accredited investor - should be limited to 50,000 VSC
      expect(
        await investorTypeRegistry.canTransferAmount(
          accreditedInvestor.address,
          VSC(50000),
        ),
      ).to.be.true;
      expect(
        await investorTypeRegistry.canTransferAmount(
          accreditedInvestor.address,
          VSC(50001),
        ),
      ).to.be.false;
    });

    it("Should validate holding amounts based on investor type", async function () {
      // Assign investor types
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(normalInvestor.address, 0); // Normal
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(institutionalInvestor.address, 3); // Institutional

      // Normal investor - should be limited to 50,000 VSC
      expect(
        await investorTypeRegistry.canHoldAmount(
          normalInvestor.address,
          VSC(50000),
        ),
      ).to.be.true;
      expect(
        await investorTypeRegistry.canHoldAmount(
          normalInvestor.address,
          VSC(50001),
        ),
      ).to.be.false;

      // Institutional investor - should be limited to 5,000,000 VSC
      expect(
        await investorTypeRegistry.canHoldAmount(
          institutionalInvestor.address,
          VSC(5000000),
        ),
      ).to.be.true;
      expect(
        await investorTypeRegistry.canHoldAmount(
          institutionalInvestor.address,
          VSC(5000001),
        ),
      ).to.be.false;
    });

    it("Should detect large transfers correctly", async function () {
      // Assign investor types
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(accreditedInvestor.address, 2); // Accredited
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(institutionalInvestor.address, 3); // Institutional

      // Accredited investor - large transfer threshold is 10,000 VSC
      expect(
        await investorTypeRegistry.isLargeTransfer(
          accreditedInvestor.address,
          VSC(10000),
        ),
      ).to.be.false;
      expect(
        await investorTypeRegistry.isLargeTransfer(
          accreditedInvestor.address,
          VSC(10001),
        ),
      ).to.be.true;

      // Institutional investor - large transfer threshold is 100,000 VSC
      expect(
        await investorTypeRegistry.isLargeTransfer(
          institutionalInvestor.address,
          VSC(100000),
        ),
      ).to.be.false;
      expect(
        await investorTypeRegistry.isLargeTransfer(
          institutionalInvestor.address,
          VSC(100001),
        ),
      ).to.be.true;
    });
  });

  describe("Access Control", function () {
    it("Should only allow compliance officers to assign investor types", async function () {
      await expect(
        investorTypeRegistry
          .connect(normalInvestor)
          .assignInvestorType(recipient.address, 1),
      ).to.be.revertedWith("Not authorized compliance officer");
    });

    it("Should only allow owner to update configurations", async function () {
      const newConfig = {
        maxTransferAmount: VSC(10000),
        maxHoldingAmount: VSC(60000),
        requiredWhitelistTier: 2,
        transferCooldownMinutes: 30,
        largeTransferThreshold: VSC(5000),
        enhancedLogging: true,
        enhancedPrivacy: true,
      };

      await expect(
        investorTypeRegistry
          .connect(normalInvestor)
          .updateInvestorTypeConfig(0, newConfig),
      ).to.be.revertedWithCustomError(
        investorTypeRegistry,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
