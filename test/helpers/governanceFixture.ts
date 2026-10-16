import { artifacts, ethers } from "hardhat";
import { addRegistrar } from "./registrars";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { attest, configureKyc, deployIdentity } from "./kyc";
import { bindEngine } from "./oracles";

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
 * factory's fee wallet 8. Both factories (2F.5) and both privacy
 * contracts (3.3: a real-mode ZKVerifierIntegrated and the PrivacyManager
 * using it) are in the plan, unbound until the ceremony binds them; the
 * factory pins a KeyManager, the investor-type registry is live on VSC
 * and custody is deployed (Task 4.16, W-2). Shared by the handover
 * preflight, completion and CLI tests.
 */
export async function handoverFixture({
  recordGovernanceToken = true,
  // Task 5.13: custody's bank when ops is a contract (a multisig), with
  // the step that makes it accept the manager's ownership.
  bank = undefined as
    undefined | { address: string; accept: (m: any) => Promise<void> },
} = {}) {
  const signers = await ethers.getSigners();
  const [deployer, ops, guardian, stranger, alice, bob, carol, issuerAdmin] =
    signers;
  const feeWallet = signers[8];
  const deploy = async (name: string, ...a: any[]): Promise<any> =>
    (await ethers.getContractFactory(name)).deploy(...a);
  // As demo option 1 records deployStartBlock: the ceremony's event scans
  // start at the fixture's first deploy, not at block 0, so they do not
  // grow with the chain history of every test run before this one.
  const fromBlock = (await ethers.provider.getBlockNumber()) + 1;

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
  await bindEngine(oracleManager); // Task 4.4: the ceremony refuses none
  const kycIssuer = await deploy(
    "ClaimIssuer",
    deployer.address,
    "KYC Issuer",
    "KYC",
  );
  await configureKyc(identityRegistry, await kycIssuer.getAddress());
  // Task 4.11 (R-411-19): the factory accepts only the compiled KeyManager;
  // Task 4.16 (W-2): as the demo deploys, it pins that KeyManager on every
  // identity it creates (the ceremony derives the KeyManager from the pin).
  const kmHash = ethers.keccak256(
    (await artifacts.readArtifact("KeyManager")).deployedBytecode,
  );
  const factory = await deploy("OnchainIDFactory", deployer.address, kmHash);
  const keyManager = await deploy("KeyManager");
  await factory.setRecoveryManager(await keyManager.getAddress());
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
  const zkVerifier = await deploy("ZKVerifierIntegrated", false);
  const privacyManager = await deploy(
    "PrivacyManager",
    await zkVerifier.getAddress(),
  );
  // Task 3.8: the private jurisdiction policy is VSC's rule (the ceremony
  // refuses another source).
  await privacyManager.setPolicyToken(await token.getAddress());
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
  await complianceRules.addTrustedContract(vgtAddr, govAddr);
  if (recordGovernanceToken) await complianceRules.setGovernanceToken(vgtAddr); // D33 b
  // As the demo deploys (Task 4.13 parity): both tokens are registry
  // agents (recoveryAddress calls moveIdentity, W-1), the registry reads
  // the rules for jurisdiction checks, VSC's identity registry is wired.
  for (const t of [await token.getAddress(), vgtAddr])
    await identityRegistry.addAgent(t);
  await identityRegistry.setComplianceRules(
    rulesAddr,
    await token.getAddress(),
  );
  await complianceRules.setTokenIdentityRegistry(
    await token.getAddress(),
    idRegAddr,
  );
  // As the demo deploys: the escrow factory trusts its escrows (Task 4.3).
  await addRegistrar(
    complianceRules,
    token,
    escrowWalletFactory,
    "MultiSigEscrowWallet",
  );
  // As the demo deploys: the deployer administers both tokens' rules (G5).
  for (const t of [await token.getAddress(), vgtAddr])
    await complianceRules.setRuleAdministrator(t, deployer.address, true);
  // Task 4.16 (W-2): as options 21/51 deploy, the investor-type registry is
  // live on VSC and authorizes it (Task 4.10), and custody exists: the
  // InvestorRequestManager (bank = ops) is VSC's registrar for the
  // MultiSigWallet code hash, a compliance officer, owned by ops.
  await investorTypeRegistry.authorizeToken(await token.getAddress(), true);
  await token.setInvestorTypeRegistry(await investorTypeRegistry.getAddress());
  const custody = await deploy(
    "InvestorRequestManager",
    bank ? bank.address : ops.address,
    await token.getAddress(),
    await investorTypeRegistry.getAddress(),
    idRegAddr,
  );
  await addRegistrar(complianceRules, token, custody, "MultiSigWallet");
  await investorTypeRegistry.setComplianceOfficer(
    await custody.getAddress(),
    true,
  );
  // Task 5.1 (Q7): the manager is Ownable2Step; ops accepts.
  await custody.transferOwnership(bank ? bank.address : ops.address);
  if (bank) await bank.accept(custody);
  else await custody.connect(ops).acceptOwnership();
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
    privacyManager,
    zkVerifier,
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
    // The escrow factory's fee wallet, acknowledged (Task 4.17, D54).
    feeWallets: [feeWallet.address],
    fromBlock,
    log: () => {},
  };
  const who = {
    deployer,
    ops,
    guardian,
    stranger,
    proposer: alice,
    issuerAdmin,
    feeWallet,
  };
  return {
    ...who,
    voters: [bob, carol],
    c,
    args,
    govAddr,
    factory,
    kycIssuer,
    keyManager,
    custody,
  };
}

// owner(): a harmless call. createProposal refuses calldata under 4 bytes
// (plan 2F.1 selector check), so "0x" is no longer a valid no-op.
export const NOOP = "0x8da5cb5b";

/**
 * Hardening round 2 governance (Task 5.4 moved it here from
 * HardeningRound2.test.ts, now split in three): VanguardGovernance over
 * VGT with a ComplianceRegistry, four verified holders (owner, alice, bob,
 * carol; 1,000 VGT and an unlimited governance allowance each but the
 * owner) and voters aged past minVoterAge.
 */
export async function govFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const ir = await (
    await ethers.getContractFactory("IdentityRegistry")
  ).deploy();
  const cr = await (
    await ethers.getContractFactory("ComplianceRegistry")
  ).deploy();
  const gt = await (
    await ethers.getContractFactory("GovernanceToken")
  ).deploy("VGT", "VGT", await ir.getAddress(), await cr.getAddress());
  const gov = await (
    await ethers.getContractFactory("VanguardGovernance")
  ).deploy(
    await gt.getAddress(),
    await ir.getAddress(),
    owner.address,
    owner.address,
    owner.address,
    owner.address,
    1,
  );
  const govAddr = await gov.getAddress();
  await gt.addAgent(govAddr);

  const kycIssuer = await (
    await ethers.getContractFactory("ClaimIssuer")
  ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
  await configureKyc(ir, await kycIssuer.getAddress());

  const OID = await ethers.getContractFactory("OnchainID");
  const ids: Record<string, string> = {};
  const named: [string, string][] = [
    ["owner", owner.address],
    ["alice", alice.address],
    ["bob", bob.address],
    ["carol", carol.address],
  ];
  // D21: governance holds VGT fees as a trusted contract, never an identity.
  await cr.setTrusted(govAddr, true);
  for (const [key, addr] of named) {
    const id = await (await OID.deploy(addr)).getAddress();
    await ir.registerIdentity(addr, id, 840);
    await attest(kycIssuer, owner, id);
    ids[key] = id;
  }
  for (const s of [alice, bob, carol]) {
    await gt.transfer(s.address, ethers.parseEther("1000"));
    await gt.connect(s).approve(govAddr, ethers.MaxUint256);
  }
  // Voters must be older than minVoterAge before they propose (D25).
  await ageVoters(gov);
  return {
    owner,
    alice,
    bob,
    carol,
    ir,
    cr,
    gt,
    gov,
    govAddr,
    kycIssuer,
    ids,
  };
}
