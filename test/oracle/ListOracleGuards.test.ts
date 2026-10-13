import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Task 4.15 (C §2 ListOracleBase rows, C §3 M18, M19, N52-N54, N58,
// N60/N61; C §5 list-oracle branches). The pause family and setActive
// are the owner's, updateReputation the manager's; the owner's write path
// checks the tier range on both the single and the batch add; an emergency
// listing is CRITICAL only; an entry is live strictly before its expiry.
describe("List oracle guards (Task 4.15)", function () {
  let owner: SignerWithAddress, stranger: SignerWithAddress;
  let node: SignerWithAddress, subject: SignerWithAddress;
  let OM: any, WO: any, BO: any, asManager: any;
  const HOUR = 3600;

  beforeEach(async function () {
    [owner, stranger, node, subject] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    const om = await OM.getAddress();
    WO = await (
      await ethers.getContractFactory("WhitelistOracle")
    ).deploy(om, "WL", "whitelist");
    BO = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(om, "BL", "blacklist");
    await OM.registerOracle(node.address, "node", "", 500);
    asManager = await ethers.getImpersonatedSigner(om);
    await ethers.provider.send("hardhat_setBalance", [om, "0xde0b6b3a7640000"]);
  });

  describe("owner and manager gates (M19, N52-N54)", function () {
    it("emergencyPause, unpause and setActive are the owner's", async function () {
      for (const O of [WO, BO]) {
        await O.setListManager(stranger.address); // a writer is not the owner
        for (const call of [
          async () => O.connect(stranger).emergencyPause(),
          async () => O.connect(stranger).unpause(),
          async () => O.connect(stranger).setActive(false),
          async () => O.connect(stranger).setListManager(stranger.address),
        ])
          await expect(call())
            .to.be.revertedWithCustomError(O, "OwnableUnauthorizedAccount")
            .withArgs(stranger.address);
        expect(await O.isActive()).to.equal(true);
        expect(await O.paused()).to.equal(false);
      }
    });

    it("updateReputation is the manager's; the manager's write is read back", async function () {
      for (const [O, name] of [
        [WO, "WhitelistOracle"],
        [BO, "BlacklistOracle"],
      ] as [any, string][]) {
        for (const who of [owner, stranger, node])
          await expect(O.connect(who).updateReputation(900)).to.be.revertedWith(
            `${name}: Only oracle manager`,
          );
        await expect(O.connect(asManager).updateReputation(900))
          .to.emit(O, "OracleReputationUpdated")
          .withArgs(await O.getAddress(), 900);
        expect(await O.getReputation()).to.equal(900);
        expect((await O.getOracleInfo()).reputation).to.equal(900);
      }
    });

    // Round 2 (L5): the attestation entry is closed while inactive, before
    // any signature is read; the blacklist batch checks its lengths.
    it("provideAttestation refuses an inactive oracle: Oracle not active", async function () {
      for (const [O, name] of [
        [WO, "WhitelistOracle"],
        [BO, "BlacklistOracle"],
      ] as [any, string][]) {
        await O.setActive(false);
        await expect(
          O.connect(node).provideAttestation(
            subject.address,
            ethers.id("q"),
            true,
            "0x",
            "0x",
          ),
        ).to.be.revertedWith(`${name}: Oracle not active`);
        await O.setActive(true);
        await expect(
          O.connect(node).provideAttestation(
            subject.address,
            ethers.id("q"),
            true,
            "0x",
            "0x",
          ),
        ).to.not.be.revertedWith(`${name}: Oracle not active`);
      }
    });

    it("batchAddToBlacklist is the owner's and checks the array lengths", async function () {
      const s = [subject.address, stranger.address];
      await expect(BO.connect(stranger).batchAddToBlacklist(s, [1, 1], 0, "r"))
        .to.be.revertedWithCustomError(BO, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      await expect(BO.batchAddToBlacklist(s, [1], 0, "r")).to.be.revertedWith(
        "BlacklistOracle: Array length mismatch",
      );
      await BO.batchAddToBlacklist(s, [1, 2], 0, "r");
      expect((await BO.getBlacklistInfo(subject.address)).severity).to.equal(1);
      expect((await BO.getBlacklistInfo(stranger.address)).severity).to.equal(
        2,
      );
    });

    it("pause stops the oracle, unpause restores it; setActive flips the flag", async function () {
      for (const O of [WO, BO]) {
        const self = await O.getAddress();
        await expect(O.emergencyPause())
          .to.emit(O, "OracleStatusChanged")
          .withArgs(self, false);
        expect(await O.paused()).to.equal(true);
        expect(await O.isActive()).to.equal(false);
        expect((await O.getOracleInfo()).oracleActive).to.equal(false);
        await expect(O.unpause())
          .to.emit(O, "OracleStatusChanged")
          .withArgs(self, true);
        expect(await O.paused()).to.equal(false);
        expect(await O.isActive()).to.equal(true);
        await expect(O.setActive(false))
          .to.emit(O, "OracleStatusChanged")
          .withArgs(self, false);
        expect(await O.isActive()).to.equal(false);
        await O.setActive(true);
        expect(await O.isActive()).to.equal(true);
      }
    });
  });

  describe("the owner's whitelist writes check the tier (M18)", function () {
    const BAD = "WhitelistOracle: Invalid tier";

    it("addToWhitelist refuses tier 0 and 6; 1 and 5 pass", async function () {
      for (const t of [0, 6])
        await expect(
          WO.addToWhitelist(subject.address, t, 0, "r"),
        ).to.be.revertedWith(BAD);
      await expect(
        WO.addToWhitelist(ethers.ZeroAddress, 1, 0, "r"),
      ).to.be.revertedWith("WhitelistOracle: Invalid subject");
      for (const t of [1, 5]) {
        await WO.addToWhitelist(subject.address, t, 0, "r");
        expect((await WO.getWhitelistInfo(subject.address)).tier).to.equal(t);
      }
    });

    it("batchAddToWhitelist is the owner's, same checks, same length", async function () {
      const s = [subject.address, stranger.address];
      await expect(WO.connect(stranger).batchAddToWhitelist(s, [1, 1], 0, "r"))
        .to.be.revertedWithCustomError(WO, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      await expect(WO.batchAddToWhitelist(s, [1], 0, "r")).to.be.revertedWith(
        "WhitelistOracle: Array length mismatch",
      );
      for (const tiers of [
        [1, 0],
        [6, 1],
      ])
        await expect(
          WO.batchAddToWhitelist(s, tiers, 0, "r"),
        ).to.be.revertedWith(BAD);
      await expect(
        WO.batchAddToWhitelist(
          [subject.address, ethers.ZeroAddress],
          [1, 1],
          0,
          "r",
        ),
      ).to.be.revertedWith("WhitelistOracle: Invalid subject");
      expect(await WO.isWhitelisted(subject.address)).to.equal(false);
      await WO.batchAddToWhitelist(s, [2, 5], 0, "r");
      expect((await WO.getWhitelistInfo(subject.address)).tier).to.equal(2);
      expect((await WO.getWhitelistInfo(stranger.address)).tier).to.equal(5);
    });
  });

  describe("emergency blacklisting (N58)", function () {
    beforeEach(async function () {
      await OM.setEmergencyOracle(node.address, true);
    });

    it("takes CRITICAL only, a real subject, an emergency oracle, an active oracle", async function () {
      for (const sev of [0, 1, 2])
        await expect(
          BO.connect(node).emergencyBlacklist(subject.address, sev, "r"),
        ).to.be.revertedWith(
          "BlacklistOracle: Only critical severity for emergency",
        );
      await expect(
        BO.connect(node).emergencyBlacklist(ethers.ZeroAddress, 3, "r"),
      ).to.be.revertedWith("BlacklistOracle: Invalid subject");
      await expect(
        BO.connect(stranger).emergencyBlacklist(subject.address, 3, "r"),
      ).to.be.revertedWith("BlacklistOracle: Not an emergency oracle");
      await BO.emergencyPause();
      await expect(
        BO.connect(node).emergencyBlacklist(subject.address, 3, "r"),
      ).to.be.revertedWith("BlacklistOracle: Oracle not active");
      await BO.unpause();
      expect(await BO.isBlacklisted(subject.address)).to.equal(false);
      await expect(BO.connect(node).emergencyBlacklist(subject.address, 3, "r"))
        .to.emit(BO, "EmergencyBlacklistAdded")
        .withArgs(subject.address, node.address, 3, "r");
      const e = await BO.getBlacklistInfo(subject.address);
      expect([
        e.isBlacklistedStatus,
        e.severity,
        e.emergencyListing,
      ]).to.deep.equal([true, 3n, true]);
    });

    it("never shortens a live entry: a longer or permanent expiry wins", async function () {
      await BO.addToBlacklist(subject.address, 1, 30 * 24 * HOUR, "long");
      const long = (await BO.getBlacklistInfo(subject.address)).expiryTime;
      await BO.connect(node).emergencyBlacklist(subject.address, 3, "e");
      expect((await BO.getBlacklistInfo(subject.address)).expiryTime).to.equal(
        long,
      );
      await BO.addToBlacklist(stranger.address, 1, ethers.MaxUint256, "never");
      await BO.connect(node).emergencyBlacklist(stranger.address, 3, "e");
      expect((await BO.getBlacklistInfo(stranger.address)).expiryTime).to.equal(
        0,
      );
    });
  });

  describe("an entry is live strictly before its expiry (N60/N61)", function () {
    it("whitelist: true at expiry - 1, false at expiry", async function () {
      await WO.addToWhitelist(subject.address, 2, HOUR, "r");
      const exp = (await WO.getWhitelistInfo(subject.address)).expiryTime;
      await time.increaseTo(exp - 1n);
      expect(await WO.isWhitelisted(subject.address)).to.equal(true);
      expect(
        (await WO.getWhitelistInfo(subject.address)).isWhitelistedStatus,
      ).to.equal(true);
      await time.increaseTo(exp);
      expect(await WO.isWhitelisted(subject.address)).to.equal(false);
      const e = await WO.getWhitelistInfo(subject.address);
      expect([e.isWhitelistedStatus, e.tier]).to.deep.equal([false, 2n]);
    });

    it("blacklist: true at expiry - 1, false at expiry; a permanent entry stays", async function () {
      await BO.addToBlacklist(subject.address, 2, HOUR, "r");
      await BO.addToBlacklist(stranger.address, 2, ethers.MaxUint256, "r");
      const exp = (await BO.getBlacklistInfo(subject.address)).expiryTime;
      await time.increaseTo(exp - 1n);
      expect(await BO.isBlacklisted(subject.address)).to.equal(true);
      await time.increaseTo(exp);
      expect(await BO.isBlacklisted(subject.address)).to.equal(false);
      expect(
        (await BO.getBlacklistInfo(subject.address)).isBlacklistedStatus,
      ).to.equal(false);
      expect(await BO.isBlacklisted(stranger.address)).to.equal(true);
    });
  });

  // Task 4.17 slice A (review C mutants O05, O06).
  describe("setter and removal refusals (Task 4.17)", function () {
    // Task 5.1 review I4: the floor is 2 in the contract, not only in the
    // ceremony; one place (ListOracleBase) for both list oracles.
    it("setMinimumConsensusOracles refuses 0 and 1 on both list oracles", async function () {
      for (const O of [WO, BO]) {
        expect(await O.minimumConsensusOracles()).to.equal(2);
        for (const bad of [0, 1])
          await expect(O.setMinimumConsensusOracles(bad))
            .to.be.revertedWithCustomError(O, "MinimumBelowFloor")
            .withArgs(bad, 2);
        expect(await O.minimumConsensusOracles()).to.equal(2);
        await O.setMinimumConsensusOracles(3);
        expect(await O.minimumConsensusOracles()).to.equal(3);
        await O.setMinimumConsensusOracles(2);
        expect(await O.minimumConsensusOracles()).to.equal(2);
      }
    });

    // Task 4.17 (A1F-3): a reason is a label; at most 256 bytes.
    it("addToWhitelist and its batch refuse a reason over 256 bytes", async function () {
      const long = "r".repeat(257);
      await expect(
        WO.addToWhitelist(subject.address, 2, 0, long),
      ).to.be.revertedWithCustomError(WO, "ReasonTooLong");
      await expect(
        WO.batchAddToWhitelist([subject.address], [2], 0, long),
      ).to.be.revertedWithCustomError(WO, "ReasonTooLong");
      await WO.addToWhitelist(subject.address, 2, 0, "r".repeat(256));
      await WO.batchAddToWhitelist([stranger.address], [3], 0, "r".repeat(256));
      expect(await WO.whitelistStanding(subject.address)).to.deep.equal([
        true,
        2n,
      ]);
      expect(await WO.whitelistStanding(stranger.address)).to.deep.equal([
        true,
        3n,
      ]);
    });

    it("removeFromWhitelist refuses a subject that is not listed", async function () {
      await expect(
        WO.removeFromWhitelist(subject.address, "never listed"),
      ).to.be.revertedWith("WhitelistOracle: Not whitelisted");
      await WO.addToWhitelist(subject.address, 2, 0, "r");
      await WO.removeFromWhitelist(subject.address, "done");
      await expect(
        WO.removeFromWhitelist(subject.address, "twice"),
      ).to.be.revertedWith("WhitelistOracle: Not whitelisted");
    });
  });
});
