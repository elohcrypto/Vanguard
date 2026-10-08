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
// topic concept), 1 (KYC), 2 (KYC+AML). Task 4.9: D is C with both
// identities' verification cached by refreshVerified (D17 = a), so
// isVerified answers from one entry instead of the claim walk. Task 4.10:
// E is D with an authorized InvestorTypeRegistry on the token (caps,
// cooldown, the clock write); the measured transfer runs after the
// sender's cooldown, so it overwrites a clock the warm-up wrote.

const MINT_AMOUNT = ethers.parseEther("1000");
const TRANSFER_AMOUNT = ethers.parseEther("10");
const NO_COUNTRIES: number[] = [];

interface ScenarioResult {
  name: string;
  transferGasUsed: bigint;
  firstTransferGasUsed: bigint;
  isVerifiedGasEstimate: bigint;
  refreshGasUsed?: bigint;
}

/** Deploys ComplianceRules (no jurisdiction rules) + Token bound to it. */
async function deployTokenWithCompliance(
  deployer: SignerWithAddress,
  registryAddr: string,
) {
  const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
  const compliance = await ComplianceRules.deploy(
    deployer.address,
    NO_COUNTRIES,
    NO_COUNTRIES,
  );
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
// warmth. Throws (script exits non-zero) if either reverts. The clock
// moves past the longest default cooldown (60 minutes) in between.
async function measureTransfer(
  token: Token,
  sender: SignerWithAddress,
  recipient: SignerWithAddress,
): Promise<[bigint, bigint]> {
  const warmup = await token
    .connect(sender)
    .transfer(recipient.address, TRANSFER_AMOUNT);
  const warmupReceipt = await warmup.wait();
  if (!warmupReceipt || warmupReceipt.status !== 1)
    throw new Error("warm-up transfer reverted");
  await ethers.provider.send("evm_increaseTime", [3600]);

  const tx = await token
    .connect(sender)
    .transfer(recipient.address, TRANSFER_AMOUNT);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1)
    throw new Error("measured transfer reverted");
  return [receipt.gasUsed, warmupReceipt.gasUsed];
}

/**
 * Scenario A: Token bound to MockIdentityRegistry, the permissive test
 * double — since 788b742 a real IdentityRegistry with zero required
 * topics verifies nobody, so it cannot serve as the baseline. Compliance
 * is bound to the same mock via setTokenIdentityRegistry (ComplianceRules
 * fails closed when unbound), so A runs the full production path —
 * Token's isVerified gate plus compliance's list and country checks —
 * with a registry that verifies at mapping-read cost.
 */
async function runBaselineScenario(
  deployer: SignerWithAddress,
  sender: SignerWithAddress,
  recipient: SignerWithAddress,
): Promise<ScenarioResult> {
  const registry = await (
    await ethers.getContractFactory("MockIdentityRegistry")
  ).deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  const { token, compliance } = await deployTokenWithCompliance(
    deployer,
    registryAddr,
  );
  await (
    await compliance.setTokenIdentityRegistry(
      await token.getAddress(),
      registryAddr,
    )
  ).wait();

  await registry.registerIdentity(sender.address, sender.address, 0);
  await registry.registerIdentity(recipient.address, recipient.address, 0);
  await (await token.mint(sender.address, MINT_AMOUNT)).wait();

  const [transferGasUsed, firstTransferGasUsed] = await measureTransfer(
    token,
    sender,
    recipient,
  );
  const isVerifiedGasEstimate = await registry.isVerified.estimateGas(
    sender.address,
  );
  return {
    name: "A: MockIdentityRegistry (baseline)",
    transferGasUsed,
    firstTransferGasUsed,
    isVerifiedGasEstimate,
  };
}

/**
 * Scenarios B, C and D: a real IdentityRegistry with `topics` required
 * claim topics (KYC only, or KYC+AML), each satisfied by a live signed
 * claim from its own trusted issuer, on a real OnchainID for both
 * wallets. With `refresh`, both wallets are refreshed (cached) first.
 */
async function runClaimScenario(
  name: string,
  topics: 1 | 2,
  refresh: boolean,
  withTypes: boolean,
  deployer: SignerWithAddress,
  sender: SignerWithAddress,
  recipient: SignerWithAddress,
  kycIssuerSigner: SignerWithAddress,
  amlIssuerSigner: SignerWithAddress,
): Promise<ScenarioResult> {
  const factory = await (
    await ethers.getContractFactory("OnchainIDFactory")
  ).deploy(deployer.address, ethers.ZeroHash);
  await factory.waitForDeployment();

  const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
  const kycIssuer = await ClaimIssuerFactory.deploy(
    kycIssuerSigner.address,
    "KYC Service",
    "KYC verification service",
  );
  await kycIssuer.waitForDeployment();

  let amlIssuer: ClaimIssuer | null = null;
  if (topics === 2) {
    amlIssuer = await ClaimIssuerFactory.deploy(
      amlIssuerSigner.address,
      "AML Service",
      "AML screening service",
    );
    await amlIssuer.waitForDeployment();
  }

  const registry = await (
    await ethers.getContractFactory("IdentityRegistry")
  ).deploy();
  await registry.waitForDeployment();
  await configureKyc(
    registry,
    await kycIssuer.getAddress(),
    amlIssuer ? await amlIssuer.getAddress() : undefined,
  );

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
  const { token, compliance } = await deployTokenWithCompliance(
    deployer,
    registryAddr,
  );
  await (
    await compliance.setTokenIdentityRegistry(
      await token.getAddress(),
      registryAddr,
    )
  ).wait();
  if (withTypes) {
    const types = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await types.waitForDeployment();
    await (
      await token.setInvestorTypeRegistry(await types.getAddress())
    ).wait();
    await (await types.authorizeToken(await token.getAddress(), true)).wait();
  }
  await (await token.mint(sender.address, MINT_AMOUNT)).wait();

  let refreshGasUsed: bigint | undefined;
  if (refresh) {
    const r = await (await registry.refreshVerified(sender.address)).wait();
    await (await registry.refreshVerified(recipient.address)).wait();
    refreshGasUsed = r!.gasUsed;
  }

  const [transferGasUsed, firstTransferGasUsed] = await measureTransfer(
    token,
    sender,
    recipient,
  );
  const isVerifiedGasEstimate = await registry.isVerified.estimateGas(
    sender.address,
  );
  return {
    name,
    transferGasUsed,
    firstTransferGasUsed,
    isVerifiedGasEstimate,
    refreshGasUsed,
  };
}

function printTable(results: ScenarioResult[]): void {
  const baseline = results[0].transferGasUsed;
  const col = (s: string, w: number) => s.padEnd(w);
  const num = (s: string, w: number) => s.padStart(w);

  console.log(
    col("Scenario", 42) +
      num("transfer gasUsed", 18) +
      num("delta vs A", 14) +
      num("isVerified est.", 18),
  );
  console.log("-".repeat(92));
  for (const r of results) {
    const delta = r.transferGasUsed - baseline;
    const deltaStr = delta === 0n ? "0" : `${delta > 0n ? "+" : ""}${delta}`;
    console.log(
      col(r.name, 42) +
        num(r.transferGasUsed.toString(), 18) +
        num(deltaStr, 14) +
        num(r.isVerifiedGasEstimate.toString(), 18),
    );
  }
}

async function main() {
  const [deployer, sender, recipient, kycIssuerSigner, amlIssuerSigner] =
    await ethers.getSigners();

  console.log("Gas analysis: Token.transfer cost by required claim topics");
  console.log("=".repeat(70));

  const results: ScenarioResult[] = [
    await runBaselineScenario(deployer, sender, recipient),
    await runClaimScenario(
      "B: IdentityRegistry, 1 topic (KYC)",
      1,
      false,
      false,
      deployer,
      sender,
      recipient,
      kycIssuerSigner,
      amlIssuerSigner,
    ),
    await runClaimScenario(
      "C: IdentityRegistry, 2 topics (KYC+AML)",
      2,
      false,
      false,
      deployer,
      sender,
      recipient,
      kycIssuerSigner,
      amlIssuerSigner,
    ),
    await runClaimScenario(
      "D: C + both identities refreshed",
      2,
      true,
      false,
      deployer,
      sender,
      recipient,
      kycIssuerSigner,
      amlIssuerSigner,
    ),
    await runClaimScenario(
      "E: D + investor-type registry",
      2,
      true,
      true,
      deployer,
      sender,
      recipient,
      kycIssuerSigner,
      amlIssuerSigner,
    ),
  ];

  console.log();
  printTable(results);

  const base = results[0].transferGasUsed;
  const unrefreshed = results[2].transferGasUsed - base;
  const cached = results[3].transferGasUsed - base;
  console.log(
    `\nrefreshVerified (2 topics, one wallet): ${results[3].refreshGasUsed} gas`,
  );
  console.log(`2-topic delta over A, unrefreshed (C): +${unrefreshed} gas`);
  console.log(
    `2-topic delta over A, refreshed (D): +${cached} gas, ` +
      (cached <= 40000n ? "within" : "ABOVE") +
      " the 40,000 gas threshold.",
  );
  const typed = results[4].transferGasUsed - base;
  console.log(
    `with the investor-type registry (E): +${typed} gas over A, ` +
      `+${results[4].transferGasUsed - results[3].transferGasUsed} over D, ` +
      (typed <= 40000n ? "within" : "ABOVE") +
      " the 40,000 gas threshold.",
  );
  console.log(
    `first transfer (warm-up) D: ${results[3].firstTransferGasUsed}, ` +
      `E: ${results[4].firstTransferGasUsed} ` +
      `(+${results[4].firstTransferGasUsed - results[3].firstTransferGasUsed})`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Gas analysis failed:", error);
    process.exit(1);
  });
