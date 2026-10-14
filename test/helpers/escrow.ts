import { ethers } from "hardhat";
import { attest, configureKyc } from "./kyc";
import { addRegistrar } from "./registrars";

/** The escrow wallet's dispute window (14 days), in seconds. */
export const DISPUTE_WINDOW = 14 * 24 * 3600;
export const AMOUNT = ethers.parseEther("1000");
export const DATA = "shipped";

/**
 * The escrow stack (as test/helpers/escrowFixture.js builds it): a mock
 * VSC, a KYC-gated registry with payer and payee verified,
 * ComplianceRules, the factory as a registrar for the escrow code hash and
 * `investor` registered. The payer holds 10,000 VSC.
 */
export async function deployEscrow() {
  const [owner, investor, payer, payee, investorWallet, ownerWallet, stranger] =
    await ethers.getSigners();
  const deployC = async (name: string, ...a: unknown[]) =>
    (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
  const vsc = await deployC(
    "MockToken",
    "VSC",
    "VSC",
    ethers.parseEther("1000000"),
  );
  const registry = await deployC("IdentityRegistry");
  const rules = await deployC("ComplianceRules", owner.address, [840], []);
  const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
  await configureKyc(registry, await issuer.getAddress());
  for (const w of [payer, payee]) {
    const id = await deployC("OnchainID", w.address);
    await registry.registerIdentity(w.address, id.target, 840);
    await attest(issuer, owner, id.target as string);
  }
  const factory = await deployC(
    "EscrowWalletFactory",
    vsc.target,
    ownerWallet.address,
    registry.target,
    rules.target,
  );
  await addRegistrar(rules, vsc, factory, "MultiSigEscrowWallet");
  await factory.registerInvestor(investor.address, investorWallet.address);
  await vsc.transfer(payer.address, ethers.parseEther("10000"));
  return {
    owner,
    investor,
    payer,
    payee,
    investorWallet,
    ownerWallet,
    stranger,
    vsc,
    registry,
    rules,
    factory,
    deployC,
  };
}

/** The investor's escrow for `payer` (address(0): marketplace) and payee. */
export async function newEscrow(f: any, payer: string = f.payer.address) {
  const id = await f.factory
    .connect(f.investor)
    .createEscrowWallet.staticCall(payer, f.payee.address, AMOUNT);
  await f.factory
    .connect(f.investor)
    .createEscrowWallet(payer, f.payee.address, AMOUNT);
  const addr = await f.factory.getWalletAddress(id[0]);
  const wallet = await ethers.getContractAt("MultiSigEscrowWallet", addr);
  return { id: id[0] as bigint, wallet };
}

/** The payer approves and funds escrow `id` through the factory. */
export async function fund(f: any, id: bigint, wallet: any) {
  const total =
    (await wallet.amount()) +
    (await wallet.investorFee()) +
    (await wallet.ownerFee());
  await f.vsc.connect(f.payer).approve(f.factory.target, total);
  await f.factory.connect(f.payer).fundEscrowWallet(id);
}

/** The payee's shipment proof, signed for this escrow and chain. */
export async function shipProof(f: any, wallet: any) {
  const dataHash = ethers.id(DATA);
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "uint256", "bytes32"],
      ["VanguardShipmentProof", wallet.target, chainId, dataHash],
    ),
  );
  const sig = await f.payee.signMessage(ethers.getBytes(digest));
  await wallet.connect(f.payee).submitShipmentProof(DATA, dataHash, sig);
  return { dataHash, sig };
}
