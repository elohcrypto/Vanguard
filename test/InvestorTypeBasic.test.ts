import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { InvestorTypeRegistry } from "../typechain-types";

describe("Investor Type System - Basic Test", function () {
  let investorTypeRegistry: InvestorTypeRegistry;

  let owner: SignerWithAddress;
  let complianceOfficer: SignerWithAddress;
  let normalInvestor: SignerWithAddress;
  let accreditedInvestor: SignerWithAddress;

  const VSC_DECIMALS = 18;
  const VSC = (amount: number) =>
    ethers.parseUnits(amount.toString(), VSC_DECIMALS);

  beforeEach(async function () {
    [owner, complianceOfficer, normalInvestor, accreditedInvestor] =
      await ethers.getSigners();

    // Deploy InvestorTypeRegistry
    const InvestorTypeRegistryFactory = await ethers.getContractFactory(
      "InvestorTypeRegistry",
    );
    investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
    await investorTypeRegistry.waitForDeployment();

    // Set up compliance officer
    await investorTypeRegistry.setComplianceOfficer(
      complianceOfficer.address,
      true,
    );
  });

  describe("Basic Functionality", function () {
    it("Should deploy contracts successfully", async function () {
      expect(await investorTypeRegistry.getAddress()).to.not.equal(
        ethers.ZeroAddress,
      );
    });

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

      // Accredited Investor
      expect(accreditedConfig.maxTransferAmount).to.equal(VSC(50000));
      expect(accreditedConfig.maxHoldingAmount).to.equal(VSC(500000));
      expect(accreditedConfig.requiredWhitelistTier).to.equal(3);
      expect(accreditedConfig.transferCooldownMinutes).to.equal(30);
    });

    it("Should allow compliance officer to assign investor types", async function () {
      // Assign investor types
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(normalInvestor.address, 0); // Normal
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(accreditedInvestor.address, 2); // Accredited

      // Verify assignments
      expect(
        await investorTypeRegistry.getInvestorType(normalInvestor.address),
      ).to.equal(0);
      expect(
        await investorTypeRegistry.getInvestorType(accreditedInvestor.address),
      ).to.equal(2);
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

    it("Should handle unassigned investors as Normal type", async function () {
      // Unassigned investor should default to Normal type (0)
      expect(
        await investorTypeRegistry.getInvestorType(normalInvestor.address),
      ).to.equal(0);

      // Should have Normal investor limits
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
    });

    it("Should detect large transfers correctly", async function () {
      // Assign investor types
      await investorTypeRegistry
        .connect(complianceOfficer)
        .assignInvestorType(accreditedInvestor.address, 2); // Accredited

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
    });
  });

  describe("Access Control", function () {
    it("Should only allow compliance officers to assign investor types", async function () {
      await expect(
        investorTypeRegistry
          .connect(normalInvestor)
          .assignInvestorType(accreditedInvestor.address, 1),
      ).to.be.revertedWith("Not authorized compliance officer");
    });
  });
});
