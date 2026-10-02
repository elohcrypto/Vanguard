import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc, deployIdentity } from "./kyc";

/**
 * Advance the chain past `governance.minVoterAge()` so every identity
 * registered so far may propose and vote (plan 2F.1, D25: only identities
 * at least minVoterAge old at proposal creation vote). Call after
 * onboarding voters and before the first proposal.
 */
export async function ageVoters(governance: any): Promise<void> {
  await time.increase((await governance.minVoterAge()) + 1n);
}

/**
 * A full governance system as the handover ceremony finds it: the deployer
 * owns and administers everything, governance is bound to every contract
 * (InvestorTypeRegistry and DynamicListManager included), trusted and has no
 * identity; three verified VGT holders (proposer + two voters), aged past
 * the minimum voter age.
 *
 * Signer order: deployer 0, ops 1, guardian 2, stranger 3, alice 4 (the
 * proposer), bob 5 and carol 6 (the voters), issuerAdmin 7, the escrow
 * factory's fee wallet 8. Both factories are in the plan (2F.5), unbound
 * until the ceremony binds them. Shared by the handover preflight,
 * completion and CLI tests.
 */
export async function handoverFixture() {
  const signers = await ethers.getSigners();
  const [deployer, ops, guardian, stranger, alice, bob, carol, issuerAdmin] =
    signers;
  const feeWallet = signers[8];
  const deploy = async (name: string, ...a: any[]): Promise<any> =>
    (await ethers.getContractFactory(name)).deploy(...a);

  const identityRegistry = await deploy("IdentityRegistry");
  const complianceRules = await deploy(
    "ComplianceRules",
    deployer.address,
    [840, 344],
    [],
  );
  const idRegAddr = await identityRegistry.getAddress();
  const rulesAddr = await complianceRules.getAddress();
  const token = await deploy("Token", "VSC", "VSC", idRegAddr, rulesAddr);
  const oracleManager = await deploy("OracleManager");
  const kycIssuer = await deploy(
    "ClaimIssuer",
    deployer.address,
    "KYC Issuer",
    "KYC",
  );
  await configureKyc(identityRegistry, await kycIssuer.getAddress());
  const factory = await deploy("OnchainIDFactory", deployer.address);
  const governanceToken = await deploy(
    "GovernanceToken",
    "VGT",
    "VGT",
    idRegAddr,
    rulesAddr,
  );
  const investorTypeRegistry = await deploy("InvestorTypeRegistry");
  const governance = await deploy(
    "VanguardGovernance",
    await governanceToken.getAddress(),
    idRegAddr,
    await investorTypeRegistry.getAddress(),
    rulesAddr,
    await oracleManager.getAddress(),
    await token.getAddress(),
    1440,
  );
  const govAddr: string = await governance.getAddress();
  const escrowWalletFactory = await deploy(
    "EscrowWalletFactory",
    await token.getAddress(),
    feeWallet.address,
    idRegAddr,
    rulesAddr,
  );
  const dynamicListManager = await deploy(
    "DynamicListManager",
    deployer.address,
  );
  await governance.setDynamicListManager(await dynamicListManager.getAddress());
  const whitelistOracle = await deploy(
    "WhitelistOracle",
    await oracleManager.getAddress(),
    "Whitelist",
    "KYC whitelist",
  );
  const vgtAddr = await governanceToken.getAddress();
  await governanceToken.addAgent(deployer.address);
  await governanceToken.addAgent(govAddr);
  await complianceRules.setTokenIdentityRegistry(vgtAddr, idRegAddr);
  await complianceRules.addTrustedContract(govAddr);
  for (const w of [alice, bob, carol]) {
    const id = await deployIdentity(factory, w.address);
    await identityRegistry.registerIdentity(w.address, id, 840);
    await attest(kycIssuer, deployer, id);
    await governanceToken.mint(w.address, ethers.parseEther("1000"));
  }
  // Voters are registered well before the ceremony (D25).
  await ageVoters(governance);

  const c: Record<string, any> = {
    token,
    governanceToken,
    identityRegistry,
    complianceRules,
    oracleManager,
    dynamicListManager,
    investorTypeRegistry,
    escrowWalletFactory,
    onchainIDFactory: factory,
    governance,
  };
  const args: Record<string, any> = {
    ...c,
    deployer,
    ops,
    guardian,
    issuerAdmin,
    oracles: [whitelistOracle],
    issuers: [kycIssuer],
    log: () => {},
  };
  const who: Record<string, SignerWithAddress> = {
    deployer,
    ops,
    guardian,
    stranger,
    proposer: alice,
    issuerAdmin,
    feeWallet,
  };
  return { ...who, voters: [bob, carol], c, args, govAddr, factory, kycIssuer };
}
