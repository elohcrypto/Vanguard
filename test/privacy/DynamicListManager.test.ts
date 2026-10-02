import { expect } from "chai";
import { ethers } from "hardhat";

// Plan 2D.1: DynamicListManager is the single list-update entry. It writes the
// WhitelistOracle/BlacklistOracle (the lists ComplianceRules reads) through a
// writer role the oracle owner grants, and derives per-address status from
// them instead of keeping its own copy (D6').
describe("DynamicListManager writes the oracles", function () {
  const NONE = 0n,
    WHITELISTED = 1n,
    BLACKLISTED = 2n;
  const HIGH = 2; // BlacklistOracle.SeverityLevel.HIGH
  // D20 = (b): every manager write names its duration (seconds or NO_EXPIRY).
  const YEAR = 365n * 86400n;
  const NO_EXPIRY = ethers.MaxUint256;

  async function fixture() {
    const [owner, gov, user, stranger, other] = await ethers.getSigners();
    const om = await (
      await ethers.getContractFactory("OracleManager")
    ).deploy();
    const omAddr = await om.getAddress();
    const wl = await (
      await ethers.getContractFactory("WhitelistOracle")
    ).deploy(omAddr, "WL", "d");
    const bl = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(omAddr, "BL", "d");
    const dlm = await (
      await ethers.getContractFactory("DynamicListManager")
    ).deploy(owner.address);
    const dlmAddr = await dlm.getAddress();
    return { owner, gov, user, stranger, other, wl, bl, dlm, dlmAddr };
  }

  async function wired() {
    const f = await fixture();
    await f.dlm.setOracles(await f.wl.getAddress(), await f.bl.getAddress());
    await f.wl.setListManager(f.dlmAddr);
    await f.bl.setListManager(f.dlmAddr);
    await f.dlm.setGovernanceContract(f.gov.address);
    return f;
  }

  describe("oracle writer role", function () {
    it("only the oracle owner sets the list manager", async function () {
      const { stranger, wl, bl, dlmAddr } = await fixture();
      await expect(wl.setListManager(dlmAddr))
        .to.emit(wl, "ListManagerUpdated")
        .withArgs(ethers.ZeroAddress, dlmAddr);
      expect(await wl.listManager()).to.equal(dlmAddr);
      await expect(bl.setListManager(dlmAddr))
        .to.emit(bl, "ListManagerUpdated")
        .withArgs(ethers.ZeroAddress, dlmAddr);
      await expect(
        wl.connect(stranger).setListManager(stranger.address),
      ).to.be.revertedWithCustomError(wl, "OwnableUnauthorizedAccount");
      await expect(
        bl.connect(stranger).setListManager(stranger.address),
      ).to.be.revertedWithCustomError(bl, "OwnableUnauthorizedAccount");
    });

    it("a stranger cannot write the oracles; the list manager can until cleared", async function () {
      const { stranger, user, wl, bl } = await fixture();
      await expect(
        wl.connect(stranger).addToWhitelist(user.address, 1, 0, "r"),
      ).to.be.revertedWith("WhitelistOracle: Only owner or list manager");
      await expect(
        bl.connect(stranger).addToBlacklist(user.address, HIGH, 0, "r"),
      ).to.be.revertedWith("BlacklistOracle: Only owner or list manager");

      // Grant the role to `stranger` standing in for the manager.
      await wl.setListManager(stranger.address);
      await bl.setListManager(stranger.address);
      await wl.connect(stranger).addToWhitelist(user.address, 1, 0, "r");
      await bl.connect(stranger).addToBlacklist(user.address, HIGH, 0, "r");
      expect(await wl.isWhitelisted(user.address)).to.equal(true);
      expect(await bl.isBlacklisted(user.address)).to.equal(true);
      await wl.connect(stranger).removeFromWhitelist(user.address, "r");
      await bl.connect(stranger).removeFromBlacklist(user.address, "r");

      // Clearing (zero) revokes it.
      await wl.setListManager(ethers.ZeroAddress);
      await bl.setListManager(ethers.ZeroAddress);
      await expect(
        wl.connect(stranger).addToWhitelist(user.address, 1, 0, "r"),
      ).to.be.revertedWith("WhitelistOracle: Only owner or list manager");
      await expect(
        bl.connect(stranger).addToBlacklist(user.address, HIGH, 0, "r"),
      ).to.be.revertedWith("BlacklistOracle: Only owner or list manager");
    });

    it("the batch path stays owner-only", async function () {
      const { stranger, user, wl, bl } = await fixture();
      await wl.setListManager(stranger.address);
      await bl.setListManager(stranger.address);
      await expect(
        wl.connect(stranger).batchAddToWhitelist([user.address], [1], 0, "r"),
      ).to.be.revertedWithCustomError(wl, "OwnableUnauthorizedAccount");
    });
  });

  describe("manager configuration", function () {
    it("every list write reverts while the oracles are unset", async function () {
      const { dlm, user } = await fixture();
      await expect(
        dlm.addToWhitelist(user.address, 1, 1, YEAR, "r"),
      ).to.be.revertedWith("DynamicListManager: oracles not set");
      await expect(
        dlm.addToBlacklist(user.address, 1, HIGH, NO_EXPIRY, "r"),
      ).to.be.revertedWith("DynamicListManager: oracles not set");
      await expect(
        dlm.removeFromWhitelist(user.address, 1, "r"),
      ).to.be.revertedWith("DynamicListManager: oracles not set");
      await expect(
        dlm.removeFromBlacklist(user.address, 1, "r"),
      ).to.be.revertedWith("DynamicListManager: oracles not set");
      expect(await dlm.getUserStatus(user.address)).to.equal(NONE);
    });

    it("setOracles is owner-only and requires contracts", async function () {
      const { dlm, wl, bl, stranger } = await fixture();
      const w = await wl.getAddress(),
        b = await bl.getAddress();
      await expect(
        dlm.connect(stranger).setOracles(w, b),
      ).to.be.revertedWithCustomError(dlm, "OwnableUnauthorizedAccount");
      await expect(dlm.setOracles(stranger.address, b)).to.be.revertedWith(
        "DynamicListManager: whitelist oracle not a contract",
      );
      await expect(dlm.setOracles(w, stranger.address)).to.be.revertedWith(
        "DynamicListManager: blacklist oracle not a contract",
      );
      await expect(dlm.setOracles(w, b))
        .to.emit(dlm, "OraclesUpdated")
        .withArgs(w, b);
    });

    it("a write reverts when the oracle has not granted the writer role", async function () {
      const { dlm, wl, bl, user } = await fixture();
      await dlm.setOracles(await wl.getAddress(), await bl.getAddress());
      await expect(
        dlm.addToWhitelist(user.address, 1, 1, YEAR, "r"),
      ).to.be.revertedWith("WhitelistOracle: Only owner or list manager");
    });

    it("rejects an out-of-range severity", async function () {
      const { dlm, user } = await wired();
      await expect(
        dlm.addToBlacklist(user.address, 1, 4, NO_EXPIRY, "r"),
      ).to.be.revertedWith("Invalid severity");
    });
  });

  describe("status derived from the oracles", function () {
    it("governance whitelists, blacklists and restores through the oracles", async function () {
      const { dlm, gov, user, wl, bl } = await wired();
      await expect(
        dlm.connect(gov).addToWhitelist(user.address, 7, 3, YEAR, "kyc"),
      )
        .to.emit(dlm, "UserStatusChanged")
        .withArgs(user.address, 7, NONE, WHITELISTED, "kyc");
      expect(await wl.isWhitelisted(user.address)).to.equal(true);
      expect((await wl.getWhitelistInfo(user.address)).tier).to.equal(3n);
      expect(await dlm.getUserStatus(user.address)).to.equal(WHITELISTED);

      await dlm
        .connect(gov)
        .addToBlacklist(user.address, 7, HIGH, NO_EXPIRY, "sanctions");
      expect(await bl.isBlacklisted(user.address)).to.equal(true);
      expect((await bl.blacklistEntries(user.address)).severity).to.equal(
        BigInt(HIGH),
      );
      expect(await dlm.getUserStatus(user.address)).to.equal(BLACKLISTED);
      await expect(
        dlm.connect(gov).addToWhitelist(user.address, 7, 1, YEAR, "again"),
      ).to.be.revertedWith("User is blacklisted");

      // Unblacklisting returns to WHITELISTED because the whitelist entry stayed.
      await dlm.connect(gov).removeFromBlacklist(user.address, 7, "cleared");
      expect(await bl.isBlacklisted(user.address)).to.equal(false);
      expect(await dlm.getUserStatus(user.address)).to.equal(WHITELISTED);

      await dlm.connect(gov).removeFromWhitelist(user.address, 7, "exit");
      expect(await wl.isWhitelisted(user.address)).to.equal(false);
      expect(await dlm.getUserStatus(user.address)).to.equal(NONE);
      await expect(
        dlm.connect(gov).removeFromWhitelist(user.address, 7, "exit"),
      ).to.be.revertedWith("User not whitelisted");
      await expect(
        dlm.connect(gov).removeFromBlacklist(user.address, 7, "x"),
      ).to.be.revertedWith("User not blacklisted");
    });

    it("a blacklist set directly by the oracle owner shows as BLACKLISTED", async function () {
      const { dlm, other, bl } = await wired();
      expect(await dlm.getUserStatus(other.address)).to.equal(NONE);
      await bl.addToBlacklist(other.address, HIGH, 0, "direct");
      expect(await dlm.getUserStatus(other.address)).to.equal(BLACKLISTED);
    });

    it("strangers cannot call the manager", async function () {
      const { dlm, stranger, user } = await wired();
      await expect(
        dlm.connect(stranger).addToWhitelist(user.address, 1, 1, YEAR, "r"),
      ).to.be.revertedWith("Only owner or governance");
    });
  });

  describe("status history; status and proof validity from the oracles", function () {
    it("records both histories; status is the oracles'", async function () {
      const { dlm, user } = await wired();
      await dlm.addToWhitelist(user.address, 42, 1, YEAR, "a");
      await dlm.addToBlacklist(user.address, 42, HIGH, NO_EXPIRY, "b");
      expect(await dlm.getUserStatus(user.address)).to.equal(BLACKLISTED);
      expect(await dlm.getUserStatusHistoryCount(user.address)).to.equal(2n);
      expect(await dlm.getIdentityStatusHistoryCount(42)).to.equal(2n);
      const h = await dlm.userStatusHistory(user.address, 1);
      expect(h.oldStatus).to.equal(WHITELISTED);
      expect(h.newStatus).to.equal(BLACKLISTED);
      expect(h.reason).to.equal("b");
    });

    it("isProofValid reads the oracles (whitelisted and not blacklisted) and expiry", async function () {
      const { dlm, user, other, bl, wl } = await wired();
      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      expect(await dlm.isProofValid(user.address, now, true)).to.equal(false);
      expect(await dlm.isProofValid(user.address, now, false)).to.equal(true);
      await dlm.addToWhitelist(user.address, 9, 1, YEAR, "a");
      expect(await dlm.isProofValid(user.address, now, true)).to.equal(true);
      await dlm.addToBlacklist(user.address, 9, HIGH, NO_EXPIRY, "b");
      expect(await dlm.isProofValid(user.address, now, true)).to.equal(false);
      expect(await dlm.isProofValid(user.address, now, false)).to.equal(false);
      await dlm.removeFromBlacklist(user.address, 9, "c");
      expect(await dlm.isProofValid(user.address, now, true)).to.equal(true);
      const expired = now - (await dlm.proofExpiryDuration()) - 10n;
      expect(await dlm.isProofValid(user.address, expired, true)).to.equal(
        false,
      );
      // Written straight to the oracles, never through the manager (N-2).
      await wl.addToWhitelist(other.address, 1, 0, "direct");
      expect(await dlm.isProofValid(other.address, now, true)).to.equal(true);
      await bl.addToBlacklist(other.address, HIGH, 0, "direct");
      expect(await dlm.isProofValid(other.address, now, true)).to.equal(false);
      expect(await dlm.isProofValid(other.address, now, false)).to.equal(false);
    });

    it("the root slot and the identity status store are gone (plan 3.3)", async function () {
      const { dlm } = await fixture();
      const iface = new ethers.Interface(dlm.interface.fragments);
      for (const name of [
        "updateWhitelist",
        "updateBlacklist",
        "whitelistVersion",
        "blacklistVersion",
        "currentWhitelistRoot",
        "currentBlacklistRoot",
        "whitelistRootHistory",
        "blacklistRootHistory",
        "whitelistRootTimestamp",
        "blacklistRootTimestamp",
        "identityStatus",
        "getIdentityStatus",
      ]) {
        expect(iface.getFunction(name), name).to.equal(null);
      }
    });
  });

  describe("explicit durations (D20 = b)", function () {
    const HOUR = 3600;
    const TEN_YEARS = 10 * 365 * 86400;
    const advance = async (s: number) => {
      await ethers.provider.send("evm_increaseTime", [s]);
      await ethers.provider.send("evm_mine", []);
    };
    const ts = async (tx: any) =>
      BigInt(
        (await ethers.provider.getBlock((await tx.wait()).blockNumber))!
          .timestamp,
      );

    it("the manager rejects a zero duration for both writes", async function () {
      const { dlm, user } = await wired();
      await expect(
        dlm.addToWhitelist(user.address, 1, 1, 0, "r"),
      ).to.be.revertedWith("DynamicListManager: duration required");
      await expect(
        dlm.addToBlacklist(user.address, 1, HIGH, 0, "r"),
      ).to.be.revertedWith("DynamicListManager: duration required");
    });

    it("honours an explicit duration; the oracle event carries now + duration", async function () {
      const { dlm, user, other, wl, bl } = await wired();
      const tx1 = await dlm.addToWhitelist(user.address, 1, 1, HOUR, "r");
      await expect(tx1)
        .to.emit(wl, "WhitelistUpdated")
        .withArgs(user.address, true, 1, (await ts(tx1)) + BigInt(HOUR), "r");
      const tx2 = await dlm.addToBlacklist(other.address, 2, HIGH, HOUR, "b");
      await expect(tx2)
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(
          other.address,
          true,
          HIGH,
          (await ts(tx2)) + BigInt(HOUR),
          "b",
          false,
        );
      expect(await wl.isWhitelisted(user.address)).to.equal(true);
      expect(await dlm.getUserStatus(other.address)).to.equal(BLACKLISTED);

      await advance(HOUR + 1);
      expect(await wl.isWhitelisted(user.address)).to.equal(false);
      expect(await dlm.getUserStatus(user.address)).to.equal(NONE);
      expect(await bl.isBlacklisted(other.address)).to.equal(false);
      expect(await dlm.getUserStatus(other.address)).to.equal(NONE);
    });

    it("NO_EXPIRY stores expiryTime 0 and survives ten years and cleanup", async function () {
      const { dlm, user, other, wl, bl } = await wired();
      expect(await wl.NO_EXPIRY()).to.equal(NO_EXPIRY);
      expect(await bl.NO_EXPIRY()).to.equal(NO_EXPIRY);
      await expect(dlm.addToWhitelist(user.address, 1, 2, NO_EXPIRY, "w"))
        .to.emit(wl, "WhitelistUpdated")
        .withArgs(user.address, true, 2, 0, "w");
      await expect(dlm.addToBlacklist(other.address, 2, HIGH, NO_EXPIRY, "b"))
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(other.address, true, HIGH, 0, "b", false);

      await advance(TEN_YEARS);
      expect(await wl.isWhitelisted(user.address)).to.equal(true);
      const wi = await wl.getWhitelistInfo(user.address);
      expect(wi.isWhitelistedStatus).to.equal(true);
      expect(wi.expiryTime).to.equal(0n);
      expect(await dlm.getUserStatus(user.address)).to.equal(WHITELISTED);

      await expect(bl.cleanupExpiredEntries([other.address])).to.not.emit(
        bl,
        "BlacklistUpdated",
      );
      expect(await bl.isBlacklisted(other.address)).to.equal(true);
      const bi = await bl.getBlacklistInfo(other.address);
      expect(bi.isBlacklistedStatus).to.equal(true);
      expect(bi.expiryTime).to.equal(0n);
      expect(await dlm.getUserStatus(other.address)).to.equal(BLACKLISTED);

      // A permanent entry still ends by an explicit removal.
      await dlm.removeFromBlacklist(other.address, 2, "cleared");
      expect(await bl.isBlacklisted(other.address)).to.equal(false);
    });

    it("oracle owner writes and batches accept NO_EXPIRY; 0 keeps the default", async function () {
      const { user, other, stranger, wl, bl } = await fixture();
      await wl.addToWhitelist(user.address, 1, NO_EXPIRY, "w");
      await bl.addToBlacklist(user.address, HIGH, NO_EXPIRY, "b");
      await expect(
        wl.batchAddToWhitelist([other.address], [1], NO_EXPIRY, "bw"),
      )
        .to.emit(wl, "WhitelistUpdated")
        .withArgs(other.address, true, 1, 0, "bw");
      await expect(
        bl.batchAddToBlacklist([other.address], [HIGH], NO_EXPIRY, "bb"),
      )
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(other.address, true, HIGH, 0, "bb", false);
      const tx = await bl.addToBlacklist(stranger.address, HIGH, 0, "d");
      expect((await bl.getBlacklistInfo(stranger.address)).expiryTime).to.equal(
        (await ts(tx)) + (await bl.DEFAULT_BLACKLIST_DURATION()),
      );

      await advance(TEN_YEARS);
      for (const a of [user.address, other.address]) {
        expect(await wl.isWhitelisted(a)).to.equal(true);
        expect((await wl.getWhitelistInfo(a)).isWhitelistedStatus).to.equal(
          true,
        );
        expect(await bl.isBlacklisted(a)).to.equal(true);
        expect((await bl.getBlacklistInfo(a)).isBlacklistedStatus).to.equal(
          true,
        );
      }
      // The defaulted entry expired and is still cleaned up.
      expect(await bl.isBlacklisted(stranger.address)).to.equal(false);
      await expect(bl.cleanupExpiredEntries([stranger.address, user.address]))
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(stranger.address, false, 0, 0, "Expired", false);
      expect((await bl.blacklistEntries(user.address)).isBlacklisted).to.equal(
        true,
      );
    });

    it("the manager rejects a duration that would overflow the expiry", async function () {
      const { dlm, user } = await wired();
      for (const call of [
        dlm.addToWhitelist(user.address, 1, 1, NO_EXPIRY - 1n, "r"),
        dlm.addToBlacklist(user.address, 1, HIGH, NO_EXPIRY - 1n, "r"),
      ])
        await expect(call).to.be.revertedWith(
          "DynamicListManager: duration too large",
        );
    });

    async function withEmergencyOracle() {
      const f = await wired();
      const om = await ethers.getContractAt(
        "OracleManager",
        await f.bl.oracleManager(),
      );
      await om["registerOracle(address,string)"](f.stranger.address, "e");
      await f.bl.setEmergencyOracle(f.stranger.address, true);
      return f;
    }
    const CRITICAL = 3;
    const WEEK = 7 * 86400;

    it("an emergency listing never shortens a permanent entry", async function () {
      const { dlm, user, bl, stranger } = await withEmergencyOracle();
      await dlm.addToBlacklist(user.address, 1, HIGH, NO_EXPIRY, "voted");
      await expect(
        bl.connect(stranger).emergencyBlacklist(user.address, CRITICAL, "e"),
      )
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(user.address, true, CRITICAL, 0, "e", true);
      const e = await bl.blacklistEntries(user.address);
      expect(e.expiryTime).to.equal(0n);
      expect(e.emergencyListing).to.equal(true);
      await advance(8 * 86400);
      expect(await bl.isBlacklisted(user.address)).to.equal(true);
      await advance(TEN_YEARS);
      expect(await bl.isBlacklisted(user.address)).to.equal(true);
    });

    it("an emergency listing extends a shorter entry to now + 7 days", async function () {
      const { dlm, user, bl, stranger } = await withEmergencyOracle();
      await dlm.addToBlacklist(user.address, 1, HIGH, HOUR, "voted");
      const tx = await bl
        .connect(stranger)
        .emergencyBlacklist(user.address, CRITICAL, "e");
      const exp = (await ts(tx)) + BigInt(WEEK);
      await expect(tx)
        .to.emit(bl, "BlacklistUpdated")
        .withArgs(user.address, true, CRITICAL, exp, "e", true);
      expect((await bl.blacklistEntries(user.address)).expiryTime).to.equal(
        exp,
      );
    });

    it("an emergency listing never shortens a finite longer entry (M7)", async function () {
      const { dlm, user, bl, stranger } = await withEmergencyOracle();
      await dlm.addToBlacklist(user.address, 1, HIGH, 30 * 86400, "voted");
      const voted = (await bl.blacklistEntries(user.address)).expiryTime;
      await bl
        .connect(stranger)
        .emergencyBlacklist(user.address, CRITICAL, "e");
      expect((await bl.blacklistEntries(user.address)).expiryTime).to.equal(
        voted,
      );
      await advance(8 * 86400);
      expect(await bl.isBlacklisted(user.address)).to.equal(true);
    });
  });

  it("ownership is two-step (Ownable2Step)", async function () {
    const { dlm, owner, other } = await fixture();
    await dlm.transferOwnership(other.address);
    expect(await dlm.owner()).to.equal(owner.address);
    expect(await dlm.pendingOwner()).to.equal(other.address);
    await dlm.connect(other).acceptOwnership();
    expect(await dlm.owner()).to.equal(other.address);
  });
});
