// The Oracle-ERC3643 integration suite's shared setup (Task 5.4 split
// OracleERC3643Integration.test.ts into OracleERC3643{Claims,Token}.test.ts):
// the oracle stack on three weighted nodes, OnchainID factory, claim
// issuer and a token with its registries, deployed per test.
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
import { attest, configureKyc, issueSigned } from "./kyc";

// Claim topics
export const KYC_CLAIM_TOPIC = 1;
export const AML_CLAIM_TOPIC = 2;
export const COUNTRY_CLAIM_TOPIC = 3;
export const INVESTOR_TYPE_CLAIM_TOPIC = 4;

export async function deployOracleERC3643() {
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
  const OracleManagerFactory = await ethers.getContractFactory("OracleManager");
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
  onchainIDFactory = await OnchainIDFactoryContract.deploy(
    owner.address,
    ethers.ZeroHash,
  );
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
  return {
    oracleManager,
    whitelistOracle,
    blacklistOracle,
    consensusOracle,
    token,
    identityRegistry,
    complianceRegistry,
    onchainIDFactory,
    claimIssuer,
    owner,
    oracle1,
    oracle2,
    oracle3,
    kycProvider,
    investor1,
    investor2,
    tokenAgent,
  };
}
