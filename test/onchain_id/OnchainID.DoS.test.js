const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OnchainID - DoS Protection Tests", function () {
  let onchainID;
  let owner, user1, issuer;
  let managementKey;

  beforeEach(async function () {
    [owner, user1, issuer] = await ethers.getSigners();

    // Deploy OnchainID with owner address
    const OnchainID = await ethers.getContractFactory("OnchainID");
    onchainID = await OnchainID.deploy(owner.address);
    await onchainID.waitForDeployment();

    // Management key is automatically added in constructor
    managementKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [owner.address]),
    );
  });

  describe("Batch Add Claims - DoS Protection", function () {
    it("should reject empty arrays", async function () {
      await expect(
        onchainID.batchAddClaims([], [], [], [], [], []),
      ).to.be.revertedWith("OnchainID: Empty array");
    });

    it("should reject batch size exceeding MAX_BATCH_SIZE (50)", async function () {
      // Create arrays with 51 elements (exceeds limit)
      const oversizedBatch = 51;
      const topics = new Array(oversizedBatch).fill(1);
      const schemes = new Array(oversizedBatch).fill(1);
      const issuers = new Array(oversizedBatch).fill(issuer.address);
      const signatures = new Array(oversizedBatch).fill("0x" + "00".repeat(65));
      const data = new Array(oversizedBatch).fill("0x1234");
      const uris = new Array(oversizedBatch).fill("https://example.com");

      await expect(
        onchainID.batchAddClaims(
          topics,
          schemes,
          issuers,
          signatures,
          data,
          uris,
        ),
      ).to.be.revertedWith("OnchainID: Batch size exceeds maximum");
    });

    it("should accept batch size at MAX_BATCH_SIZE (50)", async function () {
      // Create arrays with exactly 50 elements (at limit)
      const maxBatchSize = 50;
      const topics = new Array(maxBatchSize).fill(1);
      const schemes = new Array(maxBatchSize).fill(1);
      const issuers = new Array(maxBatchSize).fill(issuer.address);
      // Distinct data: one id per entry (an owner cannot overwrite an
      // existing claim named for another issuer, 2F.2 review N2). Empty
      // signature and uri: 50 distinct claims carrying a 65-byte signature
      // and a uri do not fit the 12M test block.
      const signatures = new Array(maxBatchSize).fill("0x");
      const data = Array.from({ length: maxBatchSize }, (_, i) =>
        ethers.toBeHex(i + 1, 4),
      );
      const uris = new Array(maxBatchSize).fill("");

      // Should not revert
      await expect(
        onchainID.batchAddClaims(
          topics,
          schemes,
          issuers,
          signatures,
          data,
          uris,
        ),
      ).to.not.be.reverted;
    });

    it("should accept small batch sizes", async function () {
      const topics = [1, 2, 3];
      const schemes = [1, 1, 1];
      const issuers = [issuer.address, issuer.address, issuer.address];
      const signatures = [
        "0x" + "00".repeat(65),
        "0x" + "00".repeat(65),
        "0x" + "00".repeat(65),
      ];
      const data = ["0x1234", "0x5678", "0x9abc"];
      const uris = [
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
      ];

      await expect(
        onchainID.batchAddClaims(
          topics,
          schemes,
          issuers,
          signatures,
          data,
          uris,
        ),
      ).to.not.be.reverted;
    });

    it("should reject mismatched array lengths", async function () {
      const topics = [1, 2];
      const schemes = [1]; // Mismatched length
      const issuers = [issuer.address, issuer.address];
      const signatures = ["0x" + "00".repeat(65), "0x" + "00".repeat(65)];
      const data = ["0x1234", "0x5678"];
      const uris = ["https://example.com/1", "https://example.com/2"];

      await expect(
        onchainID.batchAddClaims(
          topics,
          schemes,
          issuers,
          signatures,
          data,
          uris,
        ),
      ).to.be.revertedWith("OnchainID: Array length mismatch");
    });
  });

  describe("Gas Cost Analysis", function () {
    it("should measure gas cost for different batch sizes", async function () {
      const batchSizes = [1, 10, 25, 50];

      console.log("\n📊 Gas Cost Analysis:");
      console.log("=".repeat(50));

      for (const size of batchSizes) {
        const topics = new Array(size).fill(1);
        const schemes = new Array(size).fill(1);
        const issuers = new Array(size).fill(issuer.address);
        const signatures = new Array(size).fill("0x");
        const data = Array.from({ length: size }, (_, i) =>
          ethers.toBeHex(size * 1000 + i + 1, 4),
        );
        const uris = new Array(size).fill("");

        const tx = await onchainID.batchAddClaims(
          topics,
          schemes,
          issuers,
          signatures,
          data,
          uris,
        );
        const receipt = await tx.wait();

        console.log(
          `Batch size ${size.toString().padStart(2)}: ${receipt.gasUsed.toString().padStart(10)} gas`,
        );
      }
      console.log("=".repeat(50));
    });
  });

  describe("Constants Verification", function () {
    it("should have correct MAX_BATCH_SIZE constant", async function () {
      const maxBatchSize = await onchainID.MAX_BATCH_SIZE();
      expect(maxBatchSize).to.equal(50);
    });
  });

  describe("Security Scenarios", function () {
    it("should prevent DoS attack with massive batch", async function () {
      // Attacker tries to submit 1000 claims at once
      const maliciousBatchSize = 1000;
      const topics = new Array(maliciousBatchSize).fill(1);
      const schemes = new Array(maliciousBatchSize).fill(1);
      const issuers = new Array(maliciousBatchSize).fill(issuer.address);
      const signatures = new Array(maliciousBatchSize).fill(
        "0x" + "00".repeat(65),
      );
      const data = new Array(maliciousBatchSize).fill("0x1234");
      const uris = new Array(maliciousBatchSize).fill("https://example.com");

      // Should be rejected before consuming gas
      await expect(
        onchainID.batchAddClaims(
          topics,
          schemes,
          issuers,
          signatures,
          data,
          uris,
        ),
      ).to.be.revertedWith("OnchainID: Batch size exceeds maximum");
    });

    it("should allow legitimate batch operations", async function () {
      // Legitimate user adds 10 claims
      const legitimateBatchSize = 10;
      const topics = new Array(legitimateBatchSize).fill(1);
      const schemes = new Array(legitimateBatchSize).fill(1);
      const issuers = new Array(legitimateBatchSize).fill(issuer.address);
      const signatures = new Array(legitimateBatchSize).fill(
        "0x" + "00".repeat(65),
      );
      const data = Array.from({ length: legitimateBatchSize }, (_, i) =>
        ethers.toBeHex(i + 1, 4),
      );
      const uris = new Array(legitimateBatchSize).fill("https://example.com");

      // Should succeed
      const tx = await onchainID.batchAddClaims(
        topics,
        schemes,
        issuers,
        signatures,
        data,
        uris,
      );
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);
      console.log(
        `\n✅ Legitimate batch (${legitimateBatchSize} claims): ${receipt.gasUsed} gas`,
      );
    });
  });
});
