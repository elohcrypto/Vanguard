import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OracleManager,
  WhitelistOracle,
  BlacklistOracle,
  ConsensusOracle,
} from "../../typechain-types";

describe("Oracle Management System", function () {
  let oracleManager: OracleManager;
  let whitelistOracle: WhitelistOracle;
  let blacklistOracle: BlacklistOracle;
  let consensusOracle: ConsensusOracle;

  let owner: SignerWithAddress;
  let oracle1: SignerWithAddress;
  let oracle2: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let user: SignerWithAddress;
  let subject: SignerWithAddress;

  beforeEach(async function () {
    [owner, oracle1, oracle2, oracle3, user, subject] =
      await ethers.getSigners();

    // Deploy OracleManager
    const OracleManagerFactory =
      await ethers.getContractFactory("OracleManager");
    oracleManager = await OracleManagerFactory.deploy();
    await oracleManager.waitForDeployment();

    // Deploy WhitelistOracle
    const WhitelistOracleFactory =
      await ethers.getContractFactory("WhitelistOracle");
    whitelistOracle = await WhitelistOracleFactory.deploy(
      await oracleManager.getAddress(),
      "Whitelist Oracle",
      "Oracle for managing whitelist consensus",
    );
    await whitelistOracle.waitForDeployment();

    // Deploy BlacklistOracle
    const BlacklistOracleFactory =
      await ethers.getContractFactory("BlacklistOracle");
    blacklistOracle = await BlacklistOracleFactory.deploy(
      await oracleManager.getAddress(),
      "Blacklist Oracle",
      "Oracle for managing blacklist consensus",
    );
    await blacklistOracle.waitForDeployment();

    // Deploy ConsensusOracle
    const ConsensusOracleFactory =
      await ethers.getContractFactory("ConsensusOracle");
    // Task 4.4: the engine is bound to the manager, the manager to it.
    consensusOracle = await ConsensusOracleFactory.deploy(
      await oracleManager.getAddress(),
    );
    await consensusOracle.waitForDeployment();
    await oracleManager.setConsensusEngine(await consensusOracle.getAddress());
  });

  describe("OracleManager", function () {
    it("Should register oracles correctly", async function () {
      await expect(
        oracleManager.registerOracle(
          oracle1.address,
          "Oracle 1",
          "First test oracle",
          500,
        ),
      )
        .to.emit(oracleManager, "OracleRegistered")
        .withArgs(oracle1.address, "Oracle 1");

      expect(await oracleManager.isRegisteredOracle(oracle1.address)).to.be
        .true;
      expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.true;
    });

    it("Should not allow duplicate oracle registration", async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );

      await expect(
        oracleManager.registerOracle(
          oracle1.address,
          "Oracle 1 Duplicate",
          "Duplicate oracle",
          500,
        ),
      ).to.be.revertedWith("OracleManager: Oracle already registered");
    });

    it("Should remove oracles correctly", async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );

      await expect(
        oracleManager.removeOracle(oracle1.address, "Test deregistration"),
      )
        .to.emit(oracleManager, "OracleDeregistered")
        .withArgs(oracle1.address, "Test deregistration");

      expect(await oracleManager.isRegisteredOracle(oracle1.address)).to.be
        .false;
      expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.false;
    });

    it("Should pause and unpause oracles", async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );

      await expect(oracleManager.pauseOracle(oracle1.address))
        .to.emit(oracleManager, "OracleDeactivated")
        .withArgs(oracle1.address);

      expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.false;

      await expect(oracleManager.unpauseOracle(oracle1.address))
        .to.emit(oracleManager, "OracleActivated")
        .withArgs(oracle1.address);

      expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.true;
    });

    it("Should set consensus threshold correctly", async function () {
      // Register enough oracles to support the threshold
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );
      await oracleManager.registerOracle(
        oracle2.address,
        "Oracle 2",
        "Second test oracle",
        500,
      );
      await oracleManager.registerOracle(
        oracle3.address,
        "Oracle 3",
        "Third test oracle",
        500,
      );
      await oracleManager.registerOracle(
        user.address,
        "Oracle 4",
        "Fourth test oracle",
        500,
      );
      await oracleManager.registerOracle(
        subject.address,
        "Oracle 5",
        "Fifth test oracle",
        500,
      );

      // A percent of the active weight (Task 4.4): 5 of 5 nodes is 100.
      await expect(oracleManager.setConsensusThreshold(100))
        .to.emit(consensusOracle, "ConsensusThresholdUpdated")
        .withArgs(66, 100);

      expect(await oracleManager.getConsensusThreshold()).to.equal(100);
    });

    it("Should submit and track queries", async function () {
      for (const o of [oracle1, oracle2])
        await oracleManager.registerOracle(o.address, "O", "", 500); // D50
      // A whitelist query carries its tier (Task 4.12).
      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8"],
        [3],
      );

      const tx = await oracleManager.submitQuery(subject.address, 1, queryData);
      const receipt = await tx.wait();

      // Extract queryId from transaction logs or return value
      expect(receipt).to.not.be.null;
    });

    it("Should handle emergency override", async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );

      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string"],
        ["test query"],
      );

      // Test that emergency override rejects non-existent queries
      const mockQueryId = ethers.keccak256(ethers.toUtf8Bytes("mock-query"));

      await expect(
        oracleManager.emergencyOverride(
          oracle1.address,
          mockQueryId,
          true,
          "Emergency test",
        ),
      ).to.be.revertedWith("OracleManager: Query does not exist");
    });

    it("Should update oracle reputation", async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );

      await oracleManager.updateOracleReputation(oracle1.address, 750);

      const oracleInfo = await oracleManager.getOracleInfo(oracle1.address);
      expect(oracleInfo.reputation).to.equal(750);
    });

    it("Should penalize and reward oracles", async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );

      await oracleManager.penalizeOracle(oracle1.address, 100, "Test penalty");
      let oracleInfo = await oracleManager.getOracleInfo(oracle1.address);
      expect(oracleInfo.reputation).to.equal(400);

      await oracleManager.rewardOracle(oracle1.address, 200, "Test reward");
      oracleInfo = await oracleManager.getOracleInfo(oracle1.address);
      expect(oracleInfo.reputation).to.equal(600);
    });
  });

  describe("ConsensusOracle", function () {
    beforeEach(async function () {
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );
      await oracleManager.registerOracle(
        oracle2.address,
        "Oracle 2",
        "Second test oracle",
        500,
      );
      await oracleManager.registerOracle(
        oracle3.address,
        "Oracle 3",
        "Third test oracle",
        500,
      );
    });

    it("Should create consensus queries", async function () {
      // A whitelist query carries its tier (Task 4.12).
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [3]);

      await expect(oracleManager.submitQuery(subject.address, 1, data)).to.emit(
        consensusOracle,
        "ConsensusQueryCreated",
      );
    });

    it("Should set oracle weights", async function () {
      await expect(oracleManager.setOracleWeight(oracle1.address, 150))
        .to.emit(consensusOracle, "OracleWeightUpdated")
        .withArgs(oracle1.address, 0, 150);

      expect(await consensusOracle.getOracleWeight(oracle1.address)).to.equal(
        150,
      );
    });

    it("Should handle batch weight setting", async function () {
      const oracles = [oracle1.address, oracle2.address];
      const weights = [150, 200];

      await oracleManager.batchSetOracleWeights(oracles, weights);

      expect(await consensusOracle.getOracleWeight(oracle1.address)).to.equal(
        150,
      );
      expect(await consensusOracle.getOracleWeight(oracle2.address)).to.equal(
        200,
      );
    });

    it("Should set consensus threshold", async function () {
      await expect(oracleManager.setConsensusThreshold(75))
        .to.emit(consensusOracle, "ConsensusThresholdUpdated")
        .withArgs(66, 75);
    });

    it("Should handle query expiry", async function () {
      await oracleManager.setQueryExpiryTime(3600); // 1 hour
      expect(await consensusOracle.queryExpiryTime()).to.equal(3600);
    });

    it("Should be bound to this manager only", async function () {
      expect(await consensusOracle.oracleManager()).to.equal(
        await oracleManager.getAddress(),
      );
      expect(await oracleManager.consensusEngine()).to.equal(
        await consensusOracle.getAddress(),
      );
    });
  });

  describe("Integration Tests", function () {
    beforeEach(async function () {
      // Register oracles
      await oracleManager.registerOracle(
        oracle1.address,
        "Oracle 1",
        "First test oracle",
        500,
      );
      await oracleManager.registerOracle(
        oracle2.address,
        "Oracle 2",
        "Second test oracle",
        500,
      );
      await oracleManager.registerOracle(
        oracle3.address,
        "Oracle 3",
        "Third test oracle",
        500,
      );
    });

    it("Should handle complete whitelist consensus workflow", async function () {
      for (const o of [oracle1, oracle2, oracle3]) {
        await oracleManager.setOracleWeight(o.address, 100);
      }
      // A whitelist query carries its tier (Task 4.12).
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [3]);
      const rc = await (
        await oracleManager.submitQuery(subject.address, 1, data)
      ).wait();
      const q = rc!.logs
        .map((l: any) => consensusOracle.interface.parseLog(l))
        .find((e: any) => e?.name === "ConsensusQueryCreated")!.args[0];
      await oracleManager.connect(oracle1).submitResponse(q, true);
      await expect(oracleManager.connect(oracle2).submitResponse(q, true))
        .to.emit(consensusOracle, "ConsensusReached")
        .withArgs(q, true, 200, 0, 300, anyValue);
      const [has, res] = await oracleManager.getQueryResolution(q);
      expect([has, res]).to.deep.equal([true, true]);
    });

    it("Should handle oracle reputation updates across contracts", async function () {
      // Register oracle first (use subject to avoid conflicts with other tests)
      await oracleManager.registerOracle(
        subject.address,
        "Oracle Subject",
        "Subject test oracle",
        500,
      );

      // Update reputation in manager
      await oracleManager.updateOracleReputation(subject.address, 750);

      // Reputation lives in the manager only (Task 4.4).
      expect(await oracleManager.getOracleReputation(subject.address)).to.equal(
        750,
      );
    });

    it("Should handle emergency scenarios", async function () {
      // Set emergency oracle (the manager's designation)
      await oracleManager.setEmergencyOracle(oracle1.address, true);

      // Emergency blacklist
      await blacklistOracle.connect(oracle1).emergencyBlacklist(
        subject.address,
        3, // CRITICAL
        "Emergency test",
      );

      expect(await blacklistOracle.isBlacklisted(subject.address)).to.be.true;

      // Emergency pause
      await blacklistOracle.emergencyPause();
      expect(await blacklistOracle.isActive()).to.be.false;
    });
  });
});

// Helper function for testing
const anyValue = (value: any) => true;
