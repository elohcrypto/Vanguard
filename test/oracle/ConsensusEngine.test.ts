import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { bindEngine } from "../helpers/oracles";

// Plan v2 Task 4.4 (D11 = a): OracleManager is the gate and the one vote
// entry; ConsensusOracle is its weighted engine with one rule (snapshot of
// the active weight at open, a percent threshold, expiry closes without a
// verdict). The operator (ops) pauses, unpauses and emergency-designates.

const WHITELIST = 1;
// Task 4.12: a whitelist query carries its tier, abi.encode(tier) 1..5.
const TIER3 = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [3]);
const CRITICAL = 3;

describe("Consensus engine under the gate (4.4)", function () {
  let owner: SignerWithAddress, ops: SignerWithAddress;
  let n1: SignerWithAddress, n2: SignerWithAddress, n3: SignerWithAddress;
  let n4: SignerWithAddress, subject: SignerWithAddress;
  let stranger: SignerWithAddress;
  let OM: any, CO: any, BO: any, WO: any;

  beforeEach(async function () {
    [owner, ops, n1, n2, n3, n4, subject, stranger] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    CO = await bindEngine(OM);
    for (const n of [n1, n2, n3]) {
      await OM.registerOracle(n.address, "node", "", 500);
    }
    const om = await OM.getAddress();
    const F = async (name: string) =>
      (await ethers.getContractFactory(name)).deploy(om, name, "");
    BO = await F("BlacklistOracle");
    WO = await F("WhitelistOracle");
    await OM.setOperator(ops.address);
  });

  async function raise(by: SignerWithAddress = owner): Promise<string> {
    const rc = await (
      await OM.connect(by).submitQuery(subject.address, WHITELIST, TIER3)
    ).wait();
    return rc.logs
      .map((l: any) => CO.interface.parseLog(l))
      .find((e: any) => e?.name === "ConsensusQueryCreated").args[0];
  }
  const answer = (n: SignerWithAddress, q: string, v: boolean) =>
    OM.connect(n).submitResponse(q, v);
  const resolution = async (q: string) =>
    (await OM.getQueryResolution(q)).slice(0, 2);
  const sign = async (n: SignerWithAddress, q: string, v: boolean) => {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const h = ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bool", "uint256"],
      [subject.address, q, v, chainId],
    );
    return n.signMessage(ethers.getBytes(h));
  };

  describe("one rule", function () {
    it("evidence: a paused oracle's attestation is ignored by consensus", async function () {
      await OM.registerOracle(n4.address, "node", "", 500);
      await OM.connect(ops).pauseOracle(n4.address);
      const q = await raise();
      // The paused node can neither answer nor attest.
      await expect(answer(n4, q, false)).to.be.revertedWith(
        "OracleManager: Oracle not active",
      );
      await expect(
        WO.connect(n4).provideAttestation(
          subject.address,
          q,
          false,
          await sign(n4, q, false),
          "0x",
        ),
      ).to.be.revertedWith("WhitelistOracle: Not an active oracle");
      // The paused node stays in the denominator (400): the three active
      // nodes resolve, from their own answers only (bar 400 * 66).
      expect((await CO.getConsensusResult(q)).snapshotWeight).to.equal(400);
      await answer(n1, q, true);
      await answer(n2, q, true);
      expect(await resolution(q)).to.deep.equal([false, false]);
      await expect(answer(n3, q, true))
        .to.emit(CO, "ConsensusReached")
        .withArgs(q, true, 300, 0, 400, (t: bigint) => t > 0n);
      expect(await resolution(q)).to.deep.equal([true, true]);
      expect(await CO.getQueryVoters(q)).to.deep.equal([
        n1.address,
        n2.address,
        n3.address,
      ]);
    });

    it("a 1-1 split of three equal nodes resolves nothing", async function () {
      const q = await raise();
      await answer(n1, q, true);
      await answer(n2, q, false);
      expect(await resolution(q)).to.deep.equal([false, false]);
      await answer(n3, q, false);
      expect(await resolution(q)).to.deep.equal([true, false]);
    });

    it("weights count from the snapshot; removal resets a node's weight", async function () {
      await OM.setOracleWeight(n1.address, 400);
      const q = await raise(); // 400 + 100 + 100
      await expect(answer(n1, q, true))
        .to.emit(CO, "ConsensusReached")
        .withArgs(q, true, 400, 0, 600, (t: bigint) => t > 0n);
      await OM.removeOracle(n1.address, "offboarded");
      expect(await CO.oracleWeights(n1.address)).to.equal(0);
      expect(await CO.getOracleWeight(n1.address)).to.equal(0);
    });

    it("an expired query closes without a verdict", async function () {
      const q = await raise();
      await answer(n1, q, true);
      await network.provider.send("evm_increaseTime", [3600]);
      await network.provider.send("evm_mine");
      await expect(answer(n2, q, true)).to.be.revertedWithCustomError(
        CO,
        "QueryExpired",
      );
      const r = await CO.getConsensusResult(q);
      expect([r.isResolved, r.expired]).to.deep.equal([false, true]);
      expect(await resolution(q)).to.deep.equal([false, false]);
      await expect(
        WO.connect(n1).provideAttestation(
          subject.address,
          q,
          true,
          await sign(n1, q, true),
          "0x",
        ),
      ).to.not.emit(WO, "WhitelistUpdated");
      expect(await WO.isWhitelisted(subject.address)).to.equal(false);
    });

    it("refuses a second vote, a vote after resolution; all paused opens but cannot resolve", async function () {
      const q = await raise();
      await answer(n1, q, true);
      await expect(answer(n1, q, true)).to.be.revertedWithCustomError(
        CO,
        "AlreadyVoted",
      );
      await answer(n2, q, true);
      await expect(answer(n3, q, false)).to.be.revertedWithCustomError(
        OM,
        "QueryAlreadyResolved",
      );
      for (const n of [n1, n2, n3]) await OM.pauseOracle(n.address);
      const q2 = await raise(); // opens (snapshot 300), nobody may answer
      expect((await CO.getConsensusResult(q2)).snapshotWeight).to.equal(300);
      await expect(answer(n1, q2, true)).to.be.revertedWith(
        "OracleManager: Oracle not active",
      );
    });

    it("validateOracleConsensus tallies signer weight against the live total", async function () {
      await OM.setOracleWeight(n1.address, 400);
      const h = ethers.id("message");
      const s = (n: SignerWithAddress) => n.signMessage(ethers.getBytes(h));
      // 400 of 600 is 66.7%: n1 alone meets 66, n2 + n3 (200) do not.
      expect(await OM.validateOracleConsensus([n1.address], [await s(n1)], h))
        .to.be.true;
      expect(
        await OM.validateOracleConsensus(
          [n2.address, n3.address],
          [await s(n2), await s(n3)],
          h,
        ),
      ).to.be.false;
      await OM.setConsensusThreshold(70);
      expect(await OM.validateOracleConsensus([n1.address], [await s(n1)], h))
        .to.be.false;
      // Against the registered total: pausing n2 and n3 does not lower it.
      await OM.setConsensusThreshold(66);
      await OM.setOracleWeight(n1.address, 100);
      await OM.connect(ops).pauseOracle(n2.address);
      await OM.connect(ops).pauseOracle(n3.address);
      expect(await OM.validateOracleConsensus([n1.address], [await s(n1)], h))
        .to.be.false;
    });

    it("threshold is a percent in (50, 100]", async function () {
      expect(await OM.getConsensusThreshold()).to.equal(66);
      for (const bad of [0, 50, 101]) {
        await expect(
          OM.setConsensusThreshold(bad),
        ).to.be.revertedWithCustomError(CO, "InvalidThreshold");
      }
      await OM.setConsensusThreshold(100);
      expect(await CO.consensusThreshold()).to.equal(100);
    });
  });

  describe("roles", function () {
    it("the operator pauses, unpauses and emergency-designates; nothing else", async function () {
      await expect(OM.connect(ops).pauseOracle(n1.address))
        .to.emit(OM, "OracleDeactivated")
        .withArgs(n1.address);
      await expect(OM.connect(ops).unpauseOracle(n1.address))
        .to.emit(OM, "OracleActivated")
        .withArgs(n1.address);
      await expect(OM.connect(ops).setEmergencyOracle(n1.address, true))
        .to.emit(OM, "EmergencyOracleSet")
        .withArgs(n1.address, true);
      const ownerOnly = [
        OM.connect(ops).removeOracle(n1.address, "x"),
        OM.connect(ops).registerOracle(n4.address, "x", "", 500),
        OM.connect(ops).setOperator(ops.address),
        OM.connect(ops).setConsensusThreshold(70),
        OM.connect(ops).setOracleWeight(n1.address, 200),
        OM.connect(ops).setQueryExpiryTime(3600),
        OM.connect(ops).setConsensusEngine(await CO.getAddress()),
        OM.connect(ops).emergencyOverride(
          n1.address,
          ethers.id("q"),
          true,
          "x",
        ),
      ];
      for (const call of ownerOnly) {
        await expect(call).to.be.revertedWithCustomError(
          OM,
          "OwnableUnauthorizedAccount",
        );
      }
      for (const call of [
        OM.connect(stranger).pauseOracle(n2.address),
        OM.connect(stranger).setEmergencyOracle(n2.address, true),
      ]) {
        await expect(call).to.be.revertedWithCustomError(
          OM,
          "NotOwnerOrOperator",
        );
      }
      await expect(OM.setOperator(ethers.ZeroAddress))
        .to.emit(OM, "OperatorUpdated")
        .withArgs(ops.address, ethers.ZeroAddress);
      await expect(
        OM.connect(ops).pauseOracle(n2.address),
      ).to.be.revertedWithCustomError(OM, "NotOwnerOrOperator");
    });

    it("pause and unpause check state; a node at MIN_REPUTATION stays parked", async function () {
      await expect(OM.unpauseOracle(n1.address)).to.be.revertedWith(
        "OracleManager: Oracle already active",
      );
      await OM.penalizeOracle(n1.address, 1000, "bad answers");
      expect(await OM.isActiveOracle(n1.address)).to.equal(false);
      await expect(OM.connect(ops).pauseOracle(n1.address)).to.be.revertedWith(
        "OracleManager: Oracle already inactive",
      );
      await expect(
        OM.connect(ops).unpauseOracle(n1.address),
      ).to.be.revertedWithCustomError(OM, "ReputationTooLow");
      await OM.rewardOracle(n1.address, 100, "reviewed");
      await OM.connect(ops).unpauseOracle(n1.address);
      expect(await OM.isActiveOracle(n1.address)).to.equal(true);
    });

    it("the operator cannot undo a pause by the owner (governance)", async function () {
      await OM.pauseOracle(n2.address);
      expect(await OM.pausedByOwner(n2.address)).to.equal(true);
      await expect(
        OM.connect(ops).unpauseOracle(n2.address),
      ).to.be.revertedWithCustomError(OM, "PausedByOwner");
      await OM.unpauseOracle(n2.address);
      expect(await OM.pausedByOwner(n2.address)).to.equal(false);
      // A pause by the operator stays the operator's to undo...
      await OM.connect(ops).pauseOracle(n2.address);
      expect(await OM.pausedByOwner(n2.address)).to.equal(false);
      // ...until the owner adopts it (L-2): no revert, recorded, evented.
      await expect(OM.pauseOracle(n2.address))
        .to.emit(OM, "OwnerPauseAdopted")
        .withArgs(n2.address);
      expect(await OM.pausedByOwner(n2.address)).to.equal(true);
      await expect(
        OM.connect(ops).unpauseOracle(n2.address),
      ).to.be.revertedWithCustomError(OM, "PausedByOwner");
      await OM.unpauseOracle(n2.address);
    });

    it("emergencyBlacklist needs the manager's designation and a live node", async function () {
      await expect(
        BO.connect(n1).emergencyBlacklist(subject.address, CRITICAL, "x"),
      ).to.be.revertedWith("BlacklistOracle: Not an emergency oracle");
      await OM.connect(ops).setEmergencyOracle(n1.address, true);
      expect(await OM.isEmergencyOracle(n1.address)).to.equal(true);
      await BO.connect(n1).emergencyBlacklist(subject.address, CRITICAL, "x");
      expect(await BO.isBlacklisted(subject.address)).to.equal(true);
      await OM.connect(ops).pauseOracle(n1.address);
      await expect(
        BO.connect(n1).emergencyBlacklist(stranger.address, CRITICAL, "x"),
      ).to.be.revertedWith("BlacklistOracle: Not an emergency oracle");
      await OM.connect(ops).unpauseOracle(n1.address);
      await OM.connect(ops).setEmergencyOracle(n1.address, false);
      await expect(
        BO.connect(n1).emergencyBlacklist(stranger.address, CRITICAL, "x"),
      ).to.be.revertedWith("BlacklistOracle: Not an emergency oracle");
      expect(await BO.isBlacklisted(stranger.address)).to.equal(false);
    });
  });

  describe("binding", function () {
    it("engine writes are refused from anyone but the manager", async function () {
      const q = ethers.id("q");
      for (const who of [owner, stranger]) {
        const c = CO.connect(who);
        for (const call of [
          c.openQuery(q),
          c.recordVote(q, n1.address, true),
          c.setConsensusThreshold(70),
          c.setOracleWeight(n1.address, 200),
          c.setQueryExpiryTime(3600),
        ]) {
          await expect(call).to.be.revertedWithCustomError(
            CO,
            "OnlyOracleManager",
          );
        }
      }
    });

    it("setConsensusEngine takes only an engine built for this manager", async function () {
      const other = await (
        await ethers.getContractFactory("OracleManager")
      ).deploy();
      const foreign = await (
        await ethers.getContractFactory("ConsensusOracle")
      ).deploy(await other.getAddress());
      for (const bad of [stranger.address, await foreign.getAddress()]) {
        await expect(OM.setConsensusEngine(bad)).to.be.revertedWithCustomError(
          OM,
          "InvalidConsensusEngine",
        );
      }
      await expect(
        OM.connect(stranger).setConsensusEngine(await CO.getAddress()),
      ).to.be.revertedWithCustomError(OM, "OwnableUnauthorizedAccount");
      // A manager with no engine opens nothing and validates nothing.
      await other.registerOracle(n1.address, "node", "", 500);
      await expect(
        other.submitQuery(subject.address, WHITELIST, TIER3),
      ).to.be.revertedWithCustomError(other, "NoConsensusEngine");
      expect(await other.getConsensusThreshold()).to.equal(0);
      const h = ethers.id("m");
      expect(
        await other.validateOracleConsensus(
          [n1.address],
          [await n1.signMessage(ethers.getBytes(h))],
          h,
        ),
      ).to.equal(false);
    });
  });
});
