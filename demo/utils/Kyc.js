/**
 * @fileoverview KYC/AML attestation helpers for the demo.
 * @module Kyc
 * @description Issues real KYC and AML claims through ClaimIssuer.issueClaim, the
 * only path IdentityRegistry.isVerified() accepts once claim topics are
 * required (see plan Tasks 1R.3, 1R.6, section 2.3 of
 * .omc/plans/2026-09-25-zk-kyc-ownership-cleanup-v2.md). A claim added
 * directly on the OnchainID with `identity.addClaim(...)` does NOT verify.
 */

const { ethers } = require("hardhat");

/** Claim topic ID for KYC, matches OnchainID.KYC_TOPIC (contracts/onchain_id/OnchainID.sol). */
const KYC_TOPIC = 6;
/** Claim topic ID for AML, matches OnchainID.AML_TOPIC (contracts/onchain_id/OnchainID.sol). */
const AML_TOPIC = 7;

/** Default claim validity: one year, in seconds. */
const DEFAULT_VALIDITY_SECONDS = 365 * 24 * 60 * 60;

/**
 * Computes a validTo one year out from the node's latest block timestamp.
 * Uses chain time, not Date.now(), so re-attestation after the demo advances
 * the local node with evm_increaseTime (menu option 11) still lands a claim
 * that is valid relative to where the chain actually is.
 *
 * @returns {Promise<number>} Unix timestamp.
 */
async function defaultValidTo() {
  const latest = await ethers.provider.getBlock("latest");
  return latest.timestamp + DEFAULT_VALIDITY_SECONDS;
}

/**
 * Sign a claim the way ClaimIssuer.issueClaim/verifyClaim expect: EIP-191
 * over keccak256(abi.encodePacked(identity, topic, data)).
 *
 * @param {Object} signer - Signer holding the issuer's management/claim-signer key.
 * @param {string} identityAddress - The OnchainID contract address.
 * @param {number} topic - Claim topic.
 * @param {Uint8Array} data - Claim data bytes.
 * @returns {Promise<string>} The 65-byte signature, hex.
 */
async function signClaim(signer, identityAddress, topic, data) {
  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes"],
    [identityAddress, topic, data],
  );
  return signer.signMessage(ethers.getBytes(hash));
}

/**
 * Issue a KYC claim (topic 6) on an identity through its trusted ClaimIssuer.
 *
 * @param {Object} kycIssuer - The deployed KYC ClaimIssuer contract instance.
 * @param {Object} issuerSigner - Signer holding the issuer's management/claim-signer key.
 * @param {string} identityAddress - The OnchainID contract address to attest.
 * @param {string} label - Free-text label folded into the claim data (for demo readability).
 * @param {number} [validTo] - Unix timestamp the claim expires at. Defaults to one
 *   year from the current chain time; pass 0 for no expiry.
 * @returns {Promise<Object>} The transaction receipt.
 */
async function attestKyc(
  kycIssuer,
  issuerSigner,
  identityAddress,
  label,
  validTo,
) {
  const expiry = validTo === undefined ? await defaultValidTo() : validTo;
  const data = ethers.toUtf8Bytes("kyc:" + label);
  const sig = await signClaim(issuerSigner, identityAddress, KYC_TOPIC, data);
  const tx = await kycIssuer.connect(issuerSigner).issueClaim(
    identityAddress,
    KYC_TOPIC,
    1, // scheme: ECDSA
    data,
    "", // uri
    expiry,
    sig,
  );
  return tx.wait();
}

/**
 * Issue an AML claim (topic 7) on an identity through its trusted ClaimIssuer.
 *
 * @param {Object} amlIssuer - The deployed AML ClaimIssuer contract instance.
 * @param {Object} issuerSigner - Signer holding the issuer's management/claim-signer key.
 * @param {string} identityAddress - The OnchainID contract address to attest.
 * @param {string} label - Free-text label folded into the claim data (for demo readability).
 * @param {number} [validTo] - Unix timestamp the claim expires at. Defaults to one
 *   year from the current chain time; pass 0 for no expiry.
 * @returns {Promise<Object>} The transaction receipt.
 */
async function attestAml(
  amlIssuer,
  issuerSigner,
  identityAddress,
  label,
  validTo,
) {
  const expiry = validTo === undefined ? await defaultValidTo() : validTo;
  const data = ethers.toUtf8Bytes("aml:" + label);
  const sig = await signClaim(issuerSigner, identityAddress, AML_TOPIC, data);
  const tx = await amlIssuer.connect(issuerSigner).issueClaim(
    identityAddress,
    AML_TOPIC,
    1, // scheme: ECDSA
    data,
    "", // uri
    expiry,
    sig,
  );
  return tx.wait();
}

/**
 * Issue both required claims (KYC + AML) on an identity, using the issuers
 * and signers the demo state already tracks. KYC issuer owner is signers[2]
 * and AML issuer owner is signers[3] (see
 * ContractDeployer.deployOnchainIDContracts). IdentityRegistry.isVerified()
 * requires every configured topic, so any wallet expected to verify needs
 * both claims, not just KYC.
 *
 * @param {Object} state - DemoState instance (must have kycIssuer/amlIssuer
 *   contracts and signers registered).
 * @param {string} identityAddress - The OnchainID contract address to attest.
 * @param {string} label - Free-text label folded into both claims' data.
 * @param {number} [validTo] - Shared expiry for both claims. Defaults to one
 *   year from the current chain time.
 * @returns {Promise<{kyc: Object, aml: Object}>} The two transaction receipts.
 */
async function attestAll(state, identityAddress, label, validTo) {
  const kyc = await attestKyc(
    state.getContract("kycIssuer"),
    state.signers[2],
    identityAddress,
    label,
    validTo,
  );
  const aml = await attestAml(
    state.getContract("amlIssuer"),
    state.signers[3],
    identityAddress,
    label,
    validTo,
  );
  return { kyc, aml };
}

/**
 * Cache a wallet's verification after its claims are issued (Task 4.9,
 * D17 = a). IdentityRegistry.refreshVerified runs the full claim walk and,
 * if it passes, stores the identity's entry until the earlier of 24h and
 * the earliest claim expiry; isVerified then answers from that entry.
 * Anyone may call it; a failing walk clears the entry instead.
 *
 * @param {Object} state - DemoState with identityRegistry registered.
 * @param {string} wallet - The registered wallet to refresh.
 * @param {Function} [log] - Printer, console.log by default.
 * @returns {Promise<{receipt: Object, until: bigint}>} until is 0n if
 *   nothing was cached (the walk failed).
 */
async function cacheVerification(state, wallet, log = console.log) {
  const registry = state.getContract("identityRegistry");
  const receipt = await (await registry.refreshVerified(wallet)).wait();
  const [, until] = await registry.verifiedUntil(
    await registry.identity(wallet),
  );
  if (until === 0n) {
    log("   ⚠️  refreshVerified: claim walk failed, nothing cached");
  } else {
    const when = new Date(Number(until) * 1000).toISOString();
    log(`   ✅ refreshVerified: verification cached until ${when} (chain)`);
  }
  log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
  return { receipt, until };
}

module.exports = {
  signClaim,
  cacheVerification,
  attestKyc,
  attestAml,
  attestAll,
  defaultValidTo,
  KYC_TOPIC,
  AML_TOPIC,
};
