import { expect } from "chai";
import { ethers } from "hardhat";

// Removing a LAPSED list entry through the DynamicListManager (review A-N1,
// 2E.8 M-B): the manager's identity status is cleared, the oracle is written
// whenever it still stores a flag, and real oracle errors propagate. Split
// from DynamicListManager.test.ts to keep both under 500 lines.
describe("DynamicListManager removes lapsed entries", function () {
  const NONE = 0n,
    WHITELISTED = 1n,
    BLACKLISTED = 2n;
  const HIGH = 2; // BlacklistOracle.SeverityLevel.HIGH
  const HOUR = 3600;
  const NO_EXPIRY = ethers.MaxUint256;
  const advance = async (s: number) => {
    await ethers.provider.send("evm_increaseTime", [s]);
    await ethers.provider.send("evm_mine", []);
  };

  async function wired() {
    const [owner, gov, user, , other] = await ethers.getSigners();
    const deploy = async (name: string, ...a: any[]): Promise<any> =>
      (await ethers.getContractFactory(name)).deploy(...a);
    const om = await deploy("OracleManager");
    const wl = await deploy(
      "WhitelistOracle",
      await om.getAddress(),
      "WL",
      "d",
    );
    const bl = await deploy(
      "BlacklistOracle",
      await om.getAddress(),
      "BL",
      "d",
    );
    const dlm = await deploy("DynamicListManager", owner.address);
    const dlmAddr = await dlm.getAddress();
    await dlm.setOracles(await wl.getAddress(), await bl.getAddress());
    await wl.setListManager(dlmAddr);
    await bl.setListManager(dlmAddr);
    await dlm.setGovernanceContract(gov.address);
    return { owner, gov, user, other, wl, bl, dlm };
  }

  it("a lapsed blacklist entry can be removed and clears the identity (A-N1)", async function () {
    const { dlm, user, bl } = await wired();
    await dlm.addToBlacklist(user.address, 5, HIGH, HOUR, "b");
    await advance(HOUR + 1);
    expect(await bl.isBlacklisted(user.address)).to.equal(false);
    expect(await dlm.getIdentityStatus(5)).to.equal(BLACKLISTED);
    await expect(dlm.removeFromBlacklist(user.address, 5, "lapsed"))
      .to.emit(dlm, "UserStatusChanged")
      .withArgs(user.address, 5, BLACKLISTED, NONE, "lapsed");
    expect(await dlm.getIdentityStatus(5)).to.equal(NONE);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(await dlm.isProofValid(5, now, false)).to.equal(true);
    // The oracle's stale flag is cleared too.
    expect((await bl.blacklistEntries(user.address)).isBlacklisted).to.equal(
      false,
    );
    // Nothing left to remove: the second call is refused.
    await expect(
      dlm.removeFromBlacklist(user.address, 5, "again"),
    ).to.be.revertedWith("User not blacklisted");
  });

  it("a lapsed entry with the writer role cleared: removal reverts, nothing changes", async function () {
    const { dlm, user, other, wl, bl } = await wired();
    await dlm.addToBlacklist(user.address, 5, HIGH, HOUR, "b");
    await dlm.addToWhitelist(other.address, 6, 1, HOUR, "w");
    await advance(HOUR + 1);
    await bl.setListManager(ethers.ZeroAddress);
    await wl.setListManager(ethers.ZeroAddress);
    await expect(
      dlm.removeFromBlacklist(user.address, 5, "lapsed"),
    ).to.be.revertedWith("BlacklistOracle: Only owner or list manager");
    await expect(
      dlm.removeFromWhitelist(other.address, 6, "lapsed"),
    ).to.be.revertedWith("WhitelistOracle: Only owner or list manager");
    expect(await dlm.getIdentityStatus(5)).to.equal(BLACKLISTED);
    expect(await dlm.getIdentityStatus(6)).to.equal(WHITELISTED);
    expect((await bl.blacklistEntries(user.address)).isBlacklisted).to.equal(
      true,
    );
  });

  it("a status with no stored oracle flag is cleared without calling the oracle", async function () {
    const { dlm, user, bl } = await wired();
    await dlm.addToBlacklist(user.address, 5, HIGH, NO_EXPIRY, "b");
    // The oracle owner removes the entry directly: no flag stored, the
    // manager's identity status is still BLACKLISTED.
    await bl.removeFromBlacklist(user.address, "direct");
    expect(await dlm.getIdentityStatus(5)).to.equal(BLACKLISTED);
    // Without the writer role any oracle call would revert.
    await bl.setListManager(ethers.ZeroAddress);
    await expect(dlm.removeFromBlacklist(user.address, 5, "sync"))
      .to.emit(dlm, "UserStatusChanged")
      .withArgs(user.address, 5, BLACKLISTED, NONE, "sync")
      .and.not.to.emit(bl, "BlacklistUpdated");
    expect(await dlm.getIdentityStatus(5)).to.equal(NONE);
  });

  it("a lapsed whitelist entry can be removed and clears the identity", async function () {
    const { dlm, user, wl } = await wired();
    await dlm.addToWhitelist(user.address, 6, 1, HOUR, "w");
    await advance(HOUR + 1);
    expect(await dlm.getIdentityStatus(6)).to.equal(WHITELISTED);
    await dlm.removeFromWhitelist(user.address, 6, "lapsed");
    expect(await dlm.getIdentityStatus(6)).to.equal(NONE);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(await dlm.isProofValid(6, now, true)).to.equal(false);
    expect((await wl.whitelistEntries(user.address)).isWhitelisted).to.equal(
      false,
    );
    await expect(
      dlm.removeFromWhitelist(user.address, 6, "again"),
    ).to.be.revertedWith("User not whitelisted");
  });
});
