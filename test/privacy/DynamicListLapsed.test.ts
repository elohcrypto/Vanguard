import { expect } from "chai";
import { ethers } from "hardhat";

// Removing a LAPSED list entry through the DynamicListManager (review A-N1,
// 2E.8 M-B): the oracle is written whenever it still stores a flag, and real
// oracle errors propagate. Status is the oracles' (plan 3.3). Split
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

  it("a lapsed blacklist entry can be removed and clears the stored flag (A-N1)", async function () {
    const { dlm, user, bl } = await wired();
    await dlm.addToBlacklist(user.address, 5, HIGH, HOUR, "b");
    await advance(HOUR + 1);
    expect(await bl.isBlacklisted(user.address)).to.equal(false);
    expect(await dlm.getUserStatus(user.address)).to.equal(NONE);
    await expect(dlm.removeFromBlacklist(user.address, 5, "lapsed"))
      .to.emit(dlm, "UserStatusChanged")
      .withArgs(user.address, 5, BLACKLISTED, NONE, "lapsed");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(await dlm.isProofValid(user.address, now, false)).to.equal(true);
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
    expect((await bl.blacklistEntries(user.address)).isBlacklisted).to.equal(
      true,
    );
    expect(await dlm.getUserStatusHistoryCount(user.address)).to.equal(1n);
  });

  it("an entry the oracle owner removed directly leaves nothing to remove", async function () {
    const { dlm, user, bl } = await wired();
    await dlm.addToBlacklist(user.address, 5, HIGH, NO_EXPIRY, "b");
    // The oracle owner removes the entry directly: no flag stored, and the
    // manager keeps no status of its own that could disagree (plan 3.3).
    await bl.removeFromBlacklist(user.address, "direct");
    expect(await dlm.getUserStatus(user.address)).to.equal(NONE);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(await dlm.isProofValid(user.address, now, false)).to.equal(true);
    await expect(
      dlm.removeFromBlacklist(user.address, 5, "sync"),
    ).to.be.revertedWith("User not blacklisted");
  });

  it("a lapsed whitelist entry can be removed and clears the stored flag", async function () {
    const { dlm, user, wl } = await wired();
    await dlm.addToWhitelist(user.address, 6, 1, HOUR, "w");
    await advance(HOUR + 1);
    expect(await dlm.getUserStatus(user.address)).to.equal(NONE);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(await dlm.isProofValid(user.address, now, true)).to.equal(false);
    await dlm.removeFromWhitelist(user.address, 6, "lapsed");
    expect((await wl.whitelistEntries(user.address)).isWhitelisted).to.equal(
      false,
    );
    await expect(
      dlm.removeFromWhitelist(user.address, 6, "again"),
    ).to.be.revertedWith("User not whitelisted");
  });
});
