/**
 * @fileoverview KYC attestation helper for the demo.
 * @module Kyc
 * @description Issues a real KYC claim through ClaimIssuer.issueClaim, the only
 * path IdentityRegistry.isVerified() accepts once a KYC claim topic is
 * required (see plan Task 1.4). A claim added directly on the OnchainID with
 * `identity.addClaim(...)` does NOT verify.
 */

const { ethers } = require('hardhat');

/** Claim topic ID for KYC, matches OnchainID.KYC_TOPIC (contracts/onchain_id/OnchainID.sol). */
const KYC_TOPIC = 6;

/**
 * Issue a KYC claim on an identity through its trusted ClaimIssuer.
 *
 * @param {Object} kycIssuer - The deployed KYC ClaimIssuer contract instance.
 * @param {Object} issuerSigner - Signer holding the issuer's management/claim-signer key.
 * @param {string} identityAddress - The OnchainID contract address to attest.
 * @param {string} label - Free-text label folded into the claim data (for demo readability).
 * @returns {Promise<Object>} The transaction receipt.
 */
async function attestKyc(kycIssuer, issuerSigner, identityAddress, label) {
    const tx = await kycIssuer
        .connect(issuerSigner)
        .issueClaim(
            identityAddress,
            KYC_TOPIC,
            1, // scheme: ECDSA
            ethers.toUtf8Bytes('kyc:' + label),
            '', // uri
            0, // validTo: no expiry
        );
    return tx.wait();
}

module.exports = { attestKyc, KYC_TOPIC };
