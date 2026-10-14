import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OracleManager,
  WhitelistOracle,
  BlacklistOracle,
  ConsensusOracle,
  OnchainIDFactory,
  OnchainID,
  ClaimIssuer,
  Token,
  IdentityRegistry,
  ComplianceRegistry,
} from "../../typechain-types";
import { attest } from "../helpers/kyc";
import { deployOracleIntegration } from "../helpers/oracleIntegrationFixture";

describe("Oracle Integration with OnchainID and ERC-3643", function () {
  let oracleManager: OracleManager;
  let whitelistOracle: WhitelistOracle;
  let blacklistOracle: BlacklistOracle;
  let consensusOracle: ConsensusOracle;
  let onchainIDFactory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;
  let token: Token;
  let identityRegistry: IdentityRegistry;
  let owner: SignerWithAddress;
  let oracle1: SignerWithAddress;
  let oracle2: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let investor1: SignerWithAddress;
  let investor2: SignerWithAddress;

  // Raise a query through the manager; its id from the engine's event.
  async function raise(subject: string, type: number, data: string) {
    const rc = await (
      await oracleManager.submitQuery(subject, type, data)
    ).wait();
    return rc!.logs
      .map((l: any) => consensusOracle.interface.parseLog(l))
      .find((e: any) => e?.name === "ConsensusQueryCreated")!.args[0];
  }

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
      consensusOracle,
      onchainIDFactory,
      claimIssuer,
      token,
      identityRegistry,
      owner,
      oracle1,
      oracle2,
      oracle3,
      investor1,
      investor2,
    } = await deployOracleIntegration());
  });

  describe("🔄 Token Transfer Integration with Oracle Status", function () {
    let investor1OnchainID: string;
    let investor2OnchainID: string;
    // The outer `token` is bound to ComplianceRegistry, a permissive test
    // double that allows every transfer. These tests need real enforcement,
    // so they run against their own token bound to ComplianceRules.
    let complianceRules: any;
    let gatedToken: any;

    beforeEach(async function () {
      // Setup two investors with OnchainIDs
      const salt1 = ethers.randomBytes(32);
      const tx1 = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(investor1.address, salt1, {
          value: ethers.parseEther("0.01"),
        });
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });
      investor1OnchainID = onchainIDFactory.interface.parseLog(event1!)!.args
        .identity;

      const salt2 = ethers.randomBytes(32);
      const tx2 = await onchainIDFactory
        .connect(investor2)
        .deployOnchainID(investor2.address, salt2, {
          value: ethers.parseEther("0.01"),
        });
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });
      investor2OnchainID = onchainIDFactory.interface.parseLog(event2!)!.args
        .identity;

      // Register identities
      await identityRegistry.registerIdentity(
        investor1.address,
        investor1OnchainID,
        840,
      );
      await attest(claimIssuer, owner, investor1OnchainID);
      await identityRegistry.registerIdentity(
        investor2.address,
        investor2OnchainID,
        840,
      );
      await attest(claimIssuer, owner, investor2OnchainID);

      // Mint tokens to investor1
      await token.mint(investor1.address, ethers.parseEther("1000"));

      // Enforcing stack: ComplianceRules + a token bound to it.
      const ComplianceRulesFactory =
        await ethers.getContractFactory("ComplianceRules");
      complianceRules = await ComplianceRulesFactory.deploy(
        owner.address,
        [840],
        [],
      );
      const TokenFactory = await ethers.getContractFactory("Token");
      gatedToken = await TokenFactory.deploy(
        "Gated Token",
        "GTD",
        await identityRegistry.getAddress(),
        await complianceRules.getAddress(),
      );
      await complianceRules.setTokenIdentityRegistry(
        await gatedToken.getAddress(),
        await identityRegistry.getAddress(),
      );
      await gatedToken.mint(investor1.address, ethers.parseEther("1000"));
    });

    it("✅ Should allow transfer between whitelisted addresses", async function () {
      // Add both investors to whitelist
      await whitelistOracle.addToWhitelist(
        investor1.address,
        4,
        0,
        "KYC + AML Approved",
      );
      await whitelistOracle.addToWhitelist(
        investor2.address,
        4,
        0,
        "KYC + AML Approved",
      );

      // Verify whitelist status
      expect(await whitelistOracle.isWhitelisted(investor1.address)).to.be.true;
      expect(await whitelistOracle.isWhitelisted(investor2.address)).to.be.true;

      // Transfer should succeed
      const transferAmount = ethers.parseEther("100");
      await expect(
        token.connect(investor1).transfer(investor2.address, transferAmount),
      ).to.not.be.reverted;

      expect(await token.balanceOf(investor2.address)).to.equal(transferAmount);
      console.log("✅ Transfer successful between whitelisted addresses");
    });

    it("🚫 Should block transfer to blacklisted address", async function () {
      // Point the token's ComplianceRules at the blacklist oracle. Without
      // this the gate is off by design, and the transfer would go through.
      await complianceRules.setBlacklistOracle(
        await gatedToken.getAddress(),
        await blacklistOracle.getAddress(),
      );

      await whitelistOracle.addToWhitelist(
        investor1.address,
        4,
        0,
        "KYC + AML Approved",
      );
      await blacklistOracle.addToBlacklist(
        investor2.address,
        2,
        0,
        "AML Risk Detected",
      );
      expect(await blacklistOracle.isBlacklisted(investor2.address)).to.be.true;

      const before = await gatedToken.balanceOf(investor2.address);
      await expect(
        gatedToken
          .connect(investor1)
          .transfer(investor2.address, ethers.parseEther("100")),
      ).to.be.revertedWith("Compliance check failed");
      expect(await gatedToken.balanceOf(investor2.address)).to.equal(before);
    });

    it("🚫 Should block transfer from blacklisted address", async function () {
      await complianceRules.setBlacklistOracle(
        await gatedToken.getAddress(),
        await blacklistOracle.getAddress(),
      );

      await whitelistOracle.addToWhitelist(
        investor2.address,
        4,
        0,
        "KYC + AML Approved",
      );
      await blacklistOracle.addToBlacklist(
        investor1.address,
        1,
        0,
        "Suspicious Activity",
      );
      expect(await blacklistOracle.isBlacklisted(investor1.address)).to.be.true;

      const before = await gatedToken.balanceOf(investor1.address);
      await expect(
        gatedToken
          .connect(investor1)
          .transfer(investor2.address, ethers.parseEther("100")),
      ).to.be.revertedWith("Compliance check failed");
      expect(await gatedToken.balanceOf(investor1.address)).to.equal(before);
    });
  });

  describe("🔄 Oracle Consensus Integration", function () {
    it("Should handle oracle consensus for whitelist decisions", async function () {
      // Create consensus query for whitelist
      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8"],
        [3],
      );

      // Create the query and get queryId from event
      const queryId = await raise(investor1.address, 1, queryData);

      // Nodes answer through the manager (66%: two of three resolve)
      await vote(queryId, [
        [oracle1, true],
        [oracle2, true],
        [oracle3, false],
      ]);

      // Check consensus result
      const result = await consensusOracle.getConsensusResult(queryId);
      expect(result.isResolved).to.be.true;
      expect(result.result).to.be.true; // 2 out of 3 voted true

      console.log("✅ Oracle consensus mechanism working correctly");
    });

    it("Should handle emergency blacklist scenarios", async function () {
      // Emergency blacklist by authorized oracle
      await expect(
        blacklistOracle.connect(oracle1).emergencyBlacklist(
          investor1.address,
          3, // CRITICAL
          "Immediate Security Threat",
        ),
      ).to.emit(blacklistOracle, "EmergencyBlacklistAdded");

      expect(await blacklistOracle.isBlacklisted(investor1.address)).to.be.true;

      const info = await blacklistOracle.getBlacklistInfo(investor1.address);
      expect(info.emergencyListing).to.be.true;
      expect(info.severity).to.equal(3);

      console.log("✅ Emergency blacklist mechanism working correctly");
    });
  });
});
