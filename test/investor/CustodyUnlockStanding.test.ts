import { expect } from "chai";
import { ethers } from "hardhat";
import { T, deployCustody, lockedRequest } from "../helpers/custody";

// Task 4.17 slice D. D58 (a), review A1 A1F-2: at execution, an unlock
// to a wallet other than the user needs the user verified, not frozen
// and not blacklisted; the user's own unlock is unchanged. A1F-5: the
// custody tier check skips a wallet the live registry exempts, as
// ComplianceRules does.
describe("Custody unlock needs the user in good standing (D58)", function () {
  const E = ethers.parseEther;

  async function locked() {
    const f = await deployCustody();
    await f.token.mint(f.user.address, E("8000"));
    const { wallet, lock } = await lockedRequest(f, T.Retail);
    return { ...f, wallet, lock };
  }
  /** Propose `to`, user signs; the bank's signature executes. */
  async function proposed(f: any, to: string) {
    const rc = await (
      await f.wallet.connect(f.user).proposeUnlock(f.lock, to, "pay out")
    ).wait();
    const id = rc.logs
      .map((l: any) => {
        try {
          return f.wallet.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((x: any) => x?.name === "UnlockProposalCreated").args[0];
    await f.wallet.connect(f.user).signUnlock(id);
    return () => f.wallet.connect(f.bank).signUnlock(id);
  }

  it("refuses a third-party payout of a blacklisted, de-registered or frozen user", async function () {
    for (const [why, err] of [
      ["blacklisted", "UserBlacklisted"],
      ["deleted", "UserNotVerified"],
      ["frozen", "UserFrozen"],
    ]) {
      const f = await locked();
      const exec = await proposed(f, f.other.address);
      if (why === "blacklisted") {
        await f.rules.setBlacklistOracle(f.token.target, f.bl.target);
        await f.bl.addToBlacklist(f.user.address, 3, 0, "sanctioned");
      } else if (why === "deleted") {
        await f.registry.deleteIdentity(f.user.address);
      } else {
        await f.token.setAddressFrozen(f.user.address, true);
      }
      await expect(exec(), why)
        .to.be.revertedWithCustomError(f.wallet, err)
        .withArgs(f.user.address);
      expect(await f.token.balanceOf(f.other.address)).to.equal(0n);
    }
  });

  it("pays a third party for a user in good standing, and the user always", async function () {
    const f = await locked();
    await (
      await proposed(f, f.other.address)
    )();
    expect(await f.token.balanceOf(f.other.address)).to.equal(f.lock);
    const g = await locked();
    await g.token.setAddressFrozen(g.user.address, true);
    await g.token.setAddressFrozen(g.user.address, false);
    await (
      await proposed(g, g.user.address)
    )();
    expect(await g.wallet.lockedAmount()).to.equal(0n);
  });

  it("the tier check skips an exempt user (A1F-5)", async function () {
    const f = await deployCustody();
    await f.wl.addToWhitelist(f.user.address, 1, 0, "t1");
    await f.wl.addToWhitelist(f.other.address, 1, 0, "t1");
    await f.wl.addToWhitelist(f.rules.target, 1, 0, "probe");
    await f.rules.setWhitelistOracle(f.token.target, f.wl.target);
    await f.token.mint(f.user.address, E("8000"));
    await lockedRequest(f, T.Retail); // Retail needs tier 2
    await expect(
      f.m.connect(f.bank).approveRequest(f.user.address),
    ).to.be.revertedWithCustomError(f.m, "TierBelowNewType");
    await f.types.setInvestorLimitExempt(f.user.address, true);
    expect(
      await f.rules.whitelistTierAllows(f.token.target, f.user.address),
    ).to.equal(true);
    await f.m.connect(f.bank).approveRequest(f.user.address);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Retail);
  });
});
