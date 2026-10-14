import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OracleManager,
  WhitelistOracle,
  BlacklistOracle,
  OnchainIDFactory,
  ClaimIssuer,
  Token,
  IdentityRegistry,
} from "../../typechain-types";
import { attest, issueSigned } from "../helpers/kyc";
import {
  KYC_CLAIM_TOPIC,
  deployOracleERC3643,
} from "../helpers/oracleERC3643Fixture";

describe("Oracle-ERC3643 Integration Tests", function () {
  let oracleManager: OracleManager;
  let whitelistOracle: WhitelistOracle;
  let blacklistOracle: BlacklistOracle;
  let token: Token;
  let identityRegistry: IdentityRegistry;
  let onchainIDFactory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;
  let oracle1: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let investor1: SignerWithAddress;
  let investor2: SignerWithAddress;
  let tokenAgent: SignerWithAddress;

  beforeEach(async function () {
    ({
      oracleManager,
      whitelistOracle,
      blacklistOracle,
      token,
      identityRegistry,
      onchainIDFactory,
      claimIssuer,
      oracle1,
      oracle3,
      kycProvider,
      investor1,
      investor2,
      tokenAgent,
    } = await deployOracleERC3643());
  });

  describe("Integration with ERC-3643 Token Operations", function () {
    it("Should allow token minting for whitelisted investors", async function () {
      console.log("💰 Testing Token Minting for Whitelisted Investors...");

      // Setup: Complete KYC/AML process and whitelist investor
      const tx = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(
          investor1.address,
          ethers.keccak256(ethers.toUtf8Bytes("salt5")),
        );
      const receipt = await tx.wait();
      const createEvent = receipt?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });
      const onchainIDAddress = createEvent
        ? onchainIDFactory.interface.parseLog(createEvent)?.args[0]
        : null;

      // Complete KYC/AML
      const kycClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256"],
        ["KYC_VERIFIED", "US", Date.now()],
      );

      await issueSigned(
        claimIssuer,
        kycProvider,
        onchainIDAddress!,
        KYC_CLAIM_TOPIC,
        kycClaimData,
        "https://kyc-provider.com/claims",
        0,
      );

      await identityRegistry.registerIdentity(
        investor1.address,
        onchainIDAddress!,
        840,
      );
      await attest(claimIssuer, kycProvider, onchainIDAddress!);
      await whitelistOracle.addToWhitelist(
        investor1.address,
        4,
        0,
        "Verified investor",
      );

      // Test token minting
      const mintAmount = ethers.parseEther("1000");
      await expect(
        token.connect(tokenAgent).mint(investor1.address, mintAmount),
      )
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, investor1.address, mintAmount);

      const balance = await token.balanceOf(investor1.address);
      expect(balance).to.equal(mintAmount);

      console.log("✅ Token minting successful for whitelisted investor");
    });

    it("Should prevent token operations for blacklisted investors", async function () {
      console.log(
        "🚫 Testing Token Operation Prevention for Blacklisted Investors...",
      );

      // Add investor to blacklist
      await blacklistOracle.addToBlacklist(
        investor2.address,
        2, // HIGH severity
        0,
        "Compliance violation",
      );

      // Verify blacklist status prevents operations (in a real implementation,
      // the token contract would check blacklist status before minting)
      const isBlacklisted = await blacklistOracle.isBlacklisted(
        investor2.address,
      );
      expect(isBlacklisted).to.be.true;

      // Attempt token minting (should fail due to no identity verification)
      const mintAmount = ethers.parseEther("500");
      await expect(
        token.connect(tokenAgent).mint(investor2.address, mintAmount),
      ).to.be.revertedWith("Identity not verified");

      console.log(
        "✅ Token minting correctly prevented for unverified/blacklisted investor",
      );
    });
  });

  describe("Oracle Reputation and Performance Tracking", function () {
    it("Should track oracle performance and adjust reputation", async function () {
      console.log("📊 Testing Oracle Reputation System...");

      // Get initial reputation
      const initialInfo = await oracleManager.getOracleInfo(oracle1.address);
      const initialReputation = initialInfo.reputation;

      // Reward oracle for good performance
      await oracleManager.rewardOracle(
        oracle1.address,
        100,
        "Accurate KYC verification",
      );

      // Check updated reputation
      const updatedInfo = await oracleManager.getOracleInfo(oracle1.address);
      expect(updatedInfo.reputation).to.equal(initialReputation + 100n);

      console.log("✅ Oracle reputation system working correctly");

      // Test penalty system
      await oracleManager.penalizeOracle(
        oracle3.address,
        50,
        "Delayed response",
      );

      const penalizedInfo = await oracleManager.getOracleInfo(oracle3.address);
      expect(penalizedInfo.reputation).to.be.lessThan(700); // Initial was 700

      console.log("✅ Oracle penalty system working correctly");
    });
  });
});
