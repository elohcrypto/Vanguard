import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { bindEngine } from "../helpers/oracles";

// Plan 2F.3 part B (review L4 B-L3): OracleManager's two fail-open
// interface stubs compute from real state. Task 4.4 deleted the engine's
// own front door (forced resolution, signed votes): see
// ConsensusEngine.test.ts for the one rule.

const BLACKLIST = 2;

describe("Consensus engine guards (2F.3 B)", function () {
  let owner: SignerWithAddress, n1: SignerWithAddress, n2: SignerWithAddress;
  let n3: SignerWithAddress, n4: SignerWithAddress, subject: SignerWithAddress;
  let stranger: SignerWithAddress;
  let OM: any, CO: any;
  let chainId: bigint;

  beforeEach(async function () {
    [owner, n1, n2, n3, n4, subject, stranger] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    for (const n of [n1, n2, n3, n4]) {
      await OM.registerOracle(n.address, "node", "", 500);
    }
    CO = await bindEngine(OM);
    // Three of four equal nodes: 300 of 400 meets 75%, two do not.
    await OM.setConsensusThreshold(75);
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  const voteSig = (w: SignerWithAddress, q: string, v: boolean) =>
    w.signMessage(
      ethers.getBytes(
        ethers.solidityPackedKeccak256(
          ["address", "bytes32", "bool", "uint256"],
          [subject.address, q, v, chainId],
        ),
      ),
    );

  async function createQuery(): Promise<string> {
    const tx = await CO.connect(owner).createConsensusQuery(
      subject.address,
      BLACKLIST,
      "0x",
    );
    const blk = await ethers.provider.getBlock((await tx.wait()).blockNumber);
    return ethers.solidityPackedKeccak256(
      ["address", "uint8", "bytes", "uint256", "address"],
      [subject.address, BLACKLIST, "0x", blk!.timestamp, owner.address],
    );
  }

  const vote = async (w: SignerWithAddress, q: string, v: boolean) =>
    CO.connect(w).submitVote(q, v, await voteSig(w, q, v));

  async function expire() {
    await network.provider.send("evm_increaseTime", [3601]);
    await network.provider.send("evm_mine");
  }

  describe("OracleManager.validateOracleConsensus", function () {
    const h = ethers.id("message");
    const sig = (w: SignerWithAddress) => w.signMessage(ethers.getBytes(h));

    it("true when threshold distinct active oracles signed the hash", async function () {
      expect(await OM.getConsensusThreshold()).to.equal(75);
      const ws = [n1, n2, n3];
      expect(
        await OM.validateOracleConsensus(
          ws.map((w) => w.address),
          await Promise.all(ws.map(sig)),
          h,
        ),
      ).to.equal(true);
    });

    it("false below threshold, on duplicates, mismatches and inactive signers", async function () {
      const s1 = await sig(n1);
      const s2 = await sig(n2);
      const s3 = await sig(n3);
      const a = [n1.address, n2.address, n3.address];
      // two signatures
      expect(
        await OM.validateOracleConsensus(a.slice(0, 2), [s1, s2], h),
      ).to.equal(false);
      // one oracle counted three times
      expect(
        await OM.validateOracleConsensus(
          [n1.address, n1.address, n1.address],
          [s1, s1, s1],
          h,
        ),
      ).to.equal(false);
      // n3's slot carries n2's signature
      expect(await OM.validateOracleConsensus(a, [s1, s2, s2], h)).to.equal(
        false,
      );
      // a stranger signs for itself
      expect(
        await OM.validateOracleConsensus(
          [n1.address, n2.address, stranger.address],
          [s1, s2, await sig(stranger)],
          h,
        ),
      ).to.equal(false);
      // length mismatch and garbage signature
      expect(await OM.validateOracleConsensus(a, [s1, s2], h)).to.equal(false);
      expect(
        await OM.validateOracleConsensus(a, [s1, s2, "0x1234"], h),
      ).to.equal(false);
      // a deactivated signer no longer counts
      expect(await OM.validateOracleConsensus(a, [s1, s2, s3], h)).to.equal(
        true,
      );
      // a paused signer no longer counts: 200 of the live 300 is below 75%
      await OM.pauseOracle(n3.address);
      expect(await OM.validateOracleConsensus(a, [s1, s2, s3], h)).to.equal(
        false,
      );
    });
  });

  describe("OracleManager.setEmergencyOracle", function () {
    it("records the flag with an event; owner only; registered only", async function () {
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(false);
      await expect(OM.setEmergencyOracle(n1.address, true))
        .to.emit(OM, "EmergencyOracleSet")
        .withArgs(n1.address, true);
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(true);
      await OM.setEmergencyOracle(n1.address, false);
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(false);
      await expect(OM.connect(stranger).setEmergencyOracle(n1.address, true)).to
        .be.reverted;
      await expect(OM.setEmergencyOracle(stranger.address, true)).to.be
        .reverted;
    });

    it("a removed oracle loses the flag", async function () {
      await OM.setEmergencyOracle(n1.address, true);
      await OM.removeOracle(n1.address, "gone");
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(false);
    });

    it("reputation alone no longer makes an emergency oracle", async function () {
      await OM.updateOracleReputation(n1.address, 1000);
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(false);
    });
  });

  describe("Blacklist/Whitelist oracle roles (2F.3 review LOW-2, N-7)", function () {
    let BO: any, WO: any;
    beforeEach(async function () {
      const om = await OM.getAddress();
      const F = async (n: string) =>
        (await ethers.getContractFactory(n)).deploy(om, n, "");
      BO = await F("BlacklistOracle");
      WO = await F("WhitelistOracle");
    });

    it("P6: a removed node loses BlacklistOracle emergency power", async function () {
      await OM.setEmergencyOracle(n4.address, true);
      await BO.connect(n4).emergencyBlacklist(subject.address, 3, "live");
      await OM.removeOracle(n4.address, "offboarded");
      await expect(
        BO.connect(n4).emergencyBlacklist(stranger.address, 3, "after removal"),
      ).to.be.revertedWith("BlacklistOracle: Not an emergency oracle");
      expect(await BO.isBlacklisted(stranger.address)).to.equal(false);
    });

    it("N-7: an attestation signed by another active node is refused", async function () {
      const tx = await OM.connect(n1).submitQuery(
        subject.address,
        BLACKLIST,
        "0x",
      );
      const blk = await ethers.provider.getBlock((await tx.wait()).blockNumber);
      const q = ethers.solidityPackedKeccak256(
        ["address", "uint8", "bytes", "uint256", "address"],
        [subject.address, BLACKLIST, "0x", blk!.timestamp, n1.address],
      );
      for (const [O, name] of [
        [BO, "BlacklistOracle"],
        [WO, "WhitelistOracle"],
      ] as [any, string][]) {
        const other = await voteSig(n2, q, true); // n2 signs, n1 sends
        await expect(
          O.connect(n1).provideAttestation(
            subject.address,
            q,
            true,
            other,
            "0x",
          ),
        ).to.be.revertedWith(`${name}: Invalid signature`);
        expect(
          await O.connect(n1).verifySignature(subject.address, q, true, other),
        ).to.equal(false);
      }
    });
  });
});
