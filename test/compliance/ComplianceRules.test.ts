import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ComplianceRules } from "../../typechain-types";
import { attest, configureKyc } from "../helpers/kyc";

// The surviving surface after plan v2 Task 4.1 step 0: jurisdiction rules,
// rule administrators, the identity-registry map. The investor-type,
// holding-period and compliance-level rules lived here with no effect on
// any transfer; their live home is InvestorTypeRegistry (Task 2A.2).
describe("ComplianceRules", function () {
  let complianceRules: ComplianceRules;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let user: SignerWithAddress;
  let tokenContract: SignerWithAddress;

  // Test constants
  const COUNTRY_US = 840;
  const COUNTRY_UK = 826;
  const COUNTRY_SANCTIONED = 643; // Russia (example sanctioned country)

  beforeEach(async function () {
    [owner, admin, user, tokenContract] = await ethers.getSigners();

    const ComplianceRulesFactory =
      await ethers.getContractFactory("ComplianceRules");
    complianceRules = await ComplianceRulesFactory.deploy(
      owner.address,
      [840, 826, 756], // Allowed countries: USA, UK, Switzerland
      [], // No blocked countries
    );
    await complianceRules.waitForDeployment();

    // Rule administrators are per token (G5): admin may set tokenContract's.
    await complianceRules.setRuleAdministrator(
      tokenContract.address,
      admin.address,
      true,
    );
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await complianceRules.owner()).to.equal(owner.address);
    });

    it("grants no rule administrator at construction (G5)", async function () {
      const fresh = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(owner.address, [], []);
      expect(
        await fresh.ruleAdministrators(tokenContract.address, owner.address),
      ).to.be.false;
      await expect(
        fresh.setJurisdictionRule(tokenContract.address, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
    });

    it("Should initialize the default jurisdiction rule", async function () {
      const rule = await complianceRules.getJurisdictionRule(
        ethers.ZeroAddress,
      );
      expect(rule.isActive).to.be.true;
      expect(rule.allowedCountries).to.deep.equal([840n, 826n, 756n]);
      expect(rule.blockedCountries).to.deep.equal([]);
    });

    it("has no investor-type, holding-period or level rule surface (4.1)", async function () {
      for (const gone of [
        "setInvestorTypeRule",
        "setHoldingPeriodRule",
        "setComplianceLevelRule",
        "validateInvestorType",
        "validateHoldingPeriod",
        "aggregateComplianceLevels",
        "getInvestorTypeRule",
        "getHoldingPeriodRule",
        "getComplianceLevelRule",
        "recordTransfer",
        "authorizeToken",
        "authorizedTokens",
        "getTokenIdentityRegistry",
      ]) {
        const iface = complianceRules.interface as unknown as {
          getFunction(name: string): unknown;
        };
        expect(iface.getFunction(gone), gone).to.be.null;
      }
    });
  });

  describe("Access Control", function () {
    it("Should allow owner to set rule administrators", async function () {
      const t = tokenContract.address;
      await expect(complianceRules.setRuleAdministrator(t, user.address, true))
        .to.emit(complianceRules, "RuleAdministratorUpdated")
        .withArgs(t, user.address, true);

      expect(await complianceRules.ruleAdministrators(t, user.address)).to.be
        .true;
      expect(
        await complianceRules.ruleAdministrators(user.address, user.address),
      ).to.be.false;
    });

    it("an administrator of one token cannot set another token's rule (G5)", async function () {
      const other = user.address; // any address names a token
      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(other, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
      await expect(
        complianceRules.connect(admin).clearJurisdictionRule(other),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, [COUNTRY_US], []);
    });

    it("Should reject rule setting by unauthorized users", async function () {
      await expect(
        complianceRules
          .connect(user)
          .setJurisdictionRule(tokenContract.address, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
    });

    it("Should reject administrator changes by non-owner", async function () {
      await expect(
        complianceRules
          .connect(admin)
          .setRuleAdministrator(tokenContract.address, user.address, true),
      ).to.be.revertedWithCustomError(
        complianceRules,
        "OwnableUnauthorizedAccount",
      );
    });

    it("a revoked administrator can no longer set rules", async function () {
      await complianceRules.setRuleAdministrator(
        tokenContract.address,
        admin.address,
        false,
      );
      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(tokenContract.address, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
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

  describe("Edge Cases and Error Handling", function () {
    it("Should reject zero address for token", async function () {
      // address(0) has no administrator, so the rule setters refuse first.
      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(ethers.ZeroAddress, [COUNTRY_US], []),
      ).to.be.revertedWith("ComplianceRules: Only governance can update rules");
      await expect(
        complianceRules.setRuleAdministrator(
          ethers.ZeroAddress,
          admin.address,
          true,
        ),
      ).to.be.revertedWith("ComplianceRules: Invalid token address");
    });

    it("Should reject zero address for administrator", async function () {
      await expect(
        complianceRules.setRuleAdministrator(
          tokenContract.address,
          ethers.ZeroAddress,
          true,
        ),
      ).to.be.revertedWith("ComplianceRules: Invalid administrator address");
    });

    it("Should reject too many blocked countries", async function () {
      const tooMany = Array.from({ length: 301 }, (_, i) => i);
      await expect(
        complianceRules
          .connect(admin)
          .setJurisdictionRule(tokenContract.address, [], tooMany),
      ).to.be.revertedWith("ComplianceRules: Too many blocked countries");
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

    it("Should use the default rule when a token has none", async function () {
      const [ok] = await complianceRules.validateJurisdiction(
        user.address,
        COUNTRY_US,
      );
      expect(ok).to.be.true;
      const [okOther, reason] = await complianceRules.validateJurisdiction(
        user.address,
        392,
      );
      expect(okOther).to.be.false;
      expect(reason).to.equal("Country not in allowed list");
    });

    it("Should efficiently validate multiple jurisdictions", async function () {
      const manyCountries = Array.from({ length: 50 }, (_, i) => i + 1);
      await complianceRules
        .connect(admin)
        .setJurisdictionRule(tokenContract.address, manyCountries, []);
      const [isValid] = await complianceRules.validateJurisdiction(
        tokenContract.address,
        25,
      );
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
      await rules.setRuleAdministrator(
        tokenContract.address,
        admin.address,
        true,
      );

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
      await rules.addTrustedContract(tokenContract.address, escrow);
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
