import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Plan 2F.3 part B (review L4 B-L2, B-L3): ConsensusOracle stays the
// engine D11 plans for 4.4, so it gets minimum participation on forced
// resolution and sender-bound vote signatures; OracleManager's two
// fail-open interface stubs compute from real state.

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
      await OM["registerOracle(address,string,string,uint256)"](
        n.address,
        "node",
        "",
        500,
      );
    }
    CO = await (
      await ethers.getContractFactory("ConsensusOracle")
    ).deploy(await OM.getAddress(), "CO", "");
    // Two voters of four meet participation; 1 yes + 1 no reaches no 66% side.
    await CO.setMinimumOracles(2);
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

  describe("ConsensusOracle", function () {
    it("forceResolveExpiredQuery with fewer than minimumOracles voters is refused", async function () {
      const q = await createQuery();
      await vote(n1, q, true);
      await expire();
      await expect(
        CO.connect(stranger).forceResolveExpiredQuery(q),
      ).to.be.revertedWithCustomError(CO, "InsufficientParticipation");
      const [resolved] = await CO.getConsensusResult(q);
      expect(resolved).to.equal(false);
    });

    it("forceResolveExpiredQuery with minimumOracles voters resolves", async function () {
      const q = await createQuery();
      await vote(n1, q, true);
      await vote(n2, q, false);
      let [resolved] = await CO.getConsensusResult(q);
      expect(resolved).to.equal(false); // no 66% side yet
      await expire();
      await CO.connect(stranger).forceResolveExpiredQuery(q);
      const r = await CO.getConsensusResult(q);
      expect(r.isResolved).to.equal(true);
      expect(r.result).to.equal(false); // tie is not a yes
    });

    it("submitVote with another oracle's signature is refused", async function () {
      const q = await createQuery();
      await expect(
        CO.connect(n1).submitVote(q, true, await voteSig(n2, q, true)),
      ).to.be.revertedWithCustomError(CO, "SignerMismatch");
      await vote(n1, q, true); // own signature still works
      expect(await CO.getQueryVoters(q)).to.deep.equal([n1.address]);
    });
  });

  describe("OracleManager.validateOracleConsensus", function () {
    const h = ethers.id("message");
    const sig = (w: SignerWithAddress) => w.signMessage(ethers.getBytes(h));

    it("true when threshold distinct active oracles signed the hash", async function () {
      expect(await OM.getConsensusThreshold()).to.equal(3);
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
      await OM.deactivateOracle(n3.address);
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
      await OM.removeOracle(n1.address);
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(false);
      await OM.setEmergencyOracle(n2.address, true);
      await OM.deregisterOracle(n2.address, "gone");
      expect(await OM.isEmergencyOracle(n2.address)).to.equal(false);
    });

    it("reputation alone no longer makes an emergency oracle", async function () {
      await OM.updateOracleReputation(n1.address, 1000);
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(false);
    });
  });
});
