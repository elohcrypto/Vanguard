// The Enhanced Escrow System suite's shared setup (Task 5.4 split
// EnhancedEscrow.test.js into test/payment/Escrow*.test.js): the fee
// constants, the scoped shipment-proof signer, and the deployment every
// test starts from (VSC, registry, rules, KYC issuer, two identities, a
// factory trusted on VSC, 10,000 VSC on the payer), run per test.
const { ethers } = require("hardhat");
const { attest, configureKyc } = require("./kyc");
const { addRegistrar } = require("./registrars");

const INITIAL_SUPPLY = ethers.parseEther("1000000");
const PAYMENT_AMOUNT = ethers.parseEther("1000");
const INVESTOR_FEE = ethers.parseEther("30"); // 3%
const OWNER_FEE = ethers.parseEther("20"); // 2%
const TOTAL_AMOUNT = ethers.parseEther("1050"); // 1000 + 30 + 20
const UNAUTH = "AccessControlUnauthorizedAccount"; // OZ AccessControl

// A shipment proof is bound to the escrow address, the chain and the data.
// Signing the bare dataHash is no longer accepted: an unscoped signature
// was replayable across escrows and chains.
async function signProof(signer, walletAddress, dataHash) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "uint256", "bytes32"],
      ["VanguardShipmentProof", walletAddress, chainId, dataHash],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function deployEscrowSystem() {
  let vscToken;
  let factory;
  let identityRegistry;
  let complianceRules;
  let kycIssuer;
  let payerIdentity, payeeIdentity;
  let owner, investor, payer, payee, investorWallet, ownerWallet;
  let signers;

  signers = await ethers.getSigners();
  [owner, investor, payer, payee, investorWallet, ownerWallet] = signers;

  // Deploy mock VSC token
  const MockToken = await ethers.getContractFactory("MockToken");
  vscToken = await MockToken.deploy(
    "VanguardStableCoin",
    "VSC",
    INITIAL_SUPPLY,
  );
  await vscToken.waitForDeployment();

  // Deploy IdentityRegistry for KYC/AML compliance
  const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
  identityRegistry = await IdentityRegistry.deploy();
  await identityRegistry.waitForDeployment();

  // Deploy ComplianceRules
  const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
  complianceRules = await ComplianceRules.deploy(
    owner.address,
    [840, 826, 756], // Allowed countries: USA, UK, Switzerland
    [], // No blocked countries
  );
  await complianceRules.waitForDeployment();

  // Deploy OnchainID for payer and payee
  const OnchainID = await ethers.getContractFactory("OnchainID");
  payerIdentity = await OnchainID.deploy(payer.address);
  await payerIdentity.waitForDeployment();

  payeeIdentity = await OnchainID.deploy(payee.address);
  await payeeIdentity.waitForDeployment();

  // Deploy a KYC issuer and require its claim topic on the registry so
  // registration alone no longer verifies a wallet (plan Task 1R.2).
  const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
  kycIssuer = await ClaimIssuer.deploy(
    owner.address,
    "KYC Issuer",
    "Trusted KYC attestations",
  );
  await kycIssuer.waitForDeployment();
  await configureKyc(identityRegistry, await kycIssuer.getAddress());

  // Register payer and payee in IdentityRegistry (KYC/AML verified)
  await identityRegistry.registerIdentity(
    payer.address,
    await payerIdentity.getAddress(),
    840, // USA country code
  );
  await attest(kycIssuer, owner, await payerIdentity.getAddress());

  await identityRegistry.registerIdentity(
    payee.address,
    await payeeIdentity.getAddress(),
    840, // USA country code
  );
  await attest(kycIssuer, owner, await payeeIdentity.getAddress());

  // Deploy EscrowWalletFactory with IdentityRegistry and ComplianceRules
  const EscrowWalletFactory = await ethers.getContractFactory(
    "EscrowWalletFactory",
  );
  factory = await EscrowWalletFactory.deploy(
    await vscToken.getAddress(),
    ownerWallet.address,
    await identityRegistry.getAddress(),
    await complianceRules.getAddress(),
  );
  await factory.waitForDeployment();
  // The factory trusts each escrow it creates on VSC (Task 4.3).
  await addRegistrar(
    complianceRules,
    vscToken,
    factory,
    "MultiSigEscrowWallet",
  );

  // Transfer tokens to payer
  await vscToken.transfer(payer.address, ethers.parseEther("10000"));
  return {
    vscToken,
    factory,
    identityRegistry,
    complianceRules,
    kycIssuer,
    payerIdentity,
    payeeIdentity,
    owner,
    investor,
    payer,
    payee,
    investorWallet,
    ownerWallet,
    signers,
  };
}

module.exports = {
  INITIAL_SUPPLY,
  PAYMENT_AMOUNT,
  INVESTOR_FEE,
  OWNER_FEE,
  TOTAL_AMOUNT,
  UNAUTH,
  signProof,
  deployEscrowSystem,
};
