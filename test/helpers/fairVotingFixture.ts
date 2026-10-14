// The Fair Voting System suite's shared setup (Task 5.4 split
// FairVotingSystem.test.ts into FairVoting{Costs,Tokens,Workflow,
// Handover}.test.ts): the governance stack with five verified voters
// holding VGT, deployed once per file by its `before` (the single file
// deployed it once and ran its blocks in sequence; a file whose tests
// start from an earlier block's state seeds it, see seedFirstTwoProposals).
import { ethers } from "hardhat";
import { ageVoters } from "./governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  GovernanceToken,
  VanguardGovernance,
  IdentityRegistry,
  ComplianceRules,
  ClaimIssuer,
  InvestorTypeRegistry,
} from "../../typechain-types";
import { attest, configureKyc, issueSigned } from "./kyc";

export const PROPOSAL_CREATION_COST = ethers.parseEther("10"); // 10 VGT (contract default)
export const VOTING_COST = ethers.parseEther("10"); // 10 VGT

// Helper function to create InvestorTypeConfig
export const createInvestorTypeConfig = (
  maxTransfer: string,
  maxHolding: string,
) => ({
  maxTransferAmount: ethers.parseEther(maxTransfer),
  maxHoldingAmount: ethers.parseEther(maxHolding),
  requiredWhitelistTier: 1,
  transferCooldownMinutes: 0,
  largeTransferThreshold: ethers.parseEther("5000"),
  enhancedLogging: false,
  enhancedPrivacy: false,
});

/**
 * Complete an Ownable2Step handover on behalf of a CONTRACT nominee.
 *
 * VanguardGovernance has no dedicated entry point for acceptOwnership — its
 * only external-call path is executeProposal — so in setup we impersonate it
 * and call acceptOwnership directly. The genuine governance-vote route is
 * proven separately in "Governance ownership handover".
 */
async function impersonateAndAccept(
  contractAddress: string,
  target: InvestorTypeRegistry,
): Promise<void> {
  await ethers.provider.send("hardhat_impersonateAccount", [contractAddress]);
  await ethers.provider.send("hardhat_setBalance", [
    contractAddress,
    "0x1000000000000000000",
  ]);
  const asContract = await ethers.getSigner(contractAddress);
  await target.connect(asContract).acceptOwnership();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [
    contractAddress,
  ]);
}

export async function deployFairVoting() {
  let governanceToken: GovernanceToken;
  let vanguardGovernance: VanguardGovernance;
  let identityRegistry: IdentityRegistry;
  let complianceRules: ComplianceRules;
  let claimIssuer: ClaimIssuer;
  let investorTypeRegistry: InvestorTypeRegistry;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;
  let unverified: SignerWithAddress;

  [owner, alice, bob, carol, dave, unverified] = await ethers.getSigners();

  // Deploy ClaimIssuer
  const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
  claimIssuer = await ClaimIssuer.deploy(
    owner.address,
    "KYC Service",
    "KYC verification service",
  );
  await claimIssuer.waitForDeployment();

  // Deploy IdentityRegistry
  const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
  identityRegistry = await IdentityRegistry.deploy();
  await identityRegistry.waitForDeployment();
  await configureKyc(identityRegistry, await claimIssuer.getAddress());

  // Deploy ComplianceRules
  const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
  complianceRules = await ComplianceRules.deploy(
    owner.address,
    [], // Empty allowed list = all countries allowed (except blocked)
    [], // No blocked countries
  );
  await complianceRules.waitForDeployment();

  // Deploy GovernanceToken
  const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
  governanceToken = await GovernanceToken.deploy(
    "Vanguard Governance Token",
    "VGT",
    await identityRegistry.getAddress(),
    await complianceRules.getAddress(),
  );
  await governanceToken.waitForDeployment();

  // Deploy InvestorTypeRegistry
  const InvestorTypeRegistry = await ethers.getContractFactory(
    "InvestorTypeRegistry",
  );
  investorTypeRegistry = await InvestorTypeRegistry.deploy();
  await investorTypeRegistry.waitForDeployment();

  // Transfer ownership of InvestorTypeRegistry to VanguardGovernance (so proposals can execute)
  // We'll do this after VanguardGovernance is deployed

  // Deploy VanguardGovernance
  const VanguardGovernance =
    await ethers.getContractFactory("VanguardGovernance");
  vanguardGovernance = await VanguardGovernance.deploy(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(),
    await investorTypeRegistry.getAddress(),
    await complianceRules.getAddress(),
    ethers.ZeroAddress, // Oracle manager
    await governanceToken.getAddress(), // Token
    1, // timeScale: mainnet schedule
  );
  await vanguardGovernance.waitForDeployment();

  // Set VanguardGovernance as agent for GovernanceToken
  await governanceToken.addAgent(await vanguardGovernance.getAddress());

  // Link ComplianceRules to IdentityRegistry for the token
  await complianceRules.setTokenIdentityRegistry(
    await governanceToken.getAddress(),
    await identityRegistry.getAddress(),
  );

  // Hand InvestorTypeRegistry to VanguardGovernance so proposals can
  // execute updateInvestorTypeConfig.
  //
  // The registry is Ownable2Step: transferOwnership only NOMINATES, and
  // ownership does not move until the nominee calls acceptOwnership.
  // VanguardGovernance can only make external calls via executeProposal,
  // so acceptance is exercised end-to-end in the dedicated test below;
  // here the transfer is completed directly to keep this setup focused
  // on voting behaviour.
  await investorTypeRegistry.transferOwnership(
    await vanguardGovernance.getAddress(),
  );
  await impersonateAndAccept(
    await vanguardGovernance.getAddress(),
    investorTypeRegistry,
  );

  // Deploy OnchainIDFactory
  const OnchainIDFactory = await ethers.getContractFactory("OnchainIDFactory");
  const onchainIDFactory = await OnchainIDFactory.deploy(
    owner.address,
    ethers.ZeroHash,
  );
  await onchainIDFactory.waitForDeployment();

  // Setup identities for Owner, Alice, Bob, Carol, Dave
  const setupIdentity = async (signer: SignerWithAddress) => {
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
    const validTo = 0; // No expiration

    await issueSigned(
      claimIssuer,
      owner,
      identityAddress,
      1, // KYC topic
      kycData,
      "", // URI
      validTo,
    );

    // Register identity in IdentityRegistry
    await identityRegistry.registerIdentity(signer.address, identityAddress, 0);
    // Registration alone no longer verifies: attest the topic the
    // registry actually requires (plan Task 1R.2).
    await attest(claimIssuer, owner, identityAddress);

    return identityAddress;
  };

  // Setup owner first (needed for token transfers)
  await setupIdentity(owner);
  await setupIdentity(alice);
  await setupIdentity(bob);
  await setupIdentity(carol);
  await setupIdentity(dave);

  // D21: governance holds VGT fees as a trusted contract, not an identity.
  await complianceRules.addTrustedContract(
    await governanceToken.getAddress(),
    await vanguardGovernance.getAddress(),
  );

  // Owner already has 1M tokens from constructor mint
  // Distribute VGT tokens to users (compliance-checked transfers)
  // Alice: 50,000 VGT (enough for proposal + votes)
  // Bob: 1,000 VGT (enough for votes)
  // Carol: 500 VGT (enough for votes)
  // Dave: 100 VGT (enough for votes)
  await governanceToken.transfer(alice.address, ethers.parseEther("50000"));
  await governanceToken.transfer(bob.address, ethers.parseEther("1000"));
  await governanceToken.transfer(carol.address, ethers.parseEther("500"));
  await governanceToken.transfer(dave.address, ethers.parseEther("100")); // Enough for voting (10 VGT) but we'll use unverified for proposal test

  // Approve VanguardGovernance to spend tokens
  await governanceToken
    .connect(alice)
    .approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
  await governanceToken
    .connect(bob)
    .approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
  await governanceToken
    .connect(carol)
    .approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
  await governanceToken
    .connect(dave)
    .approve(await vanguardGovernance.getAddress(), ethers.MaxUint256);
  // Voters must be older than minVoterAge before they propose (D25).
  await ageVoters(vanguardGovernance);
  return {
    governanceToken,
    vanguardGovernance,
    identityRegistry,
    complianceRules,
    claimIssuer,
    investorTypeRegistry,
    owner,
    alice,
    bob,
    carol,
    dave,
    unverified,
  };
}

/**
 * The chain state FairVotingCosts.test.ts leaves behind, for a file
 * whose tests start from it (they hard-code proposal ids): proposal 1
 * (alice, normal-investor limits) and proposal 2 (alice, retail limits;
 * bob and carol FOR, dave AGAINST), the calls the single file's
 * "Proposal Creation with Cost" and "Fair Voting" blocks made.
 */
export async function seedFirstTwoProposals(f: {
  vanguardGovernance: VanguardGovernance;
  investorTypeRegistry: InvestorTypeRegistry;
  alice: SignerWithAddress;
  bob: SignerWithAddress;
  carol: SignerWithAddress;
  dave: SignerWithAddress;
}): Promise<void> {
  const { vanguardGovernance, investorTypeRegistry, alice, bob, carol, dave } =
    f;
  const target = await investorTypeRegistry.getAddress();
  const update = (type: number, max: string, hold: string) =>
    investorTypeRegistry.interface.encodeFunctionData(
      "updateInvestorTypeConfig",
      [type, createInvestorTypeConfig(max, hold)],
    );
  await vanguardGovernance
    .connect(alice)
    .createProposal(
      0,
      "Update Normal Investor Limits",
      "Increase limits for normal investors",
      target,
      update(0, "10000", "100000"),
    );
  await vanguardGovernance
    .connect(alice)
    .createProposal(
      0,
      "Update Retail Investor Limits",
      "Increase limits for retail investors",
      target,
      update(1, "5000", "50000"),
    );
  await vanguardGovernance.connect(bob).castVote(2, true, "I support this");
  await vanguardGovernance
    .connect(carol)
    .castVote(2, true, "I support this too");
  await vanguardGovernance.connect(dave).castVote(2, false, "I oppose this");
}
