// The Investor Onboarding suite's shared setup (Task 5.4 split
// InvestorOnboarding.test.ts into Investor{WalletAndRequests,
// OnboardingWorkflow,Custody}.test.ts): the lock amounts, idOf, and the
// onboarding stack (identity registry with KYC and AML issuers, rules,
// token, investor-type registry, request manager) deployed per test.
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MultiSigWallet,
  InvestorRequestManager,
  InvestorTypeRegistry,
  IdentityRegistry,
  Token,
  ComplianceRules,
  OnchainID,
  ClaimIssuer,
} from "../../typechain-types";
import {
  attest,
  configureKyc,
  KYC_TOPIC as REGISTRY_KYC_TOPIC,
  AML_TOPIC as REGISTRY_AML_TOPIC,
  issueSigned,
} from "./kyc";
import { addRegistrar } from "./registrars";

export const RETAIL_LOCK = ethers.parseEther("2000"); // Manager default: Normal cap / 4
export const ACCREDITED_LOCK = ethers.parseEther("4000"); // Manager default: Normal cap / 2
export const INSTITUTIONAL_LOCK = ethers.parseEther("8000"); // Manager default: the Normal cap

/** The UnlockProposalCreated id of a proposeUnlock transaction. */
export async function idOf(wallet: MultiSigWallet, tx: Promise<any>) {
  const receipt = await (await tx).wait();
  for (const log of receipt.logs) {
    const parsed = wallet.interface.parseLog(log);
    if (parsed?.name === "UnlockProposalCreated") return parsed.args[0];
  }
  throw new Error("no UnlockProposalCreated");
}

export async function deployOnboarding() {
  let investorRequestManager: InvestorRequestManager;
  let investorTypeRegistry: InvestorTypeRegistry;
  let identityRegistry: IdentityRegistry;
  let token: Token;
  let rules: ComplianceRules;
  let onchainID: OnchainID;
  let kycIssuer: ClaimIssuer;
  let amlIssuer: ClaimIssuer;

  let owner: SignerWithAddress;
  let bank: SignerWithAddress;
  let user: SignerWithAddress;
  let otherUser: SignerWithAddress;

  [owner, bank, user, otherUser] = await ethers.getSigners();

  // Deploy OnchainID system
  const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
  onchainID = await OnchainIDFactory.deploy(user.address);
  await onchainID.waitForDeployment();

  // Deploy ClaimIssuers
  const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
  kycIssuer = await ClaimIssuerFactory.deploy(
    owner.address,
    "KYC Issuer",
    "Know Your Customer verification service",
  );
  await kycIssuer.waitForDeployment();

  amlIssuer = await ClaimIssuerFactory.deploy(
    owner.address,
    "AML Issuer",
    "Anti-Money Laundering verification service",
  );
  await amlIssuer.waitForDeployment();

  // Deploy IdentityRegistry
  const IdentityRegistryFactory =
    await ethers.getContractFactory("IdentityRegistry");
  identityRegistry = await IdentityRegistryFactory.deploy();
  await identityRegistry.waitForDeployment();
  // Registration alone no longer verifies (plan Task 1R.2): require
  // both the KYC and AML topics this fixture already issues claims for.
  await configureKyc(
    identityRegistry,
    await kycIssuer.getAddress(),
    await amlIssuer.getAddress(),
  );

  // Deploy InvestorTypeRegistry
  const InvestorTypeRegistryFactory = await ethers.getContractFactory(
    "InvestorTypeRegistry",
  );
  investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
  await investorTypeRegistry.waitForDeployment();

  // Real ComplianceRules (Task 4.3): the MultiSigWallet holds tokens as a
  // contract trusted on this token, registered by the manager at creation.
  rules = await (
    await ethers.getContractFactory("ComplianceRules")
  ).deploy(owner.address, [], []);
  await rules.waitForDeployment();

  // Deploy Token
  const TokenFactory = await ethers.getContractFactory("Token");
  token = await TokenFactory.deploy(
    "Test Token",
    "TEST",
    await identityRegistry.getAddress(),
    await rules.getAddress(),
  );
  await token.waitForDeployment();
  await rules.setTokenIdentityRegistry(
    await token.getAddress(),
    await identityRegistry.getAddress(),
  );

  // Set InvestorTypeRegistry on token
  await token.setInvestorTypeRegistry(await investorTypeRegistry.getAddress());
  // Task 4.10: a registry refuses every move until it authorizes the token.
  await investorTypeRegistry.authorizeToken(await token.getAddress(), true);

  // Register user identity
  await identityRegistry.addAgent(owner.address);
  await identityRegistry.registerIdentity(
    user.address,
    await onchainID.getAddress(),
    840, // US
  );

  // Issue KYC and AML claims
  await issueSigned(
    kycIssuer,
    owner,
    await onchainID.getAddress(),
    1, // KYC topic
    ethers.toUtf8Bytes("KYC verified"),
    "",
    0,
  );

  await issueSigned(
    amlIssuer,
    owner,
    await onchainID.getAddress(),
    2, // AML topic
    ethers.toUtf8Bytes("AML verified"),
    "",
    0,
  );
  await attest(
    kycIssuer,
    owner,
    await onchainID.getAddress(),
    REGISTRY_KYC_TOPIC,
  );
  await attest(
    amlIssuer,
    owner,
    await onchainID.getAddress(),
    REGISTRY_AML_TOPIC,
  );

  // Deploy InvestorRequestManager
  const InvestorRequestManagerFactory = await ethers.getContractFactory(
    "InvestorRequestManager",
  );
  investorRequestManager = await InvestorRequestManagerFactory.deploy(
    bank.address,
    await token.getAddress(),
    await investorTypeRegistry.getAddress(),
    await identityRegistry.getAddress(),
  );
  await investorRequestManager.waitForDeployment();
  // The manager trusts each MultiSigWallet it creates on this token.
  await addRegistrar(rules, token, investorRequestManager, "MultiSigWallet");

  // Authorize InvestorRequestManager as compliance officer
  await investorTypeRegistry.setComplianceOfficer(
    await investorRequestManager.getAddress(),
    true,
  );

  // Update investor type configs to allow higher transfer amounts for testing
  await investorTypeRegistry.updateInvestorTypeConfig(0, {
    // Normal
    maxTransferAmount: ethers.parseEther("1000000"),
    maxHoldingAmount: ethers.parseEther("5000000"),
    requiredWhitelistTier: 1,
    transferCooldownMinutes: 60,
    largeTransferThreshold: ethers.parseEther("100000"),
    enhancedLogging: false,
    enhancedPrivacy: false,
  });

  await investorTypeRegistry.updateInvestorTypeConfig(1, {
    // Retail
    maxTransferAmount: ethers.parseEther("1000000"),
    maxHoldingAmount: ethers.parseEther("5000000"),
    requiredWhitelistTier: 2,
    transferCooldownMinutes: 60,
    largeTransferThreshold: ethers.parseEther("100000"),
    enhancedLogging: false,
    enhancedPrivacy: false,
  });

  await investorTypeRegistry.updateInvestorTypeConfig(2, {
    // Accredited
    maxTransferAmount: ethers.parseEther("1000000"),
    maxHoldingAmount: ethers.parseEther("5000000"),
    requiredWhitelistTier: 3,
    transferCooldownMinutes: 30,
    largeTransferThreshold: ethers.parseEther("100000"),
    enhancedLogging: true,
    enhancedPrivacy: true,
  });

  // Mint tokens to user
  await token.addAgent(owner.address);
  await token.mint(user.address, ethers.parseEther("2000000"));
  return {
    investorRequestManager,
    investorTypeRegistry,
    identityRegistry,
    token,
    rules,
    onchainID,
    kycIssuer,
    amlIssuer,
    owner,
    bank,
    user,
    otherUser,
  };
}
