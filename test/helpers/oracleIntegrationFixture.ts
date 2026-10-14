// The Oracle Integration suite's shared setup (Task 5.4 split
// OracleIntegration.test.ts into OracleIntegration{Claims,Transfers,
// E2E}.test.ts): the oracle manager, whitelist, blacklist and consensus
// engine on three weighted nodes, OnchainID factory, claim issuer and a
// token with its registries, deployed per test.
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
import { attest, configureKyc, issueSigned } from "./kyc";

// Constants
export const KYC_CLAIM_TOPIC = 1;
export const AML_CLAIM_TOPIC = 2;
export const COUNTRY_CLAIM_TOPIC = 3;
export const INVESTOR_TYPE_CLAIM_TOPIC = 4;

export async function deployOracleIntegration() {
  // Contract instances
  let oracleManager: OracleManager;
  let whitelistOracle: WhitelistOracle;
  let blacklistOracle: BlacklistOracle;
  let consensusOracle: ConsensusOracle;

  let onchainIDFactory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;
  let token: Token;
  let identityRegistry: IdentityRegistry;
  let complianceRegistry: ComplianceRegistry;

  // Signers
  let owner: SignerWithAddress;
  let oracle1: SignerWithAddress;
  let oracle2: SignerWithAddress;
  let oracle3: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let amlProvider: SignerWithAddress;
  let investor1: SignerWithAddress;
  let investor2: SignerWithAddress;
  let tokenAgent: SignerWithAddress;

  [
    owner,
    oracle1,
    oracle2,
    oracle3,
    kycProvider,
    amlProvider,
    investor1,
    investor2,
    tokenAgent,
  ] = await ethers.getSigners();

  // Deploy Oracle System
  const OracleManagerFactory = await ethers.getContractFactory("OracleManager");
  oracleManager = await OracleManagerFactory.deploy();
  await oracleManager.waitForDeployment();

  const WhitelistOracleFactory =
    await ethers.getContractFactory("WhitelistOracle");
  whitelistOracle = await WhitelistOracleFactory.deploy(
    await oracleManager.getAddress(),
    "Whitelist Oracle",
    "Oracle for managing whitelist consensus",
  );
  await whitelistOracle.waitForDeployment();

  const BlacklistOracleFactory =
    await ethers.getContractFactory("BlacklistOracle");
  blacklistOracle = await BlacklistOracleFactory.deploy(
    await oracleManager.getAddress(),
    "Blacklist Oracle",
    "Oracle for managing blacklist consensus",
  );
  await blacklistOracle.waitForDeployment();

  const ConsensusOracleFactory =
    await ethers.getContractFactory("ConsensusOracle");
  // Task 4.4: the manager's consensus engine, bound both ways.
  consensusOracle = await ConsensusOracleFactory.deploy(
    await oracleManager.getAddress(),
  );
  await consensusOracle.waitForDeployment();
  await oracleManager.setConsensusEngine(await consensusOracle.getAddress());

  // Deploy OnchainID System
  const OnchainIDFactoryContract =
    await ethers.getContractFactory("OnchainIDFactory");
  onchainIDFactory = await OnchainIDFactoryContract.deploy(
    owner.address,
    ethers.ZeroHash,
  );
  await onchainIDFactory.waitForDeployment();

  const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
  claimIssuer = await ClaimIssuerFactory.deploy(
    owner.address,
    "Test KYC Issuer",
    "Test issuer for KYC claims",
  );
  await claimIssuer.waitForDeployment();

  // Add KYC and AML providers as claim signers
  const kycProviderKey = ethers.keccak256(
    ethers.solidityPacked(["address"], [kycProvider.address]),
  );
  const amlProviderKey = ethers.keccak256(
    ethers.solidityPacked(["address"], [amlProvider.address]),
  );
  await claimIssuer.addIssuerKey(kycProviderKey, 3, 1); // CLAIM_SIGNER_KEY = 3, ECDSA_TYPE = 1
  await claimIssuer.addIssuerKey(amlProviderKey, 3, 1);

  // Deploy ERC-3643 System
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

  const TokenFactory = await ethers.getContractFactory("Token");
  token = await TokenFactory.deploy(
    "Test Security Token",
    "TST",
    await identityRegistry.getAddress(),
    await complianceRegistry.getAddress(),
  );
  await token.waitForDeployment();

  // Setup Oracle Network
  await oracleManager.registerOracle(
    oracle1.address,
    "Oracle 1",
    "KYC/AML Oracle 1",
    500,
  );
  await oracleManager.registerOracle(
    oracle2.address,
    "Oracle 2",
    "KYC/AML Oracle 2",
    500,
  );
  await oracleManager.registerOracle(
    oracle3.address,
    "Oracle 3",
    "KYC/AML Oracle 3",
    500,
  );

  // Setup consensus weights (engine, through the manager)
  for (const o of [oracle1, oracle2, oracle3]) {
    await oracleManager.setOracleWeight(o.address, 100);
  }

  // Setup emergency oracle for blacklist (the manager's designation)
  await oracleManager.setEmergencyOracle(oracle1.address, true);
  return {
    oracleManager,
    whitelistOracle,
    blacklistOracle,
    consensusOracle,
    onchainIDFactory,
    claimIssuer,
    token,
    identityRegistry,
    complianceRegistry,
    owner,
    oracle1,
    oracle2,
    oracle3,
    kycProvider,
    amlProvider,
    investor1,
    investor2,
    tokenAgent,
  };
}
