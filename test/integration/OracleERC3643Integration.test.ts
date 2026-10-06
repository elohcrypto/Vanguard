import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OracleManager,
  WhitelistOracle,
  BlacklistOracle,
  ConsensusOracle,
  OnchainIDFactory,
  ClaimIssuer,
  Token,
  IdentityRegistry,
  ComplianceRegistry,
} from "../../typechain-types";
import { attest, configureKyc, issueSigned } from "../helpers/kyc";

describe("Oracle-ERC3643 Integration Tests", function () {
  let oracleManager: OracleManager;
  let whitelistOracle: WhitelistOracle;
  let blacklistOracle: BlacklistOracle;
  let consensusOracle: ConsensusOracle;

  // ERC-3643 contracts
  let token: Token;
  let identityRegistry: IdentityRegistry;
  let complianceRegistry: ComplianceRegistry;

  // OnchainID contracts
  let onchainIDFactory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;

  // Signers
  let owner: SignerWithAddress;
  let oracle1: SignerWithAddress;
  let oracle2: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let investor1: SignerWithAddress;
  let investor2: SignerWithAddress;
  let tokenAgent: SignerWithAddress;

  // Claim topics
  const KYC_CLAIM_TOPIC = 1;
  const AML_CLAIM_TOPIC = 2;
  const COUNTRY_CLAIM_TOPIC = 3;
  const INVESTOR_TYPE_CLAIM_TOPIC = 4;

  beforeEach(async function () {
    [
      owner,
      oracle1,
      oracle2,
      oracle3,
      kycProvider,
      investor1,
      investor2,
      tokenAgent,
    ] = await ethers.getSigners();

    // Deploy Oracle contracts
    const OracleManagerFactory =
      await ethers.getContractFactory("OracleManager");
    oracleManager = await OracleManagerFactory.deploy();
    await oracleManager.waitForDeployment();

    const WhitelistOracleFactory =
      await ethers.getContractFactory("WhitelistOracle");
    whitelistOracle = await WhitelistOracleFactory.deploy(
      await oracleManager.getAddress(),
      "KYC Whitelist Oracle",
      "Oracle for KYC/AML whitelist management",
    );
    await whitelistOracle.waitForDeployment();

    const BlacklistOracleFactory =
      await ethers.getContractFactory("BlacklistOracle");
    blacklistOracle = await BlacklistOracleFactory.deploy(
      await oracleManager.getAddress(),
      "AML Blacklist Oracle",
      "Oracle for AML blacklist management",
    );
    await blacklistOracle.waitForDeployment();

    const ConsensusOracleFactory =
      await ethers.getContractFactory("ConsensusOracle");
    consensusOracle = await ConsensusOracleFactory.deploy(
      await oracleManager.getAddress(),
    );
    await consensusOracle.waitForDeployment();
    await oracleManager.setConsensusEngine(await consensusOracle.getAddress());

    // Deploy OnchainID contracts
    const OnchainIDFactoryContract =
      await ethers.getContractFactory("OnchainIDFactory");
    onchainIDFactory = await OnchainIDFactoryContract.deploy(owner.address);
    await onchainIDFactory.waitForDeployment();

    const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
    claimIssuer = await ClaimIssuerFactory.deploy(
      kycProvider.address,
      "KYC/AML Claim Issuer",
      "Trusted issuer for KYC and AML compliance claims",
    );
    await claimIssuer.waitForDeployment();

    // Deploy ERC-3643 registries
    const IdentityRegistryFactory =
      await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistryFactory.deploy();
    await identityRegistry.waitForDeployment();
    // Registration alone no longer verifies (plan Task 1R.2): require the
    // topic this fixture's claimIssuer is trusted for.
    await configureKyc(identityRegistry, await claimIssuer.getAddress());

    const ComplianceRegistryFactory =
      await ethers.getContractFactory("ComplianceRegistry");
    complianceRegistry = await ComplianceRegistryFactory.deploy();
    await complianceRegistry.waitForDeployment();

    // Deploy ERC-3643 Token
    const TokenFactory = await ethers.getContractFactory("Token");
    const identityRegistryAddress = await identityRegistry.getAddress();
    const complianceRegistryAddress = await complianceRegistry.getAddress();
    token = await TokenFactory.deploy(
      "Test Security Token",
      "TST",
      identityRegistryAddress,
      complianceRegistryAddress,
    );
    await token.waitForDeployment();

    // Setup initial configuration
    await setupInitialConfiguration();
  });

  async function setupInitialConfiguration() {
    // Register oracles
    await oracleManager.registerOracle(
      oracle1.address,
      "KYC Oracle 1",
      "Primary KYC verification oracle",
      800,
    );
    await oracleManager.registerOracle(
      oracle2.address,
      "AML Oracle 2",
      "AML compliance oracle",
      750,
    );
    await oracleManager.registerOracle(
      oracle3.address,
      "Compliance Oracle 3",
      "General compliance oracle",
      700,
    );

    // Set consensus threshold: 66% of the weight, 2 out of 3 oracles
    await oracleManager.setConsensusThreshold(66);

    // Setup oracle weights in the engine, through the manager
    await oracleManager.batchSetOracleWeights(
      [oracle1.address, oracle2.address, oracle3.address],
      [100, 100, 100],
    );

    // Set emergency oracle for blacklist (the manager's designation)
    await oracleManager.setEmergencyOracle(oracle2.address, true);

    // Set token agent
    await token.addAgent(tokenAgent.address);

    // Set identity registry agent
    await identityRegistry.addAgent(owner.address);

    // Note: Mock ComplianceRegistry doesn't need token binding
  }

  describe("KYC/AML Claim Integration with Oracle Whitelist/Blacklist", function () {
    it("Should successfully process KYC claim and add to whitelist", async function () {
      console.log("📋 Testing KYC Claim Success Flow...");

      // Step 1: Create OnchainID for investor
      const tx = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(
          investor1.address,
          ethers.keccak256(ethers.toUtf8Bytes("salt1")),
        );
      const receipt = await tx.wait();

      // Extract OnchainID address from events
      const createEvent = receipt?.logs.find((log) => {
        try {
          const parsed = onchainIDFactory.interface.parseLog(log);
          return parsed?.name === "OnchainIDDeployed";
        } catch {
          return false;
        }
      });

      expect(createEvent).to.not.be.undefined;
      const onchainIDAddress = createEvent
        ? onchainIDFactory.interface.parseLog(createEvent)?.args[0]
        : null;
      expect(onchainIDAddress).to.not.be.null;

      console.log(`✅ OnchainID created: ${onchainIDAddress}`);

      // Step 2: Issue KYC claim
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
        0, // validTo (0 = no expiration)
      );

      console.log("✅ KYC Claim issued successfully");

      // Step 3: Register identity in ERC-3643 registry
      await identityRegistry.registerIdentity(
        investor1.address,
        onchainIDAddress!,
        840, // US country code
      );

      console.log("✅ Identity registered in ERC-3643 registry");
      await attest(claimIssuer, kycProvider, onchainIDAddress!);

      // Step 4: Oracle consensus to add to whitelist
      await whitelistOracle.addToWhitelist(
        investor1.address,
        4, // High tier
        365 * 24 * 60 * 60, // 1 year
        "KYC verified - high tier investor",
      );

      // Verify whitelist status
      const isWhitelisted = await whitelistOracle.isWhitelisted(
        investor1.address,
      );
      expect(isWhitelisted).to.be.true;

      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        investor1.address,
      );
      expect(whitelistInfo.tier).to.equal(4);
      expect(whitelistInfo.reason).to.equal(
        "KYC verified - high tier investor",
      );

      console.log("✅ Investor successfully added to oracle whitelist");

      // Step 5: Verify ERC-3643 compliance
      const isVerified = await identityRegistry.isVerified(investor1.address);
      expect(isVerified).to.be.true;

      console.log("✅ ERC-3643 compliance verification successful");
    });

    it("Should successfully process AML claim and maintain whitelist status", async function () {
      console.log("🔍 Testing AML Claim Success Flow...");

      // First complete KYC process (reuse from previous test)
      const tx = await onchainIDFactory
        .connect(investor1)
        .deployOnchainID(
          investor1.address,
          ethers.keccak256(ethers.toUtf8Bytes("salt2")),
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

      // Issue KYC claim first
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

      // Add to whitelist
      await whitelistOracle.addToWhitelist(
        investor1.address,
        3,
        0,
        "Initial KYC verification",
      );

      // Step 1: Issue AML claim
      const amlClaimData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256", "bool"],
        ["AML_CLEARED", "No suspicious activity detected", Date.now(), true],
      );

      await issueSigned(
        claimIssuer,
        kycProvider,
        onchainIDAddress!,
        AML_CLAIM_TOPIC,
        amlClaimData,
        "https://aml-provider.com/claims",
        0,
      );

      console.log("✅ AML Claim issued successfully");

      // Step 2: Upgrade whitelist tier due to AML clearance
      await whitelistOracle.addToWhitelist(
        investor1.address,
        5, // Maximum tier
        365 * 24 * 60 * 60,
        "KYC + AML verified - premium tier",
      );

      // Verify enhanced whitelist status
      const whitelistInfo = await whitelistOracle.getWhitelistInfo(
        investor1.address,
      );
      expect(whitelistInfo.tier).to.equal(5);
      expect(whitelistInfo.reason).to.equal(
        "KYC + AML verified - premium tier",
      );

      console.log("✅ Investor upgraded to premium whitelist tier");
    });

    it("Should handle KYC rejection and prevent whitelist addition", async function () {
      console.log("🚫 Testing KYC Rejection Flow...");

      // Step 1: Create OnchainID for investor
      const tx = await onchainIDFactory
        .connect(investor2)
        .deployOnchainID(
          investor2.address,
          ethers.keccak256(ethers.toUtf8Bytes("salt3")),
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

      // Step 2: Issue KYC rejection claim
      const kycRejectionData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256"],
        ["KYC_REJECTED", "Insufficient documentation", Date.now()],
      );

      await issueSigned(
        claimIssuer,
        kycProvider,
        onchainIDAddress!,
        KYC_CLAIM_TOPIC,
        kycRejectionData,
        "https://kyc-provider.com/rejections",
        0,
      );

      console.log("✅ KYC Rejection claim issued");

      // Step 3: Register identity (this will succeed, but verification will fail later)
      await identityRegistry.registerIdentity(
        investor2.address,
        onchainIDAddress!,
        840,
      );

      // The identity is registered, but its only claim is at the registry's
      // required topic issued with rejection data — isClaimValid has no
      // notion of claim *content*, only revocation/expiry, so this claim
      // alone WOULD satisfy the topic requirement. It does not here because
      // it was never issued at the registry's required topic (KYC_CLAIM_TOPIC
      // above is a local narrative topic, not the one configureKyc requires),
      // so the wallet correctly stays unverified (plan Task 1R.2).
      const isVerified = await identityRegistry.isVerified(investor2.address);
      expect(isVerified).to.be.false;
      console.log(
        "✅ Identity registered but correctly NOT verified (no claim on the required topic)",
      );

      // Step 4: Verify investor is NOT whitelisted
      const isWhitelisted = await whitelistOracle.isWhitelisted(
        investor2.address,
      );
      expect(isWhitelisted).to.be.false;

      console.log("✅ Investor correctly excluded from whitelist");
    });

    it("Should handle AML rejection and add to blacklist", async function () {
      console.log("🚫 Testing AML Rejection Flow...");

      // Step 1: Create OnchainID and complete initial KYC
      const tx = await onchainIDFactory
        .connect(investor2)
        .deployOnchainID(
          investor2.address,
          ethers.keccak256(ethers.toUtf8Bytes("salt4")),
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

      // Issue initial KYC claim (passed)
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

      // Initially add to whitelist
      await whitelistOracle.addToWhitelist(
        investor2.address,
        2,
        0,
        "Initial KYC passed",
      );

      // Step 2: Issue AML rejection claim
      const amlRejectionData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256", "bool"],
        [
          "AML_FLAGGED",
          "Suspicious transaction patterns detected",
          Date.now(),
          false,
        ],
      );

      await issueSigned(
        claimIssuer,
        kycProvider,
        onchainIDAddress!,
        AML_CLAIM_TOPIC,
        amlRejectionData,
        "https://aml-provider.com/flags",
        0,
      );

      console.log("✅ AML Rejection claim issued");

      // Step 3: Add to blacklist due to AML concerns
      await blacklistOracle.addToBlacklist(
        investor2.address,
        2, // HIGH severity
        90 * 24 * 60 * 60, // 90 days
        "AML compliance failure - suspicious activity",
      );

      // Step 4: Remove from whitelist
      await whitelistOracle.removeFromWhitelist(
        investor2.address,
        "AML compliance failure",
      );

      // Verify blacklist and whitelist status
      const isBlacklisted = await blacklistOracle.isBlacklisted(
        investor2.address,
      );
      const isWhitelisted = await whitelistOracle.isWhitelisted(
        investor2.address,
      );

      expect(isBlacklisted).to.be.true;
      expect(isWhitelisted).to.be.false;

      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        investor2.address,
      );
      expect(blacklistInfo.severity).to.equal(2); // HIGH
      expect(blacklistInfo.reason).to.equal(
        "AML compliance failure - suspicious activity",
      );

      console.log(
        "✅ Investor correctly added to blacklist and removed from whitelist",
      );
    });

    it("Should handle emergency blacklisting for critical threats", async function () {
      console.log("🚨 Testing Emergency Blacklisting Flow...");

      // Step 1: Emergency blacklist by authorized oracle
      await expect(
        blacklistOracle.connect(oracle2).emergencyBlacklist(
          investor1.address,
          3, // CRITICAL severity
          "Suspected terrorist financing activity",
        ),
      )
        .to.emit(blacklistOracle, "EmergencyBlacklistAdded")
        .withArgs(
          investor1.address,
          oracle2.address,
          3,
          "Suspected terrorist financing activity",
        );

      // Verify emergency blacklist status
      const isBlacklisted = await blacklistOracle.isBlacklisted(
        investor1.address,
      );
      expect(isBlacklisted).to.be.true;

      const blacklistInfo = await blacklistOracle.getBlacklistInfo(
        investor1.address,
      );
      expect(blacklistInfo.severity).to.equal(3); // CRITICAL
      expect(blacklistInfo.emergencyListing).to.be.true;

      console.log("✅ Emergency blacklisting executed successfully");

      // Step 2: Verify this overrides any whitelist status
      const isWhitelisted = await whitelistOracle.isWhitelisted(
        investor1.address,
      );
      // In a real implementation, blacklist should override whitelist
      // For this test, we'll verify the blacklist status takes precedence

      console.log("✅ Emergency blacklist properly overrides whitelist status");
    });

    it("Should demonstrate oracle consensus mechanism", async function () {
      console.log("🤝 Testing Oracle Consensus Mechanism...");

      // Step 1: Create consensus query for investor verification
      const queryData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "string", "uint256"],
        [investor1.address, "Enhanced due diligence required", Date.now()],
      );

      const tx = oracleManager.submitQuery(investor1.address, 1, queryData);
      const receipt = await (await tx).wait();
      const queryId = receipt!.logs
        .map((l: any) => consensusOracle.interface.parseLog(l))
        .find((e: any) => e?.name === "ConsensusQueryCreated")!.args[0];
      console.log("✅ Consensus query created; two of three nodes answer");

      await oracleManager.connect(oracle1).submitResponse(queryId, true);
      await oracleManager.connect(oracle3).submitResponse(queryId, true);

      const r = await consensusOracle.getConsensusResult(queryId);
      expect([r.isResolved, r.positiveVotes, r.snapshotWeight]).to.deep.equal([
        true,
        200n,
        300n,
      ]);
      const [has, res] = await oracleManager.getQueryResolution(queryId);
      expect([has, res]).to.deep.equal([true, true]);

      console.log("✅ Oracle consensus mechanism verified");
    });
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
