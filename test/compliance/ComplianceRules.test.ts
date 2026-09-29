import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ComplianceRules } from "../../typechain-types";
import { attest, configureKyc } from "../helpers/kyc";

describe("ComplianceRules", function () {
  // Chain time, not wall-clock time: the two drift apart once any earlier
  // test advances the clock, and a holding period compared across them flakes.
  const chainNow = async () =>
    (await ethers.provider.getBlock("latest"))!.timestamp;
  let complianceRules: ComplianceRules;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let user: SignerWithAddress;
  let tokenContract: SignerWithAddress;
  let investor1: SignerWithAddress;
  let investor2: SignerWithAddress;

  // Test constants
  const COUNTRY_US = 840;
  const COUNTRY_UK = 826;
  const COUNTRY_SANCTIONED = 643; // Russia (example sanctioned country)

  const INVESTOR_TYPE_RETAIL = 1;
  const INVESTOR_TYPE_ACCREDITED = 2;
  const INVESTOR_TYPE_INSTITUTIONAL = 3;

  const COMPLIANCE_LEVEL_BASIC = 1;
  const COMPLIANCE_LEVEL_STANDARD = 3;
  const COMPLIANCE_LEVEL_PREMIUM = 5;

  beforeEach(async function () {
    [owner, admin, user, tokenContract, investor1, investor2] =
      await ethers.getSigners();

    const ComplianceRulesFactory =
      await ethers.getContractFactory("ComplianceRules");
    complianceRules = await ComplianceRulesFactory.deploy(
      owner.address,
      [840, 826, 756], // Allowed countries: USA, UK, Switzerland
      [], // No blocked countries
    );
    await complianceRules.waitForDeployment();

    // Set up admin and authorize token contract
    await complianceRules.setRuleAdministrator(admin.address, true);
    await complianceRules.authorizeToken(tokenContract.address, true);
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await complianceRules.owner()).to.equal(owner.address);
    });

    it("Should set deployer as rule administrator", async function () {
      expect(await complianceRules.ruleAdministrators(owner.address)).to.be
        .true;
    });

    it("Should initialize default rules", async function () {
      const defaultJurisdiction = await complianceRules.getJurisdictionRule(
        ethers.ZeroAddress,
      );
      expect(defaultJurisdiction.isActive).to.be.true;

      const defaultInvestorType = await complianceRules.getInvestorTypeRule(
        ethers.ZeroAddress,
      );
      expect(defaultInvestorType.isActive).to.be.true;
      expect(defaultInvestorType.minimumAccreditation).to.equal(1);

      const defaultHoldingPeriod = await complianceRules.getHoldingPeriodRule(
        ethers.ZeroAddress,
      );
      expect(defaultHoldingPeriod.isActive).to.be.true;
      expect(defaultHoldingPeriod.minimumHoldingPeriod).to.equal(24 * 60 * 60); // 24 hours
      expect(defaultHoldingPeriod.transferCooldown).to.equal(60 * 60); // 1 hour

      const defaultComplianceLevel =
        await complianceRules.getComplianceLevelRule(ethers.ZeroAddress);
      expect(defaultComplianceLevel.isActive).to.be.true;
      expect(defaultComplianceLevel.minimumLevel).to.equal(1);
      expect(defaultComplianceLevel.maximumLevel).to.equal(5);
    });
  });

  describe("Access Control", function () {
    it("Should allow owner to set rule administrators", async function () {
      await expect(complianceRules.setRuleAdministrator(user.address, true))
        .to.emit(complianceRules, "RuleAdministratorUpdated")
        .withArgs(user.address, true);

      expect(await complianceRules.ruleAdministrators(user.address)).to.be.true;
    });

    it("Should allow owner to authorize tokens", async function () {
      await expect(complianceRules.authorizeToken(user.address, true))
        .to.emit(complianceRules, "TokenAuthorized")
        .withArgs(user.address, true);

      expect(await complianceRules.authorizedTokens(user.address)).to.be.true;
    });

    it("Should reject rule setting by unauthorized users", async function () {
      await expect(
        complianceRules
          .connect(user)
          .setJurisdictionRule(tokenContract.address, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
    });

    it("Should reject token authorization by non-owner", async function () {
      await expect(
        complianceRules.connect(user).authorizeToken(user.address, true),
      ).to.be.revertedWithCustomError(
        complianceRules,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Jurisdiction Rules", function () {
    it("Should set jurisdiction rules correctly", async function () {
      const allowedCountries = [COUNTRY_US, COUNTRY_UK];
      const blockedCountries = [COUNTRY_SANCTIONED];

      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(
            tokenContract.address,
            allowedCountries,
            blockedCountries,
          ),
      )
        .to.emit(complianceRules, "JurisdictionRuleUpdated")
        .withArgs(tokenContract.address, allowedCountries, blockedCountries);

      const rule = await complianceRules.getJurisdictionRule(
        tokenContract.address,
      );
      expect(rule.isActive).to.be.true;
      expect(rule.allowedCountries).to.deep.equal(allowedCountries);
      expect(rule.blockedCountries).to.deep.equal(blockedCountries);
    });

    it("Should validate allowed jurisdictions", async function () {
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(
          tokenContract.address,
          [COUNTRY_US, COUNTRY_UK],
          [],
        );

      const [isValid, reason] = await complianceRules.validateJurisdiction(
        tokenContract.address,
        COUNTRY_US,
      );
      expect(isValid).to.be.true;
      expect(reason).to.equal("Jurisdiction validation passed");
    });

    it("Should reject blocked jurisdictions", async function () {
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [], [COUNTRY_SANCTIONED]);

      const [isValid, reason] = await complianceRules.validateJurisdiction(
        tokenContract.address,
        COUNTRY_SANCTIONED,
      );
      expect(isValid).to.be.false;
      expect(reason).to.equal("Country is blocked");
    });

    it("Should reject countries not in allowed list", async function () {
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [COUNTRY_US], []);

      const [isValid, reason] = await complianceRules.validateJurisdiction(
        tokenContract.address,
        COUNTRY_UK,
      );
      expect(isValid).to.be.false;
      expect(reason).to.equal("Country not in allowed list");
    });

    it("Should reject setting too many countries", async function () {
      const tooManyCountries = Array.from({ length: 301 }, (_, i) => i);

      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(tokenContract.address, tooManyCountries, []),
      ).to.be.revertedWith("ComplianceRules: Too many allowed countries");
    });
  });

  describe("Investor Type Rules", function () {
    it("Should set investor type rules correctly", async function () {
      const allowedTypes = [
        INVESTOR_TYPE_ACCREDITED,
        INVESTOR_TYPE_INSTITUTIONAL,
      ];
      const blockedTypes = [INVESTOR_TYPE_RETAIL];
      const minimumAccreditation = 2;

      await expect(
        complianceRules
          .connect(admin)
          .setInvestorTypeRule(
            tokenContract.address,
            allowedTypes,
            blockedTypes,
            minimumAccreditation,
          ),
      )
        .to.emit(complianceRules, "InvestorTypeRuleUpdated")
        .withArgs(tokenContract.address, allowedTypes, blockedTypes);

      const rule = await complianceRules.getInvestorTypeRule(
        tokenContract.address,
      );
      expect(rule.isActive).to.be.true;
      expect(rule.allowedTypes).to.deep.equal(allowedTypes);
      expect(rule.blockedTypes).to.deep.equal(blockedTypes);
      expect(rule.minimumAccreditation).to.equal(minimumAccreditation);
    });

    it("Should validate allowed investor types", async function () {
      await complianceRules
        .connect(admin)
        .setInvestorTypeRule(
          tokenContract.address,
          [INVESTOR_TYPE_ACCREDITED],
          [],
          2,
        );

      const [isValid, reason] = await complianceRules.validateInvestorType(
        tokenContract.address,
        INVESTOR_TYPE_ACCREDITED,
        3,
      );
      expect(isValid).to.be.true;
      expect(reason).to.equal("Investor type validation passed");
    });

    it("Should reject blocked investor types", async function () {
      await complianceRules
        .connect(admin)
        .setInvestorTypeRule(
          tokenContract.address,
          [],
          [INVESTOR_TYPE_RETAIL],
          1,
        );

      const [isValid, reason] = await complianceRules.validateInvestorType(
        tokenContract.address,
        INVESTOR_TYPE_RETAIL,
        2,
      );
      expect(isValid).to.be.false;
      expect(reason).to.equal("Investor type is blocked");
    });

    it("Should reject insufficient accreditation", async function () {
      await complianceRules
        .connect(admin)
        .setInvestorTypeRule(
          tokenContract.address,
          [INVESTOR_TYPE_ACCREDITED],
          [],
          3,
        );

      const [isValid, reason] = await complianceRules.validateInvestorType(
        tokenContract.address,
        INVESTOR_TYPE_ACCREDITED,
        2,
      );
      expect(isValid).to.be.false;
      expect(reason).to.equal("Insufficient accreditation level");
    });
  });

  describe("Holding Period Rules", function () {
    it("Should set holding period rules correctly", async function () {
      const minimumHoldingPeriod = 7 * 24 * 60 * 60; // 7 days
      const transferCooldown = 2 * 60 * 60; // 2 hours

      await expect(
        complianceRules
          .connect(admin)
          .setHoldingPeriodRule(
            tokenContract.address,
            minimumHoldingPeriod,
            transferCooldown,
          ),
      )
        .to.emit(complianceRules, "HoldingPeriodRuleUpdated")
        .withArgs(
          tokenContract.address,
          minimumHoldingPeriod,
          transferCooldown,
        );

      const rule = await complianceRules.getHoldingPeriodRule(
        tokenContract.address,
      );
      expect(rule.isActive).to.be.true;
      expect(rule.minimumHoldingPeriod).to.equal(minimumHoldingPeriod);
      expect(rule.transferCooldown).to.equal(transferCooldown);
    });

    it("Should validate holding period compliance", async function () {
      const holdingPeriod = 24 * 60 * 60; // 24 hours
      await complianceRules
        .connect(admin)
        .setHoldingPeriodRule(tokenContract.address, holdingPeriod, 0);

      const acquisitionTime = (await chainNow()) - holdingPeriod - 1; // Just over 24 hours ago

      const [isValid, reason] = await complianceRules.validateHoldingPeriod(
        tokenContract.address,
        investor1.address,
        acquisitionTime,
      );
      expect(isValid).to.be.true;
      expect(reason).to.equal("Holding period validation passed");
    });

    it("Should reject transfers before minimum holding period", async function () {
      const holdingPeriod = 24 * 60 * 60; // 24 hours
      await complianceRules
        .connect(admin)
        .setHoldingPeriodRule(tokenContract.address, holdingPeriod, 0);

      // Get current block timestamp and use it as acquisition time
      const currentBlock = await ethers.provider.getBlock("latest");
      const acquisitionTime = currentBlock!.timestamp - 1; // 1 second ago from current block

      const [isValid, reason] = await complianceRules.validateHoldingPeriod(
        tokenContract.address,
        investor1.address,
        acquisitionTime,
      );
      expect(isValid).to.be.false;
      expect(reason).to.equal("Minimum holding period not met");
    });

    it("Should record transfers correctly", async function () {
      await complianceRules
        .connect(tokenContract)
        .recordTransfer(
          tokenContract.address,
          investor1.address,
          investor2.address,
          await chainNow(),
        );
      // No revert means success
    });

    it("Should reject transfer recording from unauthorized token", async function () {
      // Use an unauthorized token address (user.address is not authorized)
      await expect(
        complianceRules.connect(user).recordTransfer(
          user.address, // This token is not authorized
          investor1.address,
          investor2.address,
          await chainNow(),
        ),
      ).to.be.revertedWith("ComplianceRules: Token not authorized");
    });

    it("Should reject excessive holding periods", async function () {
      const excessiveHoldingPeriod = 366 * 24 * 60 * 60; // Over 365 days

      await expect(
        complianceRules
          .connect(admin)
          .setHoldingPeriodRule(
            tokenContract.address,
            excessiveHoldingPeriod,
            0,
          ),
      ).to.be.revertedWith("ComplianceRules: Holding period too long");
    });
  });

  describe("Compliance Level Rules", function () {
    it("Should set compliance level rules correctly", async function () {
      const minimumLevel = 2;
      const maximumLevel = 8;
      const levels = [1, 2, 3];
      const inheritanceLevels = [2, 3, 4];

      await expect(
        complianceRules
          .connect(admin)
          .setComplianceLevelRule(
            tokenContract.address,
            minimumLevel,
            maximumLevel,
            levels,
            inheritanceLevels,
          ),
      )
        .to.emit(complianceRules, "ComplianceLevelRuleUpdated")
        .withArgs(tokenContract.address, minimumLevel, maximumLevel);

      const rule = await complianceRules.getComplianceLevelRule(
        tokenContract.address,
      );
      expect(rule.isActive).to.be.true;
      expect(rule.minimumLevel).to.equal(minimumLevel);
      expect(rule.maximumLevel).to.equal(maximumLevel);
    });

    it("Should aggregate compliance levels correctly", async function () {
      await complianceRules
        .connect(admin)
        .setComplianceLevelRule(tokenContract.address, 1, 5, [], []);

      const inputLevels = [3, 4, 2];
      const [aggregatedLevel, isValid] =
        await complianceRules.aggregateComplianceLevels(
          tokenContract.address,
          inputLevels,
        );

      expect(aggregatedLevel).to.equal(2); // Minimum of input levels
      expect(isValid).to.be.true;
    });

    it("Should reject invalid level ranges", async function () {
      await expect(
        complianceRules.connect(admin).setComplianceLevelRule(
          tokenContract.address,
          5,
          3, // max < min
          [],
          [],
        ),
      ).to.be.revertedWith("ComplianceRules: Invalid level range");
    });

    it("Should reject levels that are too high", async function () {
      await expect(
        complianceRules.connect(admin).setComplianceLevelRule(
          tokenContract.address,
          1,
          11, // > MAX_COMPLIANCE_LEVELS (10)
          [],
          [],
        ),
      ).to.be.revertedWith("ComplianceRules: Level too high");
    });

    it("Should reject mismatched array lengths", async function () {
      await expect(
        complianceRules.connect(admin).setComplianceLevelRule(
          tokenContract.address,
          1,
          5,
          [1, 2], // length 2
          [2], // length 1
        ),
      ).to.be.revertedWith("ComplianceRules: Array length mismatch");
    });
  });

  describe("Default Rules Fallback", function () {
    it("Should use default rules when token-specific rules are not set", async function () {
      const unknownToken = user.address;

      // Should use default jurisdiction rule
      const [isValidJurisdiction] = await complianceRules.validateJurisdiction(
        unknownToken,
        COUNTRY_US,
      );
      expect(isValidJurisdiction).to.be.true;

      // Should use default investor type rule
      const [isValidInvestorType] = await complianceRules.validateInvestorType(
        unknownToken,
        INVESTOR_TYPE_RETAIL,
        1,
      );
      expect(isValidInvestorType).to.be.true;

      // Should use default holding period rule
      const oldAcquisitionTime = (await chainNow()) - 25 * 60 * 60; // 25 hours ago
      const [isValidHolding] = await complianceRules.validateHoldingPeriod(
        unknownToken,
        investor1.address,
        oldAcquisitionTime,
      );
      expect(isValidHolding).to.be.true;
    });
  });

  describe("Edge Cases and Error Handling", function () {
    it("Should reject zero address for token", async function () {
      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(ethers.ZeroAddress, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Invalid token address");
    });

    it("Should reject zero address for administrator", async function () {
      await expect(
        complianceRules.setRuleAdministrator(ethers.ZeroAddress, true),
      ).to.be.revertedWith("ComplianceRules: Invalid administrator address");
    });

    it("Should handle empty input arrays", async function () {
      // Empty arrays should be allowed
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [], []);

      const rule = await complianceRules.getJurisdictionRule(
        tokenContract.address,
      );
      expect(rule.allowedCountries.length).to.equal(0);
      expect(rule.blockedCountries.length).to.equal(0);
    });

    it("Should handle compliance level aggregation with empty inputs", async function () {
      const [aggregatedLevel, isValid] =
        await complianceRules.aggregateComplianceLevels(
          tokenContract.address,
          [],
        );
      expect(aggregatedLevel).to.equal(0);
      expect(isValid).to.be.false;
    });
  });

  describe("Gas Optimization", function () {
    it("Should efficiently validate multiple jurisdictions", async function () {
      // Set up rules with multiple countries
      const manyCountries = Array.from({ length: 50 }, (_, i) => i + 1);
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, manyCountries, []);

      // Validation should still be efficient
      const [isValid] = await complianceRules.validateJurisdiction(
        tokenContract.address,
        25,
      );
      expect(isValid).to.be.true;
    });

    it("Should efficiently aggregate many compliance levels", async function () {
      const manyLevels = Array.from({ length: 20 }, () => 3);

      await complianceRules
        .connect(admin)
        .setComplianceLevelRule(tokenContract.address, 1, 5, [], []);

      const [aggregatedLevel, isValid] =
        await complianceRules.aggregateComplianceLevels(
          tokenContract.address,
          manyLevels,
        );
      expect(aggregatedLevel).to.equal(3);
      expect(isValid).to.be.true;
    });
  });

  // Task 2A.5: the default blocked list always applies, trusted and mint paths
  // check country, and a per-token rule can be cleared.
  describe("Country checks on every path", function () {
    let rules: any, idReg: any;
    let escrow: string, // a deployed stub: only contracts may be trusted
      usHolder: SignerWithAddress,
      usHolder2: SignerWithAddress,
      ruHolder: SignerWithAddress;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      [usHolder, usHolder2, ruHolder] = signers.slice(7, 10);

      rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(owner.address, [COUNTRY_US, COUNTRY_UK], [COUNTRY_SANCTIONED]);
      await rules.setRuleAdministrator(admin.address, true);
      await rules.authorizeToken(tokenContract.address, true);

      idReg = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      await idReg.addAgent(owner.address);
      const kycIssuer = await (
        await ethers.getContractFactory("ClaimIssuer")
      ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
      await configureKyc(idReg, await kycIssuer.getAddress());
      const OID = await ethers.getContractFactory("OnchainID");
      for (const [who, country] of [
        [usHolder, COUNTRY_US],
        [usHolder2, COUNTRY_US],
        [ruHolder, COUNTRY_SANCTIONED],
      ] as [SignerWithAddress, number][]) {
        const id = await OID.deploy(who.address);
        await idReg.registerIdentity(
          who.address,
          await id.getAddress(),
          country,
        );
        await attest(kycIssuer, owner, await id.getAddress());
      }

      await rules.setTokenIdentityRegistry(
        tokenContract.address,
        await idReg.getAddress(),
      );
      const stub = await (
        await ethers.getContractFactory("MockToken")
      ).deploy("Escrow stub", "ESC", 0);
      escrow = await stub.getAddress();
      await rules.addTrustedContract(escrow);
    });

    // canTransfer reads msg.sender as the token.
    const can = (from: string, to: string) =>
      rules.connect(tokenContract).canTransfer(from, to, 1);

    it("refuses an escrow counterparty from a blocked country on the trusted path", async function () {
      expect(await idReg.isVerified(ruHolder.address)).to.equal(true);
      expect(await can(escrow, ruHolder.address)).to.equal(false);
      expect(await can(ruHolder.address, escrow)).to.equal(false);
      expect(await can(escrow, usHolder.address)).to.equal(true);
    });

    it("refuses a mint to a holder whose country was blocked after registration", async function () {
      expect(await can(ethers.ZeroAddress, usHolder.address)).to.equal(true);
      await rules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [], [COUNTRY_US]);
      expect(await can(ethers.ZeroAddress, usHolder.address)).to.equal(false);
    });

    it("an empty per-token rule still blocks a default-blocked country", async function () {
      await rules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [], []);
      expect(await can(usHolder.address, ruHolder.address)).to.equal(false);
      const [ok] = await rules.validateJurisdiction(
        tokenContract.address,
        COUNTRY_SANCTIONED,
      );
      expect(ok).to.equal(false);
      expect(await can(usHolder.address, usHolder2.address)).to.equal(true);
    });

    it("clearJurisdictionRule restores the default rule", async function () {
      await rules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [], [COUNTRY_US]);
      expect(await can(usHolder.address, usHolder2.address)).to.equal(false);

      await expect(
        rules.connect(admin).clearJurisdictionRule(tokenContract.address),
      )
        .to.emit(rules, "JurisdictionRuleCleared")
        .withArgs(tokenContract.address);
      expect(await can(usHolder.address, usHolder2.address)).to.equal(true);
      expect(await can(usHolder.address, ruHolder.address)).to.equal(false);
      await expect(
        rules.connect(user).clearJurisdictionRule(tokenContract.address),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
    });
  });
});
