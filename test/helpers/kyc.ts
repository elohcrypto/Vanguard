import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ClaimIssuer,
  IdentityRegistry,
  OnchainIDFactory,
} from "../../typechain-types";

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
  await registry.addClaimTopic(KYC_TOPIC);
  await registry.addTrustedIssuer(kycIssuerAddr, [KYC_TOPIC]);

  if (amlIssuerAddr) {
    await registry.addClaimTopic(AML_TOPIC);
    await registry.addTrustedIssuer(amlIssuerAddr, [AML_TOPIC]);
  }
}

/**
 * EIP-191 signature by `signer` over keccak256(abi.encodePacked(identity,
 * topic, data)), the payload ClaimIssuer.issueClaim and verifyClaim check.
 */
export async function signClaim(
  signer: SignerWithAddress,
  identityAddr: string,
  topic: number | bigint,
  data: Uint8Array | string,
): Promise<string> {
  return signer.signMessage(
    ethers.getBytes(
      ethers.solidityPackedKeccak256(
        ["address", "uint256", "bytes"],
        [identityAddr, topic, data],
      ),
    ),
  );
}

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
  const sig = await signClaim(issuerSigner, identityAddr, topic, data);
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
