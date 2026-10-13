import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCustody } from "../helpers/custody";

// Plan v2 Task 5.1, N10 (Q7 = yes): the list oracles (ListOracleBase) and
// InvestorRequestManager are Ownable2Step. transferOwnership only
// nominates; the nominee accepts; until then the old owner keeps every
// power, and a mistyped nominee can be replaced or cleared.

describe("Task 5.1: two-step ownership of the list oracles and the request manager", function () {
  const cases: [string, (f: any) => any, (c: any, who: any) => Promise<unknown>][] = [
    ["WhitelistOracle", (f) => f.wl, (c, who) => c.connect(who).setListManager(who.address)],
    ["BlacklistOracle", (f) => f.bl, (c, who) => c.connect(who).setMaxVerdictAge(7200)],
    ["InvestorRequestManager", (f) => f.m, (c, who) => c.connect(who).updateLockRequirement(1, 1n)],
  ];

  for (const [name, pick, ownerCall] of cases) {
    describe(name, function () {
      it("transferOwnership nominates; only the nominee accepts", async function () {
        const f = await deployCustody();
        const c = pick(f);
        const [next, stranger] = [f.other, f.stranger];
        await c.transferOwnership(next.address);
        expect(await c.owner()).to.equal(f.owner.address);
        expect(await c.pendingOwner()).to.equal(next.address);
        await ownerCall(c, f.owner); // the old owner keeps its powers
        await expect(c.connect(stranger).acceptOwnership())
          .to.be.revertedWithCustomError(c, "OwnableUnauthorizedAccount")
          .withArgs(stranger.address);
        await c.connect(next).acceptOwnership();
        expect(await c.owner()).to.equal(next.address);
        expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
        await expect(ownerCall(c, f.owner))
          .to.be.revertedWithCustomError(c, "OwnableUnauthorizedAccount")
          .withArgs(f.owner.address);
        await ownerCall(c, next);
      });

      it("a wrong nominee is replaced before it accepts", async function () {
        const f = await deployCustody();
        const c = pick(f);
        await c.transferOwnership(f.stranger.address);
        await c.transferOwnership(f.other.address);
        await expect(c.connect(f.stranger).acceptOwnership()).to.be.revertedWithCustomError(
          c,
          "OwnableUnauthorizedAccount",
        );
        await c.connect(f.other).acceptOwnership();
        expect(await c.owner()).to.equal(f.other.address);
      });
    });
  }
});
