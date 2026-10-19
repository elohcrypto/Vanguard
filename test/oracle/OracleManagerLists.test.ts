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

  describe("WhitelistOracle", function () {
    beforeEach(async function () {
      // Register oracles in the manager
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

    it("Should add addresses to whitelist", async function () {
      await expect(
        whitelistOracle.addToWhitelist(
          subject.address,
          3,
          0,
          "Test whitelist addition",
        ),
      )
        .to.emit(whitelistOracle, "WhitelistUpdated")
        .withArgs(
          subject.address,
          true,
          3,
          anyValue,
          "Test whitelist addition",
        );

      expect(await whitelistOracle.isWhitelisted(subject.address)).to.be.true;
    });

    it("Should remove addresses from whitelist", async function () {
      await whitelistOracle.addToWhitelist(
        subject.address,
        3,
        0,
        "Test addition",
      );

      await expect(
        whitelistOracle.removeFromWhitelist(subject.address, "Test removal"),
      )
        .to.emit(whitelistOracle, "WhitelistUpdated")
        .withArgs(subject.address, false, 0, 0, "Test removal");

      expect(await whitelistOracle.isWhitelisted(subject.address)).to.be.false;
    });

    it("Should handle batch whitelist operations", async function () {
      const addresses = [subject.address, user.address];
      const tiers = [3, 4];

      await whitelistOracle.batchAddToWhitelist(
        addresses,
        tiers,
        0,
        "Batch test",
      );

      expect(await whitelistOracle.isWhitelisted(subject.address)).to.be.true;
      expect(await whitelistOracle.isWhitelisted(user.address)).to.be.true;
    });

    it("Should provide whitelist information", async function () {
      await whitelistOracle.addToWhitelist(
        subject.address,
        4,
        86400,
        "Test with expiry",
      );

      const info = await whitelistOracle.getWhitelistInfo(subject.address);
      expect(info.isWhitelistedStatus).to.be.true;
      expect(info.tier).to.equal(4);
      expect(info.reason).to.equal("Test with expiry");
    });

    // Task 5.17 (deep review, vacuous tests): this test asserted only that
    // the function exists. It now drives a whitelist query to consensus
    // and checks the signed attestation applies it, and that a signature
    // that is not the sender's is refused.
    it("Should handle oracle attestations", async function () {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const tier = coder.encode(["uint8"], [4]);
      const tx = await oracleManager.submitQuery(subject.address, 1, tier);
      const block = await ethers.provider.getBlock(
        (await tx.wait())!.blockNumber,
      );
      const queryId = ethers.solidityPackedKeccak256(
        ["address", "uint8", "bytes", "uint256", "address"],
        [subject.address, 1, tier, block!.timestamp, owner.address],
      );
      // Two of the three agreeing resolve it at the default threshold.
      for (const o of [oracle1, oracle2]) {
        await oracleManager.connect(o).submitResponse(queryId, true);
      }
      const [resolved, verdict] =
        await oracleManager.getQueryResolution(queryId);
      expect([resolved, verdict]).to.deep.equal([true, true]);
      const { chainId } = await ethers.provider.getNetwork();
      const digest = ethers.getBytes(
        ethers.solidityPackedKeccak256(
          ["address", "bytes32", "bool", "uint256"],
          [subject.address, queryId, true, chainId],
        ),
      );
      const data = coder.encode(["string"], ["test data"]);

      // Signed by another oracle than the sender: not this attestation.
      await expect(
        whitelistOracle
          .connect(oracle1)
          .provideAttestation(
            subject.address,
            queryId,
            true,
            await oracle2.signMessage(digest),
            data,
          ),
      ).to.be.revertedWith("WhitelistOracle: Invalid signature");
      expect(await whitelistOracle.isWhitelisted(subject.address)).to.be.false;

      const signature = await oracle1.signMessage(digest);
      await expect(
        whitelistOracle
          .connect(oracle1)
          .provideAttestation(subject.address, queryId, true, signature, data),
      )
        .to.emit(whitelistOracle, "AttestationProvided")
        .withArgs(
          oracle1.address,
          subject.address,
          queryId,
          true,
          anyValue,
          signature,
        );
      expect(await whitelistOracle.isWhitelisted(subject.address)).to.be.true;
      expect(
        (await whitelistOracle.getWhitelistInfo(subject.address)).tier,
      ).to.equal(4);
      const [result, , attester, stored, isValid] =
        await whitelistOracle.getAttestation(subject.address, queryId);
      expect([result, attester, stored, isValid]).to.deep.equal([
        true,
        oracle1.address,
        signature,
        true,
      ]);
    });
  });

  describe("BlacklistOracle", function () {
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

    it("Should add addresses to blacklist", async function () {
      await expect(
        blacklistOracle.addToBlacklist(
          subject.address,
          1,
          0,
          "Test blacklist addition",
        ), // SeverityLevel.MEDIUM = 1
      ).to.emit(blacklistOracle, "BlacklistUpdated");

      expect(await blacklistOracle.isBlacklisted(subject.address)).to.be.true;
    });

    it("Should handle emergency blacklisting", async function () {
      await oracleManager.setEmergencyOracle(oracle1.address, true);

      await expect(
        blacklistOracle.connect(oracle1).emergencyBlacklist(
          subject.address,
          3, // SeverityLevel.CRITICAL = 3
          "Critical security threat",
        ),
      )
        .to.emit(blacklistOracle, "EmergencyBlacklistAdded")
        .withArgs(
          subject.address,
          oracle1.address,
          3,
          "Critical security threat",
        );

      expect(await blacklistOracle.isBlacklisted(subject.address)).to.be.true;
    });

    it("Should remove addresses from blacklist", async function () {
      await blacklistOracle.addToBlacklist(
        subject.address,
        1,
        0,
        "Test addition",
      );

      await expect(
        blacklistOracle.removeFromBlacklist(subject.address, "Test removal"),
      ).to.emit(blacklistOracle, "BlacklistUpdated");

      expect(await blacklistOracle.isBlacklisted(subject.address)).to.be.false;
    });

    it("Should handle batch blacklist operations", async function () {
      const addresses = [subject.address, user.address];
      const severities = [1, 2]; // MEDIUM, HIGH

      await blacklistOracle.batchAddToBlacklist(
        addresses,
        severities,
        0,
        "Batch test",
      );

      expect(await blacklistOracle.isBlacklisted(subject.address)).to.be.true;
      expect(await blacklistOracle.isBlacklisted(user.address)).to.be.true;
    });

    it("Should provide blacklist information", async function () {
      await blacklistOracle.addToBlacklist(
        subject.address,
        2,
        86400,
        "Test with expiry",
      ); // HIGH severity

      const info = await blacklistOracle.getBlacklistInfo(subject.address);
      expect(info.isBlacklistedStatus).to.be.true;
      expect(info.severity).to.equal(2);
      expect(info.reason).to.equal("Test with expiry");
    });

    it("Should set emergency oracle status (the manager's, Task 4.4)", async function () {
      await expect(oracleManager.setEmergencyOracle(oracle1.address, true))
        .to.emit(oracleManager, "EmergencyOracleSet")
        .withArgs(oracle1.address, true);
    });
  });
});

// Helper function for testing
const anyValue = (value: any) => true;
