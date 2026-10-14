// The Governance Token System suite's shared setup (Task 5.4 split
// GovernanceToken.test.ts into GovernanceToken{Core,Execution}.test.ts):
// VGT, governance, registry and rules with KYC and AML issuers, owner and
// three voters verified and aged past minVoterAge, run per test.
import { ethers } from "hardhat";
import { ageVoters } from "./governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  attest,
  configureKyc,
  KYC_TOPIC as REGISTRY_KYC_TOPIC,
  AML_TOPIC as REGISTRY_AML_TOPIC,
  issueSigned,
} from "./kyc";

export const VGT = (amount: number) => ethers.parseEther(amount.toString());
const KYC_TOPIC = 1;
const AML_TOPIC = 2;

export async function deployGovernanceToken() {
  let governanceToken: any;
  let vanguardGovernance: any;
  let identityRegistry: any;
  let complianceRules: any;
  let onchainIDFactory: any;
  let kycIssuer: any;
  let amlIssuer: any;

  let owner: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let voter3: SignerWithAddress;
  let nonVoter: SignerWithAddress;

  [owner, voter1, voter2, voter3, nonVoter] = await ethers.getSigners();

  // Deploy OnchainIDFactory
  const OnchainIDFactory = await ethers.getContractFactory("OnchainIDFactory");
  onchainIDFactory = await OnchainIDFactory.deploy(
    owner.address,
    ethers.ZeroHash,
  );
  await onchainIDFactory.waitForDeployment();

  // Deploy KYC and AML ClaimIssuers
  const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
  kycIssuer = await ClaimIssuer.deploy(
    owner.address,
    "KYC Service",
    "KYC verification service",
  );
  await kycIssuer.waitForDeployment();

  amlIssuer = await ClaimIssuer.deploy(
    owner.address,
    "AML Service",
    "AML screening service",
  );
  await amlIssuer.waitForDeployment();

  // Deploy IdentityRegistry
  const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
  identityRegistry = await IdentityRegistry.deploy();
  await identityRegistry.waitForDeployment();
  // Registration alone no longer verifies (plan Task 1R.2): require
  // both the KYC and AML topics this fixture already issues claims for.
  await configureKyc(
    identityRegistry,
    await kycIssuer.getAddress(),
    await amlIssuer.getAddress(),
  );

  // Deploy ComplianceRules
  const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
  complianceRules = await ComplianceRules.deploy(
    owner.address,
    [], // Empty allowed list = all countries allowed (except blocked)
    [], // No blocked countries
  );
  await complianceRules.waitForDeployment();

  // Setup owner identity BEFORE deploying GovernanceToken
  // (GovernanceToken constructor mints to owner, which requires owner to be verified)
  const ownerSalt = ethers.randomBytes(32);
  await onchainIDFactory
    .connect(owner)
    .deployOnchainID(owner.address, ownerSalt);
  const ownerIdentityAddress = await onchainIDFactory.getIdentityByOwner(
    owner.address,
  );

  const ownerKycData = ethers.hexlify(ethers.toUtf8Bytes("KYC_APPROVED"));
  await issueSigned(
    kycIssuer,
    owner,
    ownerIdentityAddress,
    KYC_TOPIC,
    ownerKycData,
    "",
    0,
  );

  const ownerAmlData = ethers.hexlify(ethers.toUtf8Bytes("AML_APPROVED"));
  await issueSigned(
    amlIssuer,
    owner,
    ownerIdentityAddress,
    AML_TOPIC,
    ownerAmlData,
    "",
    0,
  );

  await identityRegistry.registerIdentity(
    owner.address,
    ownerIdentityAddress,
    0,
  );
  await attest(kycIssuer, owner, ownerIdentityAddress, REGISTRY_KYC_TOPIC);
  await attest(amlIssuer, owner, ownerIdentityAddress, REGISTRY_AML_TOPIC);

  // Deploy GovernanceToken
  const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
  governanceToken = await GovernanceToken.deploy(
    "Vanguard Governance Token",
    "VGT",
    await identityRegistry.getAddress(),
    await complianceRules.getAddress(),
  );
  await governanceToken.waitForDeployment();

  // Configure ComplianceRules to use IdentityRegistry for this token
  await complianceRules.setTokenIdentityRegistry(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(),
  );

  // Deploy VanguardGovernance
  const VanguardGovernance =
    await ethers.getContractFactory("VanguardGovernance");
  vanguardGovernance = await VanguardGovernance.deploy(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(), // IdentityRegistry (for KYC/AML verification)
    ethers.ZeroAddress, // InvestorTypeRegistry
    await complianceRules.getAddress(),
    ethers.ZeroAddress, // OracleManager
    ethers.ZeroAddress, // Token
    1, // timeScale: mainnet schedule
  );
  await vanguardGovernance.waitForDeployment();

  // Set VanguardGovernance as agent
  await governanceToken.addAgent(await vanguardGovernance.getAddress());

  // Set VanguardGovernance as VGT's rule administrator (per token, 4.1)
  const govA = await vanguardGovernance.getAddress();
  const vgtA = governanceToken.target;
  await complianceRules.setRuleAdministrator(vgtA, govA, true);

  // Configure ComplianceRules with IdentityRegistry for GovernanceToken
  await complianceRules.setTokenIdentityRegistry(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(),
  );

  // D21: governance holds VGT fees as a trusted contract, not an identity.
  await complianceRules.addTrustedContract(vgtA, govA);

  // Setup identities for voters (owner already set up earlier)
  await setupIdentity(voter1);
  await setupIdentity(voter2);
  await setupIdentity(voter3);
  // Voters must be older than minVoterAge before they propose (D25).
  await ageVoters(vanguardGovernance);

  async function setupIdentity(signer: SignerWithAddress) {
    // Create OnchainID
    const salt = ethers.randomBytes(32);
    await onchainIDFactory
      .connect(signer)
      .deployOnchainID(signer.address, salt);
    const identityAddress = await onchainIDFactory.getIdentityByOwner(
      signer.address,
    );

    // Issue KYC claim
    const kycData = ethers.hexlify(ethers.toUtf8Bytes("KYC_APPROVED"));
    await issueSigned(
      kycIssuer,
      owner,
      identityAddress,
      KYC_TOPIC,
      kycData,
      "",
      0,
    );

    // Issue AML claim
    const amlData = ethers.hexlify(ethers.toUtf8Bytes("AML_APPROVED"));
    await issueSigned(
      amlIssuer,
      owner,
      identityAddress,
      AML_TOPIC,
      amlData,
      "",
      0,
    );

    // Register in IdentityRegistry
    await identityRegistry.registerIdentity(signer.address, identityAddress, 0);
    await attest(kycIssuer, owner, identityAddress, REGISTRY_KYC_TOPIC);
    await attest(amlIssuer, owner, identityAddress, REGISTRY_AML_TOPIC);
  }
  return {
    governanceToken,
    vanguardGovernance,
    identityRegistry,
    complianceRules,
    onchainIDFactory,
    kycIssuer,
    amlIssuer,
    owner,
    voter1,
    voter2,
    voter3,
    nonVoter,
  };
}
