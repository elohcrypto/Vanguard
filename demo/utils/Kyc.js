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

/** The issuer getter the signer reads the revocation epoch from. */
const EPOCH_ABI = [
  "function revocationEpoch(address, uint256) view returns (uint256)",
];

/**
 * Sign a claim the way ClaimIssuer.issueClaim/verifyClaim expect: EIP-191
 * over ClaimIssuer.claimDigest, keccak256(abi.encode(chainId, issuer,
 * revocationEpoch, identity, topic, scheme, data, uri, validTo)) (Task
 * 5.2: every recorded field is signed, bound to one issuer on one chain,
 * and void once a claim on the (identity, topic) is revoked). The one
 * off-chain builder of the digest; test/helpers/kyc.ts signs through it.
 *
 * @param {Object} signer - Signer holding the issuer's management/claim-signer key.
 * @param {Object|string} issuer - The ClaimIssuer (contract or address) it is for.
 * @param {string} identityAddress - The OnchainID contract address.
 * @param {number} topic - Claim topic.
 * @param {Uint8Array} data - Claim data bytes.
 * @param {Object} [fields] - { scheme = 1, uri = "", validTo = 0, chainId,
 *   epoch } as issued; chainId defaults to the signer's network, epoch to
 *   the issuer's revocationEpoch(identity, topic) now.
 * @returns {Promise<string>} The 65-byte signature, hex.
 */
async function signClaim(
  signer,
  issuer,
  identityAddress,
  topic,
  data,
  { scheme = 1, uri = "", validTo = 0, chainId, epoch } = {},
) {
  const chain = chainId ?? (await signer.provider.getNetwork()).chainId;
  const at = typeof issuer === "string" ? issuer : await issuer.getAddress();
  // Task 5.15 (L-3): an external signer that shows claims field by field
  // (scripts/production/signer.js vanguard_signClaim) recomputes the digest
  // itself; any other signer refuses the method and signs the bytes below.
  if (chainId === undefined && epoch === undefined && !signer.privateKey) {
    try {
      return await signer.provider.send("vanguard_signClaim", [
        await signer.getAddress(),
        {
          issuer: at,
          identity: identityAddress,
          topic: Number(topic),
          scheme,
          data: ethers.hexlify(data),
          uri,
          validTo: Number(validTo),
          chainId: Number(chain),
        },
      ]);
    } catch (e) {
      const m = `${e.message} ${e.error?.message ?? ""}`;
      if (
        !/not allowed|not supported|does not exist|not found|-32601|unsupported method|Method .*not/i.test(
          m,
        )
      )
        throw e;
    }
  }
  // Review L-2: the (identity, topic)'s revocation epoch, read now.
  const ep =
    epoch ??
    (await new ethers.Contract(at, EPOCH_ABI, signer.provider).revocationEpoch(
      identityAddress,
      topic,
    ));
  const hash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "address",
        "uint256",
        "address",
        "uint256",
        "uint256",
        "bytes",
        "string",
        "uint256",
      ],
      [chain, at, ep, identityAddress, topic, scheme, data, uri, validTo],
    ),
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
  const sig = await signClaim(
    issuerSigner,
    kycIssuer,
    identityAddress,
    KYC_TOPIC,
    data,
    {
      validTo: expiry,
    },
  );
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
  const sig = await signClaim(
    issuerSigner,
    amlIssuer,
    identityAddress,
    AML_TOPIC,
    data,
    {
      validTo: expiry,
    },
  );
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
 * Issue both required claims (KYC + AML) on an identity, signed by each
 * issuer's current owner among the demo signers: the deployer (wallet 0)
 * before the handover ceremony, the issuer admin (wallet 9) after it
 * (Task 4.13: every live issuer key is the owner's; no provider wallet
 * holds one). IdentityRegistry.isVerified() requires every configured
 * topic, so any wallet expected to verify needs both claims.
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
  const kycIssuer = state.getContract("kycIssuer");
  const amlIssuer = state.getContract("amlIssuer");
  const kyc = await attestKyc(
    kycIssuer,
    await issuerOwnerSigner(state, kycIssuer),
    identityAddress,
    label,
    validTo,
  );
  const aml = await attestAml(
    amlIssuer,
    await issuerOwnerSigner(state, amlIssuer),
    identityAddress,
    label,
    validTo,
  );
  return { kyc, aml };
}

/** The demo signer that owns `issuer`; throws when no loaded wallet does. */
async function issuerOwnerSigner(state, issuer) {
  const owner = (await issuer.owner()).toLowerCase();
  const s = state.signers.find((x) => x.address.toLowerCase() === owner);
  if (!s) {
    throw new Error(
      `issuer ${await issuer.getAddress()} is owned by ${owner}, not by a loaded demo wallet`,
    );
  }
  return s;
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
 * @returns {Promise<{receipt: Object|null, until: bigint}>} until is 0n
 *   if nothing was cached; receipt is null for an unregistered wallet.
 */
async function cacheVerification(state, wallet, log = console.log) {
  const registry = state.getContract("identityRegistry");
  const identity = await registry.identity(wallet);
  if (identity === ethers.ZeroAddress) {
    log("   ⚠️  refreshVerified: wallet not registered, nothing cached");
    return { receipt: null, until: 0n };
  }
  const passed = await registry.refreshVerified.staticCall(wallet);
  const receipt = await (await registry.refreshVerified(wallet)).wait();
  const [, until] = await registry.verifiedUntil(identity);
  if (until !== 0n) {
    const when = new Date(Number(until) * 1000).toISOString();
    log(`   ✅ refreshVerified: verification cached until ${when} (chain)`);
  } else if (passed) {
    log(
      "   ⚠️  refreshVerified: walk passed but not cached (issuer gives no expiry)",
    );
  } else {
    log(
      "   ℹ️  refreshVerified: walk fails (no live claim), cache entry cleared",
    );
  }
  log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
  return { receipt, until };
}

module.exports = {
  issuerOwnerSigner,
  signClaim,
  cacheVerification,
  attestKyc,
  attestAml,
  attestAll,
  defaultValidTo,
  KYC_TOPIC,
  AML_TOPIC,
};
