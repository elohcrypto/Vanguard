import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Compliance rule revocation must actually revoke.
 *
 * setJurisdictionRule and setInvestorTypeRule kept a lookup mapping alongside
 * the stored arrays. The "clear existing mappings" loops iterated the NEW
 * calldata arrays instead of the stored ones, then immediately re-set those
 * same keys — so the loops were no-ops and old entries were never removed.
 *
 * Two consequences, both silent:
 *   - removing a country from the allow list did nothing; it kept transferring
 *   - un-blocking a country did nothing; it stayed blocked forever
 */
describe("Compliance rule revocation", function () {
  let owner: SignerWithAddress;
  let rules: any;
  const TOKEN = "0x" + "11".repeat(20);

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [], []);
  });

  describe("jurisdiction", function () {
    it("removing a country from the allow list takes effect", async function () {
      await rules.setJurisdictionRule(TOKEN, [840, 124], []);
      expect((await rules.validateJurisdiction(TOKEN, 124))[0]).to.be.true;

      // Governance votes to drop Canada.
      await rules.setJurisdictionRule(TOKEN, [840], []);

      expect((await rules.validateJurisdiction(TOKEN, 840))[0], "US must stay allowed").to.be.true;
      expect((await rules.validateJurisdiction(TOKEN, 124))[0], "CA must now be refused").to.be.false;
    });

    it("un-blocking a country takes effect", async function () {
      await rules.setJurisdictionRule(TOKEN, [840], [643]);
      expect((await rules.validateJurisdiction(TOKEN, 643))[0]).to.be.false;

      // Sanctions lifted: 643 moves to the allow list, block list emptied.
      await rules.setJurisdictionRule(TOKEN, [840, 643], []);

      expect((await rules.validateJurisdiction(TOKEN, 643))[0], "643 must no longer be blocked").to.be.true;
    });

    it("a country can be blocked, un-blocked, and blocked again", async function () {
      await rules.setJurisdictionRule(TOKEN, [840], [643]);
      expect((await rules.validateJurisdiction(TOKEN, 643))[0]).to.be.false;
      await rules.setJurisdictionRule(TOKEN, [840, 643], []);
      expect((await rules.validateJurisdiction(TOKEN, 643))[0]).to.be.true;
      await rules.setJurisdictionRule(TOKEN, [840], [643]);
      expect((await rules.validateJurisdiction(TOKEN, 643))[0]).to.be.false;
    });

    it("the stored arrays and the lookup agree after a removal", async function () {
      await rules.setJurisdictionRule(TOKEN, [840, 124, 826], []);
      await rules.setJurisdictionRule(TOKEN, [840], []);

      // Every country NOT in the new array must be refused.
      for (const c of [124, 826]) {
        expect((await rules.validateJurisdiction(TOKEN, c))[0], `country ${c} should be refused`).to.be.false;
      }
    });
  });

  describe("investor type", function () {
    it("removing an allowed investor type takes effect", async function () {
      await rules.setInvestorTypeRule(TOKEN, [1, 2], [], 0);
      expect((await rules.validateInvestorType(TOKEN, 2, 0))[0]).to.be.true;

      await rules.setInvestorTypeRule(TOKEN, [1], [], 0);

      expect((await rules.validateInvestorType(TOKEN, 1, 0))[0], "type 1 must stay allowed").to.be.true;
      expect((await rules.validateInvestorType(TOKEN, 2, 0))[0], "type 2 must now be refused").to.be.false;
    });

    it("un-blocking an investor type takes effect", async function () {
      await rules.setInvestorTypeRule(TOKEN, [1], [2], 0);
      expect((await rules.validateInvestorType(TOKEN, 2, 0))[0]).to.be.false;

      await rules.setInvestorTypeRule(TOKEN, [1, 2], [], 0);

      expect((await rules.validateInvestorType(TOKEN, 2, 0))[0], "type 2 must no longer be blocked").to.be.true;
    });
  });
});
