import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { bindEngine } from "../helpers/oracles";

// Task 4.15 (C §2 OracleManager and ConsensusOracle rows; C §3 N45,
// N46). Every per-oracle call is onlyRegistered; the register cap, the
// weight, expiry and reputation bounds hold through the manager; the
// reputation writes are the owner's.
describe("OracleManager guards (Task 4.15)", function () {
  let owner: SignerWithAddress, stranger: SignerWithAddress;
  let n1: SignerWithAddress, n2: SignerWithAddress;
  let OM: any, CO: any;
  const NOT_REG = "OracleManager: Oracle not registered";

  beforeEach(async function () {
    [owner, stranger, n1, n2] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    CO = await bindEngine(OM);
    await OM.registerOracle(n1.address, "n1", "", 500);
    await OM.registerOracle(n2.address, "n2", "", 500);
  });

  it("registerOracle: a real address, once, with a reputation in range, under MAX_ORACLES (N45)", async function () {
    await expect(
      OM.registerOracle(ethers.ZeroAddress, "z", "", 500),
    ).to.be.revertedWith("OracleManager: Invalid oracle address");
    await expect(
      OM.registerOracle(n1.address, "again", "", 500),
    ).to.be.revertedWith("OracleManager: Oracle already registered");
    await expect(
      OM.registerOracle(stranger.address, "s", "", 1001),
    ).to.be.revertedWith("OracleManager: Invalid reputation");
    const max = Number(await OM.MAX_ORACLES());
    for (let i = 2; i < max; i++)
      await OM.registerOracle(
        ethers.Wallet.createRandom().address,
        `n${i}`,
        "",
        500,
      );
    expect(await OM.getRegisteredOracles()).to.have.lengthOf(max);
    await expect(
      OM.registerOracle(stranger.address, "one too many", "", 500),
    ).to.be.revertedWith("OracleManager: Max oracles reached");
  });

  it("every per-oracle call refuses an unregistered oracle", async function () {
    const q = ethers.id("query");
    for (const call of [
      async () => OM.removeOracle(stranger.address, "r"),
      async () => OM.pauseOracle(stranger.address),
      async () => OM.unpauseOracle(stranger.address),
      async () => OM.setEmergencyOracle(stranger.address, true),
      async () => OM.setOracleWeight(stranger.address, 1),
      async () =>
        OM.batchSetOracleWeights([n1.address, stranger.address], [1, 1]),
      async () => OM.emergencyOverride(stranger.address, q, true, "r"),
      async () => OM.updateOracleReputation(stranger.address, 500),
      async () => OM.penalizeOracle(stranger.address, 1, "r"),
      async () => OM.rewardOracle(stranger.address, 1, "r"),
    ])
      await expect(call()).to.be.revertedWith(NOT_REG);
  });

  it("the reputation writes are the owner's and bounded (382/391/409)", async function () {
    const s = OM.connect(stranger);
    for (const call of [
      async () => s.updateOracleReputation(n1.address, 600),
      async () => s.penalizeOracle(n1.address, 1, "r"),
      async () => s.rewardOracle(n1.address, 1, "r"),
      async () => s.setOracleWeight(n1.address, 1),
      async () => s.batchSetOracleWeights([n1.address], [1]),
      async () => s.setQueryExpiryTime(3600),
      async () => s.setConsensusThreshold(60),
    ])
      await expect(call())
        .to.be.revertedWithCustomError(OM, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    await expect(
      OM.updateOracleReputation(n1.address, 1001),
    ).to.be.revertedWith("OracleManager: Invalid reputation");
    await expect(OM.updateOracleReputation(n1.address, 1000))
      .to.emit(OM, "OracleReputationUpdated")
      .withArgs(n1.address, 1000);
    // Reward saturates at MAX_REPUTATION; a penalty below MIN parks the node.
    await OM.rewardOracle(n1.address, 5, "r");
    expect((await OM.getOracleInfo(n1.address)).reputation).to.equal(1000);
    await expect(OM.penalizeOracle(n1.address, 2000, "r"))
      .to.emit(OM, "OracleDeactivated")
      .withArgs(n1.address);
    expect(await OM.isActiveOracle(n1.address)).to.equal(false);
  });

  it("weights: zero and above MAX_ORACLE_WEIGHT refused, arrays of one length (N46)", async function () {
    await expect(OM.setOracleWeight(n1.address, 0)).to.be.revertedWith(
      "OracleManager: Invalid weight",
    );
    const max = await CO.MAX_ORACLE_WEIGHT();
    await expect(
      OM.setOracleWeight(n1.address, max + 1n),
    ).to.be.revertedWithCustomError(CO, "InvalidWeight");
    await expect(
      OM.batchSetOracleWeights([n1.address, n2.address], [1]),
    ).to.be.revertedWith("OracleManager: Array length mismatch");
    await OM.batchSetOracleWeights([n1.address, n2.address], [max, 7]);
    expect(await CO.weightOf(n1.address)).to.equal(max);
    expect(await CO.weightOf(n2.address)).to.equal(7);
  });

  it("query expiry and threshold are bounded through the manager (ConsensusOracle 185, 172)", async function () {
    const lo = await CO.MIN_EXPIRY();
    const hi = await CO.MAX_EXPIRY();
    for (const bad of [lo - 1n, hi + 1n])
      await expect(OM.setQueryExpiryTime(bad)).to.be.revertedWithCustomError(
        CO,
        "InvalidExpiry",
      );
    await OM.setQueryExpiryTime(hi);
    expect(await CO.queryExpiryTime()).to.equal(hi);
    for (const bad of [50, 101])
      await expect(OM.setConsensusThreshold(bad)).to.be.revertedWithCustomError(
        CO,
        "InvalidThreshold",
      );
    await OM.setConsensusThreshold(100);
    expect(await OM.getConsensusThreshold()).to.equal(100);
  });

  it("the engine's own setters are the manager's; its constructor needs a manager with code", async function () {
    for (const call of [
      async () => CO.setOracleWeight(n1.address, 1),
      async () => CO.setQueryExpiryTime(3600),
      async () => CO.setConsensusThreshold(60),
      async () => CO.openQuery(ethers.id("q")),
      async () => CO.recordVote(ethers.id("q"), n1.address, true),
    ])
      await expect(call()).to.be.revertedWithCustomError(
        CO,
        "OnlyOracleManager",
      );
    await expect(
      (await ethers.getContractFactory("ConsensusOracle")).deploy(
        owner.address,
      ),
    ).to.be.revertedWith("ConsensusOracle: Oracle manager is not a contract");
  });

  // Task 4.17 slice A (review C mutant O04).
  it("submitQuery takes query types 1-4 only", async function () {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [2]);
    for (const t of [0, 5])
      await expect(
        OM.connect(n1).submitQuery(stranger.address, t, data),
      ).to.be.revertedWith("OracleManager: Invalid query type");
    await expect(OM.connect(n1).submitQuery(stranger.address, 1, data)).to.emit(
      CO,
      "ConsensusQueryCreated",
    );
  });
});
