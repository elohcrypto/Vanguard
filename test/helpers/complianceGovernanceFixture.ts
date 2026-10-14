// The Governance -> ComplianceRules integration suite's shared setup
// (Task 5.4 split GovernanceComplianceIntegration.test.ts into
// GovernanceCompliance{Workflow,Quorum}.test.ts): VGT, governance,
// registry, rules and a token, with KYC and AML issuers, run per test;
// setupIdentity verifies one more signer on that deployment.
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

export async function deployComplianceGovernance() {
  let governanceToken: any;
  let vanguardGovernance: any;
  let identityRegistry: any;
  let complianceRules: any;
  let token: any;
  let onchainIDFactory: any;
  let kycIssuer: any;
  let amlIssuer: any;

  let owner: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let voter3: SignerWithAddress;

  [owner, voter1, voter2, voter3] = await ethers.getSigners();

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
  // Registration alone no longer verifies (plan Task 1R.2): the registry
  // requires both the KYC and AML topics it already has issuers for.
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

  // Deploy Token
  const Token = await ethers.getContractFactory("Token");
  token = await Token.deploy(
    "Vanguard Security Token",
    "VSC",
    await identityRegistry.getAddress(),
    await complianceRules.getAddress(),
  );
  await token.waitForDeployment();

  // Deploy GovernanceToken
  const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
  governanceToken = await GovernanceToken.deploy(
    "Vanguard Governance Token",
    "VGT",
    await identityRegistry.getAddress(),
    await complianceRules.getAddress(),
  );
  await governanceToken.waitForDeployment();

  // Deploy VanguardGovernance
  const VanguardGovernance =
    await ethers.getContractFactory("VanguardGovernance");
  vanguardGovernance = await VanguardGovernance.deploy(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(), // IdentityRegistry (for KYC/AML verification)
    ethers.ZeroAddress, // InvestorTypeRegistry
    await complianceRules.getAddress(),
    ethers.ZeroAddress, // OracleManager
    await token.getAddress(),
    1, // timeScale: mainnet schedule
  );
  await vanguardGovernance.waitForDeployment();

  // Set VanguardGovernance as agent for GovernanceToken
  await governanceToken.addAgent(await vanguardGovernance.getAddress());

  // Per token (Task 4.1): governance administers VSC's rules
  const govA = await vanguardGovernance.getAddress();
  await complianceRules.setRuleAdministrator(token.target, govA, true);

  // Configure ComplianceRules with IdentityRegistry for GovernanceToken
  await complianceRules.setTokenIdentityRegistry(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(),
  );

  // D21: governance holds VGT fees as a trusted contract, not an identity.
  await complianceRules.addTrustedContract(governanceToken.target, govA);

  // Setup identities for owner and voters
  await setupIdentity(owner);
  await setupIdentity(voter1);
  await setupIdentity(voter2);
  await setupIdentity(voter3);
  // Voters must be older than minVoterAge before they propose (D25).
  await ageVoters(vanguardGovernance);

  async function setupIdentity(signer: SignerWithAddress) {
    const salt = ethers.randomBytes(32);
    await onchainIDFactory
      .connect(signer)
      .deployOnchainID(signer.address, salt);
    const identityAddress = await onchainIDFactory.getIdentityByOwner(
      signer.address,
    );

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

    await identityRegistry.registerIdentity(signer.address, identityAddress, 0);
    // Attest the topics the registry actually requires (plan Task 1R.2),
    // separate from the local KYC_TOPIC/AML_TOPIC (1/2) claims above.
    await attest(kycIssuer, owner, identityAddress, REGISTRY_KYC_TOPIC);
    await attest(amlIssuer, owner, identityAddress, REGISTRY_AML_TOPIC);
  }
  return {
    governanceToken,
    vanguardGovernance,
    identityRegistry,
    complianceRules,
    token,
    onchainIDFactory,
    kycIssuer,
    amlIssuer,
    owner,
    voter1,
    voter2,
    voter3,
    setupIdentity,
  };
}
