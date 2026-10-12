import { expect } from "chai";
import { ethers } from "hardhat";
import { T, deployCustody } from "../helpers/custody";

// Task 4.17 slice C (D46 a, consistent with R-410-6): in Either with a
// whitelist oracle bound, a party with no live listing passes on its
// proof binding only when its investor type requires tier 1; a Retail
// (tier 2) or higher party needs a listing at its tier. An exempt party
// and a token without a registry keep the proof path.
describe("Either mode: a proof serves tier-1 types only (D46 a)", function () {
  const E = ethers.parseEther;

  async function either() {
    const f = await deployCustody();
    const binder = await (
      await ethers.getContractFactory("MockWhitelistBinder")
    ).deploy();
    await f.rules.setWhitelistOracle(f.token.target, f.wl.target);
    await f.rules.setPrivacyManager(f.token.target, binder.target);
    await f.rules.setWhitelistMode(f.token.target, 2); // Either
    for (const w of [f.user, f.other]) await binder.setBound(w.address, true);
    await f.token.mint(f.user.address, E("100"));
    return { ...f, binder };
  }

  it("a bound, unlisted Normal party passes; Retail and above need a listing", async function () {
    const { token, rules, types, wl, user, other } = await either();
    const ok = () => token.canTransfer(user.address, other.address, E("1"));
    expect(await ok()).to.equal(true);
    expect(
      await rules.whitelistTierAllows(token.target, other.address),
    ).to.equal(true);
    await types.assignInvestorType(other.address, T.Retail);
    expect(await ok()).to.equal(false);
    expect(
      await rules.whitelistTierAllows(token.target, other.address),
    ).to.equal(false);
    await wl.addToWhitelist(other.address, 1, 0, "short");
    expect(await ok()).to.equal(false); // R-410-6: a short entry refuses
    await wl.addToWhitelist(other.address, 2, 0, "at tier");
    expect(await ok()).to.equal(true);
    expect(
      await rules.whitelistTierAllows(token.target, other.address),
    ).to.equal(true);
  });

  it("an exempt party keeps the proof path; OracleOnly is unchanged", async function () {
    const { token, rules, types, user, other } = await either();
    await types.assignInvestorType(other.address, T.Accredited);
    expect(
      await token.canTransfer(user.address, other.address, E("1")),
    ).to.equal(false);
    await types.setInvestorLimitExempt(other.address, true);
    expect(
      await token.canTransfer(user.address, other.address, E("1")),
    ).to.equal(true);
    await rules.setWhitelistMode(token.target, 0);
    expect(
      await rules.whitelistTierAllows(token.target, other.address),
    ).to.equal(true);
  });
});
