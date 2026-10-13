import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ClaimIssuer,
  IdentityRegistry,
  OnchainIDFactory,
} from "../../typechain-types";
const demoKyc = require("../../demo/utils/Kyc");

// Task 1R.2 (plan 2026-09-25-zk-kyc-ownership-cleanup-v2, section 2.3):
// IdentityRegistry.isVerified only returns true once every configured claim
// topic is satisfied by a live claim from a trusted issuer (see
// IdentityRegistryClaims.test.ts). Fixtures across the suite must configure
// topics and attest wallets instead of relying on the permissive
// "no topics configured" mode where registerIdentity alone verifies.

export const KYC_TOPIC = 6;
export const AML_TOPIC = 7;
export const KYC_DATA = ethers.toUtf8Bytes("kyc:passed");

/**
 * Names KYC (and optionally AML) as required claim topics on the registry
 * and trusts the given issuer(s) for them. Caller must be the registry
 * owner. Call once per registry.
 */
export async function configureKyc(
  registry: IdentityRegistry,
  kycIssuerAddr: string,
  amlIssuerAddr?: string,
): Promise<void> {
  // Issuer first: a required topic needs a trusted issuer (2F.5 L-1).
  await registry.addTrustedIssuer(kycIssuerAddr, [KYC_TOPIC]);
  await registry.addClaimTopic(KYC_TOPIC);

  if (amlIssuerAddr) {
    await registry.addTrustedIssuer(amlIssuerAddr, [AML_TOPIC]);
    await registry.addClaimTopic(AML_TOPIC);
  }
}

/**
 * EIP-191 signature by `signer` over ClaimIssuer.claimDigest for `issuer`
 * (chain id, issuer, epoch, identity, topic, scheme, data, uri, validTo): the
 * demo's signer (demo/utils/Kyc.js), the one off-chain digest builder.
 */
export async function signClaim(
  signer: SignerWithAddress,
  issuer: { getAddress(): Promise<string> } | string,
  identityAddr: string,
  topic: number | bigint,
  data: Uint8Array | string,
  fields: ClaimFields = {},
): Promise<string> {
  return demoKyc.signClaim(signer, issuer, identityAddr, topic, data, fields);
}

/** The claim fields signed besides issuer, identity, topic and data. */
export type ClaimFields = {
  scheme?: number | bigint;
  uri?: string;
  validTo?: number | bigint;
  chainId?: number | bigint;
  epoch?: number | bigint;
};

/**
 * Issues a claim from `issuer`, sent and signed by `issuerSigner`, with the
 * given scheme data, uri and expiry. Returns the transaction so callers can
 * assert on events or reverts.
 */
export async function issueSigned(
  issuer: ClaimIssuer,
  issuerSigner: SignerWithAddress,
  identityAddr: string,
  topic: number | bigint,
  data: Uint8Array | string,
  uri: string = "",
  validTo: number | bigint = 0,
) {
  const sig = await signClaim(issuerSigner, issuer, identityAddr, topic, data, {
    uri,
    validTo,
  });
  return issuer
    .connect(issuerSigner)
    .issueClaim(identityAddr, topic, 1, data, uri, validTo, sig);
}

/**
 * Issues a claim from `issuer` (signed by `issuerSigner`) onto the
 * identity at `identityAddr` for `topic`.
 */
export async function attest(
  issuer: ClaimIssuer,
  issuerSigner: SignerWithAddress,
  identityAddr: string,
  topic: number = KYC_TOPIC,
  validTo: number = 0,
  data: Uint8Array = KYC_DATA,
): Promise<void> {
  await issueSigned(
    issuer,
    issuerSigner,
    identityAddr,
    topic,
    data,
    "",
    validTo,
  );
}

/**
 * Deploys a real OnchainID for `wallet` through the factory and returns
 * its address. IdentityRegistry._hasValidClaim treats an identity address
 * with no code as unverifiable, so any wallet expected to pass isVerified
 * once topics are configured needs a real OnchainID, not a bare EOA.
 */
export async function deployIdentity(
  factory: OnchainIDFactory,
  wallet: string,
): Promise<string> {
  await factory.deployOnchainID(wallet, ethers.randomBytes(32));
  return factory.getIdentityByOwner(wallet);
}
