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
  let consensusOracle: ConsensusOracle;
  let onchainIDFactory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;
  let identityRegistry: IdentityRegistry;
  let owner: SignerWithAddress;
  let oracle1: SignerWithAddress;
  let oracle2: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let amlProvider: SignerWithAddress;
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
      identityRegistry,
      owner,
      oracle1,
      oracle2,
      oracle3,
      kycProvider,
      amlProvider,
      investor1,
      investor2,
    } = await deployOracleIntegration());
  });

  describe("📋 KYC/AML Claim Integration with Oracle Whitelist", function () {
    it("📋 Issue KYC Claim (Success) - Should add to oracle whitelist", async function () {
      // Step 1: Create OnchainID for investor
      const salt = ethers.randomBytes(32);
      const txDeploy0 = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(investor1.address, salt, {
          value: ethers.parseEther("0.01"),
        });
      const receiptDeploy0 = await txDeploy0.wait();

      // Extract OnchainID address from events
      const event = receiptDeploy0?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
      const onchainIDAddress = onchainIDFactory.interface.parseLog(event!)!.args
        .identity;

      // Step 2: Issue KYC claim
      const kycClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256"],
        ["John Doe", "US", Date.now()],
      );

      const tx1 = await issueSigned(
        claimIssuer,
        kycProvider,
        onchainIDAddress,
        KYC_CLAIM_TOPIC,
        kycClaimData,
        "", // uri
        Math.floor(Date.now() / 1000) + 86400, // validTo (24 hours from now)
      );
      await tx1.wait();

      // Step 3: Oracle consensus to add to whitelist
      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8"],
        [4],
      );

      const queryId = await raise(investor1.address, 1, queryData);

      // Nodes answer through the manager (66%: two of three resolve)
      await vote(queryId, [
        [oracle1, true],
        [oracle2, true],
        [oracle3, true],
      ]);

      // Step 5: Add to whitelist based on consensus
      await whitelistOracle.addToWhitelist(
        investor1.address,
        4,
        0,
        "KYC Approved by Oracle Consensus",
      );

      // Step 6: Register identity in ERC-3643
      await identityRegistry.registerIdentity(
        investor1.address,
        onchainIDAddress,
        840,
      ); // US country code
      await attest(claimIssuer, owner, onchainIDAddress);

      // Verify integration
      expect(await whitelistOracle.isWhitelisted(investor1.address)).to.be.true;
      expect(await identityRegistry.isVerified(investor1.address)).to.be.true;

      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        investor1.address,
      );
      expect(whitelistInfo.tier).to.equal(4);
      expect(whitelistInfo.reason).to.equal("KYC Approved by Oracle Consensus");

      console.log(
        "✅ KYC Claim issued successfully and investor added to oracle whitelist",
      );
    });

    it("🔍 Issue AML Claim (Success) - Should maintain whitelist status", async function () {
      // Setup: First complete KYC process
      const salt = ethers.randomBytes(32);
      const txDeploy1 = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(investor1.address, salt, {
          value: ethers.parseEther("0.01"),
        });
      const receiptDeploy1 = await txDeploy1.wait();

      const event = receiptDeploy1?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });

      const onchainIDAddress = onchainIDFactory.interface.parseLog(event!)!.args
        .identity;

      // Add to whitelist first (KYC approved)
      await whitelistOracle.addToWhitelist(
        investor1.address,
        3,
        0,
        "KYC Approved",
      );

      // Step 1: Issue AML claim
      const amlClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "bool"],
        ["AML_CLEAR", Date.now(), true],
      );

      const tx3 = await issueSigned(
        claimIssuer,
        amlProvider,
        onchainIDAddress,
        AML_CLAIM_TOPIC,
        amlClaimData,
        "", // uri
        Math.floor(Date.now() / 1000) + 86400, // validTo (24 hours from now)
      );
      await tx3.wait();

      // Step 2: Oracle consensus for AML verification
      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8"],
        [5],
      );

      const queryId = await raise(investor1.address, 1, queryData);

      // Nodes answer through the manager (66%: two of three resolve)
      await vote(queryId, [
        [oracle1, true],
        [oracle2, true],
      ]);

      // Step 3: Upgrade whitelist tier due to AML clearance
      await whitelistOracle.addToWhitelist(
        investor1.address,
        5,
        0,
        "KYC + AML Approved by Oracle Consensus",
      );

      // Verify enhanced status
      expect(await whitelistOracle.isWhitelisted(investor1.address)).to.be.true;

      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        investor1.address,
      );
      expect(whitelistInfo.tier).to.equal(5); // Highest tier
      expect(whitelistInfo.reason).to.equal(
        "KYC + AML Approved by Oracle Consensus",
      );

      console.log(
        "✅ AML Claim issued successfully and investor upgraded to highest whitelist tier",
      );
    });

    it("🚫 Issue KYC Rejection - Should add to oracle blacklist", async function () {
      // Step 1: Create OnchainID for investor
      const salt = ethers.randomBytes(32);
      const txDeploy2 = await onchainIDFactory
        .connect(investor2)
        .deployOnchainID(investor2.address, salt, {
          value: ethers.parseEther("0.01"),
        });
      const receiptDeploy2 = await txDeploy2.wait();

      const event = receiptDeploy2?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });

      const onchainIDAddress = onchainIDFactory.interface.parseLog(event!)!.args
        .identity;

      // Step 2: Attempt KYC but fail verification
      const kycClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256", "string"],
        ["Invalid Identity", "UNKNOWN", Date.now(), "REJECTED"],
      );

      // Don't issue claim - simulate KYC failure

      // Step 3: Oracle consensus to reject and blacklist
      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "string"],
        [onchainIDAddress, KYC_CLAIM_TOPIC, "KYC_REJECTED"],
      );

      // A blacklist query's data is its severity: empty = MEDIUM (2F.3);
      // the rejection reason above stays off chain.
      const queryId = await raise(investor2.address, 2, "0x");

      // Nodes answer through the manager (66%: two of three resolve)
      await vote(queryId, [
        [oracle1, true],
        [oracle2, true],
      ]);

      // Step 4: Add to blacklist due to KYC failure
      await blacklistOracle.addToBlacklist(
        investor2.address,
        1, // MEDIUM severity
        0,
        "KYC Verification Failed - Oracle Consensus",
      );

      // Step 5: Verify oracle blacklist status (Note: IdentityRegistry integration would require additional compliance module)
      // Current IdentityRegistry doesn't integrate with oracle blacklist, so we just verify oracle functionality

      // Verify blacklist status
      expect(await blacklistOracle.isBlacklisted(investor2.address)).to.be.true;
      expect(await whitelistOracle.isWhitelisted(investor2.address)).to.be
        .false;

      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        investor2.address,
      );
      expect(blacklistInfo.severity).to.equal(1); // MEDIUM
      expect(blacklistInfo.reason).to.equal(
        "KYC Verification Failed - Oracle Consensus",
      );

      console.log(
        "✅ KYC Rejection processed successfully and investor added to oracle blacklist",
      );
    });

    it("🚫 Issue AML Rejection - Should emergency blacklist", async function () {
      // Setup: Investor initially has KYC but fails AML
      const salt = ethers.randomBytes(32);
      const txDeploy3 = await onchainIDFactory
        .connect(investor2)
        .deployOnchainID(investor2.address, salt, {
          value: ethers.parseEther("0.01"),
        });
      const receiptDeploy3 = await txDeploy3.wait();

      const event = receiptDeploy3?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });

      const onchainIDAddress = onchainIDFactory.interface.parseLog(event!)!.args
        .identity;

      // Initially whitelisted due to KYC
      await whitelistOracle.addToWhitelist(
        investor2.address,
        3,
        0,
        "KYC Approved",
      );

      // Step 1: AML check reveals high-risk activity
      const amlClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "bool", "string"],
        ["AML_RISK_DETECTED", Date.now(), false, "HIGH_RISK_JURISDICTION"],
      );

      // Step 2: Emergency blacklisting due to AML risk
      await expect(
        blacklistOracle.connect(oracle1).emergencyBlacklist(
          investor2.address,
          3, // CRITICAL severity
          "AML High Risk - Money Laundering Indicators Detected",
        ),
      )
        .to.emit(blacklistOracle, "EmergencyBlacklistAdded")
        .withArgs(
          investor2.address,
          oracle1.address,
          3,
          "AML High Risk - Money Laundering Indicators Detected",
        );

      // Step 3: Remove from whitelist
      await whitelistOracle.removeFromWhitelist(
        investor2.address,
        "AML Risk Detected",
      );

      // Step 4: Revoke identity registration if exists
      if (await identityRegistry.isVerified(investor2.address)) {
        await identityRegistry.deleteIdentity(investor2.address);
      }

      // Verify emergency blacklist
      expect(await blacklistOracle.isBlacklisted(investor2.address)).to.be.true;
      expect(await whitelistOracle.isWhitelisted(investor2.address)).to.be
        .false;

      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        investor2.address,
      );
      expect(blacklistInfo.severity).to.equal(3); // CRITICAL
      expect(blacklistInfo.emergencyListing).to.be.true;
      expect(blacklistInfo.reason).to.equal(
        "AML High Risk - Money Laundering Indicators Detected",
      );

      console.log(
        "✅ AML Rejection processed successfully with emergency blacklisting",
      );
    });
  });
});
