import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { ClaimIssuer, Token } from "../typechain-types";
import {
  attest,
  configureKyc,
  deployIdentity,
  AML_TOPIC,
} from "../test/helpers/kyc";

// Task 1R.7 (plan 2026-09-25-zk-kyc-ownership-cleanup-v2, section 2.3):
// Token.transfer calls IdentityRegistry.isVerified twice, and
// ComplianceRules.canTransfer calls it twice more once a registry is
// bound. isVerified loops over required claim topics, so this measures
// transfer gas as that loop grows: 0 topics (MockIdentityRegistry, no
// topic concept), 1 (KYC), 2 (KYC+AML).

const MINT_AMOUNT = ethers.parseEther("1000");
const TRANSFER_AMOUNT = ethers.parseEther("10");
const NO_COUNTRIES: number[] = [];

interface ScenarioResult {
  name: string;
  transferGasUsed: bigint;
  isVerifiedGasEstimate: bigint;
}

/** Deploys ComplianceRules (no jurisdiction rules) + Token bound to it. */
async function deployTokenWithCompliance(
  deployer: SignerWithAddress,
  registryAddr: string,
) {
  const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
  const compliance = await ComplianceRules.deploy(deployer.address, NO_COUNTRIES, NO_COUNTRIES);
  await compliance.waitForDeployment();
  const TokenFactory = await ethers.getContractFactory("Token");
  const token = await TokenFactory.deploy(
    "Gas Analysis Token",
    "GAT",
    registryAddr,
    await compliance.getAddress(),
  );
  await token.waitForDeployment();
  return { token, compliance };
}

// Warm-up transfer, then the measured one, so both see the same storage
// warmth. Throws (script exits non-zero) if either reverts.
async function measureTransfer(
  token: Token,
  sender: SignerWithAddress,
  recipient: SignerWithAddress,
): Promise<bigint> {
  const warmup = await token.connect(sender).transfer(recipient.address, TRANSFER_AMOUNT);
  const warmupReceipt = await warmup.wait();
  if (!warmupReceipt || warmupReceipt.status !== 1) throw new Error("warm-up transfer reverted");

  const tx = await token.connect(sender).transfer(recipient.address, TRANSFER_AMOUNT);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("measured transfer reverted");
  return receipt.gasUsed;
}

/**
 * Scenario A: Token bound to MockIdentityRegistry, the permissive test
 * double — since 788b742 a real IdentityRegistry with zero required
 * topics verifies nobody, so it cannot serve as the baseline. Compliance
 * is deployed but never bound via setTokenIdentityRegistry: the mock
 * doesn't implement IIdentityRegistry.investorCountry with a matching
 * return type (uint256 vs uint16), which would revert the jurisdiction
 * check. Unbound, ComplianceRules falls back to its disabled (no oracle)
 * whitelist/blacklist gate and always allows; Token's own isVerified gate
 * still runs against the mock.
 */
async function runBaselineScenario(
  deployer: SignerWithAddress,
  sender: SignerWithAddress,
  recipient: SignerWithAddress,
): Promise<ScenarioResult> {
  const registry = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  const { token } = await deployTokenWithCompliance(deployer, registryAddr);

  await registry.registerIdentity(sender.address, sender.address, 0);
  await registry.registerIdentity(recipient.address, recipient.address, 0);
  await (await token.mint(sender.address, MINT_AMOUNT)).wait();

  const transferGasUsed = await measureTransfer(token, sender, recipient);
  const isVerifiedGasEstimate = await registry.isVerified.estimateGas(sender.address);
  return { name: "A: MockIdentityRegistry (baseline)", transferGasUsed, isVerifiedGasEstimate };
}

/**
 * Scenarios B and C: a real IdentityRegistry with `topics` required claim
 * topics (KYC only, or KYC+AML), each satisfied by a live signed claim
 * from its own trusted issuer, on a real OnchainID for both wallets.
 */
async function runClaimScenario(
  name: string,
  topics: 1 | 2,
  deployer: SignerWithAddress,
  sender: SignerWithAddress,
  recipient: SignerWithAddress,
  kycIssuerSigner: SignerWithAddress,
  amlIssuerSigner: SignerWithAddress,
): Promise<ScenarioResult> {
  const factory = await (await ethers.getContractFactory("OnchainIDFactory")).deploy(deployer.address);
  await factory.waitForDeployment();

  const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
  const kycIssuer = await ClaimIssuerFactory.deploy(kycIssuerSigner.address, "KYC Service", "KYC verification service");
  await kycIssuer.waitForDeployment();

  let amlIssuer: ClaimIssuer | null = null;
  if (topics === 2) {
    amlIssuer = await ClaimIssuerFactory.deploy(amlIssuerSigner.address, "AML Service", "AML screening service");
    await amlIssuer.waitForDeployment();
  }

  const registry = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
  await registry.waitForDeployment();
  await configureKyc(registry, await kycIssuer.getAddress(), amlIssuer ? await amlIssuer.getAddress() : undefined);

  const senderIdentity = await deployIdentity(factory, sender.address);
  const recipientIdentity = await deployIdentity(factory, recipient.address);
  await registry.registerIdentity(sender.address, senderIdentity, 0);
  await registry.registerIdentity(recipient.address, recipientIdentity, 0);

  await attest(kycIssuer, kycIssuerSigner, senderIdentity);
  await attest(kycIssuer, kycIssuerSigner, recipientIdentity);
  if (amlIssuer) {
    await attest(amlIssuer, amlIssuerSigner, senderIdentity, AML_TOPIC);
    await attest(amlIssuer, amlIssuerSigner, recipientIdentity, AML_TOPIC);
  }

  const registryAddr = await registry.getAddress();
  const { token, compliance } = await deployTokenWithCompliance(deployer, registryAddr);
  await (await compliance.setTokenIdentityRegistry(await token.getAddress(), registryAddr)).wait();
  await (await token.mint(sender.address, MINT_AMOUNT)).wait();

  const transferGasUsed = await measureTransfer(token, sender, recipient);
  const isVerifiedGasEstimate = await registry.isVerified.estimateGas(sender.address);
  return { name, transferGasUsed, isVerifiedGasEstimate };
}

function printTable(results: ScenarioResult[]): void {
  const baseline = results[0].transferGasUsed;
  const col = (s: string, w: number) => s.padEnd(w);
  const num = (s: string, w: number) => s.padStart(w);

  console.log(col("Scenario", 42) + num("transfer gasUsed", 18) + num("delta vs A", 14) + num("isVerified est.", 18));
  console.log("-".repeat(92));
  for (const r of results) {
    const delta = r.transferGasUsed - baseline;
    const deltaStr = delta === 0n ? "0" : `${delta > 0n ? "+" : ""}${delta}`;
    console.log(
      col(r.name, 42) + num(r.transferGasUsed.toString(), 18) + num(deltaStr, 14) + num(r.isVerifiedGasEstimate.toString(), 18),
    );
  }
}

async function main() {
  const [deployer, sender, recipient, kycIssuerSigner, amlIssuerSigner] = await ethers.getSigners();

  console.log("Gas analysis: Token.transfer cost by required claim topics");
  console.log("=".repeat(70));

  const results: ScenarioResult[] = [
    await runBaselineScenario(deployer, sender, recipient),
    await runClaimScenario("B: IdentityRegistry, 1 topic (KYC)", 1, deployer, sender, recipient, kycIssuerSigner, amlIssuerSigner),
    await runClaimScenario("C: IdentityRegistry, 2 topics (KYC+AML)", 2, deployer, sender, recipient, kycIssuerSigner, amlIssuerSigner),
  ];

  console.log();
  printTable(results);

  const twoTopicDelta = results[2].transferGasUsed - results[0].transferGasUsed;
  if (twoTopicDelta > 40000n) {
    console.log(`\n2-topic delta over baseline is ${twoTopicDelta} gas, above the 40,000 gas threshold.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Gas analysis failed:", error);
    process.exit(1);
  });
