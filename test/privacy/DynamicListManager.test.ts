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
        dlm.addToWhitelist(user.address, 1, 1, "r"),
      ).to.be.revertedWith("DynamicListManager: oracles not set");
      await expect(
        dlm.addToBlacklist(user.address, 1, HIGH, "r"),
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
        dlm.addToWhitelist(user.address, 1, 1, "r"),
      ).to.be.revertedWith("WhitelistOracle: Only owner or list manager");
    });

    it("rejects an out-of-range severity", async function () {
      const { dlm, user } = await wired();
      await expect(
        dlm.addToBlacklist(user.address, 1, 4, "r"),
      ).to.be.revertedWith("Invalid severity");
    });
  });

  describe("status derived from the oracles", function () {
    it("governance whitelists, blacklists and restores through the oracles", async function () {
      const { dlm, gov, user, wl, bl } = await wired();
      await expect(dlm.connect(gov).addToWhitelist(user.address, 7, 3, "kyc"))
        .to.emit(dlm, "UserStatusChanged")
        .withArgs(user.address, 7, NONE, WHITELISTED, "kyc");
      expect(await wl.isWhitelisted(user.address)).to.equal(true);
      expect((await wl.getWhitelistInfo(user.address)).tier).to.equal(3n);
      expect(await dlm.getUserStatus(user.address)).to.equal(WHITELISTED);

      await dlm.connect(gov).addToBlacklist(user.address, 7, HIGH, "sanctions");
      expect(await bl.isBlacklisted(user.address)).to.equal(true);
      expect((await bl.blacklistEntries(user.address)).severity).to.equal(
        BigInt(HIGH),
      );
      expect(await dlm.getUserStatus(user.address)).to.equal(BLACKLISTED);
      await expect(
        dlm.connect(gov).addToWhitelist(user.address, 7, 1, "again"),
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
        dlm.connect(stranger).addToWhitelist(user.address, 1, 1, "r"),
      ).to.be.revertedWith("Only owner or governance");
    });
  });

  describe("identity status and history", function () {
    it("records identity status and both histories", async function () {
      const { dlm, user } = await wired();
      await dlm.addToWhitelist(user.address, 42, 1, "a");
      await dlm.addToBlacklist(user.address, 42, HIGH, "b");
      expect(await dlm.getIdentityStatus(42)).to.equal(BLACKLISTED);
      expect(await dlm.getUserStatusHistoryCount(user.address)).to.equal(2n);
      expect(await dlm.getIdentityStatusHistoryCount(42)).to.equal(2n);
      const h = await dlm.userStatusHistory(user.address, 1);
      expect(h.oldStatus).to.equal(WHITELISTED);
      expect(h.newStatus).to.equal(BLACKLISTED);
      expect(h.reason).to.equal("b");
    });

    it("isProofValid follows identity status and expiry as before", async function () {
      const { dlm, user } = await wired();
      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      expect(await dlm.isProofValid(9, now, true)).to.equal(false);
      expect(await dlm.isProofValid(9, now, false)).to.equal(true);
      await dlm.addToWhitelist(user.address, 9, 1, "a");
      expect(await dlm.isProofValid(9, now, true)).to.equal(true);
      await dlm.addToBlacklist(user.address, 9, HIGH, "b");
      expect(await dlm.isProofValid(9, now, true)).to.equal(false);
      expect(await dlm.isProofValid(9, now, false)).to.equal(false);
      await dlm.removeFromBlacklist(user.address, 9, "c");
      const expired = now - (await dlm.proofExpiryDuration()) - 10n;
      expect(await dlm.isProofValid(9, expired, true)).to.equal(false);
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
