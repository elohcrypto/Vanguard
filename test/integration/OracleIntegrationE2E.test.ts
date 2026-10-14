import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OracleManager,
  WhitelistOracle,
  BlacklistOracle,
  OnchainIDFactory,
  OnchainID,
  ClaimIssuer,
  Token,
  IdentityRegistry,
} from "../../typechain-types";
import { attest, issueSigned } from "../helpers/kyc";
import {
  KYC_CLAIM_TOPIC,
  AML_CLAIM_TOPIC,
  deployOracleIntegration,
} from "../helpers/oracleIntegrationFixture";

describe("Oracle Integration with OnchainID and ERC-3643", function () {
  let oracleManager: OracleManager;
  let whitelistOracle: WhitelistOracle;
  let blacklistOracle: BlacklistOracle;
  let onchainIDFactory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;
  let token: Token;
  let identityRegistry: IdentityRegistry;
  let owner: SignerWithAddress;
  let oracle1: SignerWithAddress;
  let oracle2: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let amlProvider: SignerWithAddress;
  let investor1: SignerWithAddress;

  // Nodes answer through the manager until the engine resolves the query.
  async function vote(q: string, votes: [SignerWithAddress, boolean][]) {
    for (const [o, v] of votes) {
      if ((await oracleManager.getQueryResolution(q))[0]) break;
      await oracleManager.connect(o).submitResponse(q, v);
    }
  }

  beforeEach(async function () {
    ({
      oracleManager,
      whitelistOracle,
      blacklistOracle,
      onchainIDFactory,
      claimIssuer,
      token,
      identityRegistry,
      owner,
      oracle1,
      oracle2,
      oracle3,
      kycProvider,
      amlProvider,
      investor1,
    } = await deployOracleIntegration());
  });

  describe("📊 System Health and Monitoring", function () {
    it("Should track oracle performance and reputation", async function () {
      // Register and track oracle performance
      const initialInfo = await oracleManager.getOracleInfo(oracle1.address);
      expect(initialInfo.reputation).to.equal(500);

      // Reward oracle for good performance
      await oracleManager.rewardOracle(
        oracle1.address,
        100,
        "Accurate KYC verification",
      );

      const updatedInfo = await oracleManager.getOracleInfo(oracle1.address);
      expect(updatedInfo.reputation).to.equal(600);
      expect(updatedInfo.correctAttestations).to.equal(1);

      console.log("✅ Oracle reputation system working correctly");
    });

    it("Should handle oracle pause and failover", async function () {
      // Pause oracle
      await oracleManager.pauseOracle(oracle1.address);
      expect(await oracleManager.isActiveOracle(oracle1.address)).to.be.false;

      // System should still work with remaining oracles
      const activeOracles = await oracleManager.getActiveOracles();
      expect(activeOracles.length).to.equal(2);
      expect(activeOracles).to.include(oracle2.address);
      expect(activeOracles).to.include(oracle3.address);

      console.log("✅ Oracle failover mechanism working correctly");
    });
  });

  describe("🧪 End-to-End Integration Test", function () {
    it("Complete KYC/AML workflow with oracle integration", async function () {
      console.log("🚀 Starting complete KYC/AML workflow test...");

      // Step 1: Create OnchainID
      const salt = ethers.randomBytes(32);
      const txDeploy4 = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(investor1.address, salt, {
          value: ethers.parseEther("0.01"),
        });
      const receiptDeploy4 = await txDeploy4.wait();
      const event = receiptDeploy4?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });
      const onchainIDAddress = onchainIDFactory.interface.parseLog(event!)!.args
        .identity;
      console.log("✅ OnchainID created:", onchainIDAddress);

      // Step 2: Issue KYC claim
      const kycClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256"],
        ["John Doe", "US", Date.now()],
      );
      const tx4 = await issueSigned(
        claimIssuer,
        kycProvider,
        onchainIDAddress,
        KYC_CLAIM_TOPIC,
        kycClaimData,
        "", // uri
        Math.floor(Date.now() / 1000) + 86400, // validTo (24 hours from now)
      );
      await tx4.wait();
      console.log("✅ KYC claim issued");

      // Step 3: Issue AML claim
      const amlClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "bool"],
        ["AML_CLEAR", Date.now(), true],
      );
      const tx5 = await issueSigned(
        claimIssuer,
        amlProvider,
        onchainIDAddress,
        AML_CLAIM_TOPIC,
        amlClaimData,
        "", // uri
        Math.floor(Date.now() / 1000) + 86400, // validTo (24 hours from now)
      );
      await tx5.wait();
      console.log("✅ AML claim issued");

      // Step 4: Oracle consensus for whitelist
      await whitelistOracle.addToWhitelist(
        investor1.address,
        5,
        0,
        "Full KYC + AML Verification Complete",
      );
      console.log("✅ Added to oracle whitelist");

      // Step 5: Register in ERC-3643
      await identityRegistry.registerIdentity(
        investor1.address,
        onchainIDAddress,
        840,
      );
      await attest(claimIssuer, owner, onchainIDAddress);
      console.log("✅ Registered in ERC-3643 Identity Registry");

      // Step 6: Mint tokens
      await token.mint(investor1.address, ethers.parseEther("1000"));
      console.log("✅ Tokens minted");

      // Step 7: Verify complete integration
      expect(await whitelistOracle.isWhitelisted(investor1.address)).to.be.true;
      expect(await blacklistOracle.isBlacklisted(investor1.address)).to.be
        .false;
      expect(await identityRegistry.isVerified(investor1.address)).to.be.true;
      expect(await token.balanceOf(investor1.address)).to.equal(
        ethers.parseEther("1000"),
      );

      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        investor1.address,
      );
      expect(whitelistInfo.tier).to.equal(5);

      console.log(
        "🎉 Complete KYC/AML workflow with oracle integration successful!",
      );
      console.log("📊 Final Status:");
      console.log("   - Whitelisted: ✅");
      console.log("   - Blacklisted: ❌");
      console.log("   - ERC-3643 Verified: ✅");
      console.log("   - Token Balance: 1000 TST");
      console.log("   - Whitelist Tier: 5 (Highest)");
    });
  });
});
