/**
 * @fileoverview Options 6 and 7, reject / update / revoke, on chain
 * @module OnchainIDClaimChain
 * @description Plan v2 Task 4.8 (b), 4.9 review L-4: these sub-actions used
 * to edit the demo's local claim record only. Now the topic's issuer signer
 * (wallet 2 for KYC, wallet 3 for AML, as demo/utils/Kyc.js attests) calls
 * ClaimIssuer.revokeClaim on the identity's latest claim, the permissionless
 * IdentityRegistry.refreshVerified (Kyc.cacheVerification) makes it count at
 * once, and every verdict is printed from chain reads before and after.
 * "Update" to ISSUED revokes a live claim and attests a fresh one; EXPIRED is
 * not something an issuer sets (a claim lapses at its signed validTo). The
 * local record is kept only because options 6-9 read it later.
 */

"use strict";

const { ethers } = require("hardhat");
const { displaySuccess, displayError } = require("./DisplayHelpers");
const {
  attestKyc,
  attestAml,
  cacheVerification,
  KYC_TOPIC,
  AML_TOPIC,
} = require("./Kyc");

/** Topic, issuer contract and issuer signer per claim kind (Kyc.attestAll). */
const KINDS = {
  KYC: { topic: KYC_TOPIC, issuer: "kycIssuer", wallet: 2, attest: attestKyc },
  AML: { topic: AML_TOPIC, issuer: "amlIssuer", wallet: 3, attest: attestAml },
};

/** Chain facts for one identity and claim kind. */
async function readFacts(state, identity, kind) {
  const k = KINDS[kind];
  const issuer = state.getContract(k.issuer);
  const registry = state.getContract("identityRegistry");
  const claimId = await issuer.latestClaimId(identity.address, k.topic);
  const registered =
    !!registry &&
    (await registry.identity(identity.owner)) === identity.address;
  return {
    claimId,
    valid: await issuer.isClaimValid(claimId),
    has: await issuer.hasValidClaim(identity.address, k.topic),
    verified: registered ? await registry.isVerified(identity.owner) : null,
    registered,
  };
}

function printFacts(when, kind, f, log) {
  const v = f.verified === null ? "n/a (wallet not registered)" : f.verified;
  log(
    `   ${when}: isClaimValid(latest ${kind}) ${f.valid}, hasValidClaim ${f.has}, isVerified(wallet) ${v} (chain)`,
  );
}

/**
 * Revoke the identity's latest claim of `kind` through its ClaimIssuer and
 * refresh the wallet's cached verification.
 *
 * @returns {Promise<Object|null>} {before, after} facts, or null when the
 *   issuer has no claim on chain for this identity.
 */
async function revokeOnChain(state, identity, kind, log = console.log) {
  const k = KINDS[kind];
  const issuer = state.getContract(k.issuer);
  if (!issuer) {
    log(`   ⚠️  The ${kind} ClaimIssuer is not deployed (option 1)`);
    return null;
  }
  const before = await readFacts(state, identity, kind);
  if (before.claimId === ethers.ZeroHash) {
    log(`   ⚠️  ${kind} issuer ${await issuer.getAddress()} has no claim`);
    log(`      on chain for this identity`);
    return null;
  }
  log(`   ${kind} issuer: ${await issuer.getAddress()}`);
  log(`   Latest claim: ${before.claimId}`);
  printFacts("Before", kind, before, log);
  let mined = false;
  if (before.valid) {
    const signer = state.signers[k.wallet];
    try {
      const tx = await issuer.connect(signer).revokeClaim(before.claimId);
      const rc = await tx.wait();
      mined = true;
      log(
        `   ✅ revokeClaim by wallet ${k.wallet} (${signer.address}) mined in block ${rc.blockNumber}`,
      );
    } catch (e) {
      log(`   ⚠️  revokeClaim refused: ${e.shortMessage || e.message}`);
    }
  } else {
    log(`   ℹ️  Already not valid on chain (revoked or expired): no tx`);
  }
  if (before.registered) await cacheVerification(state, identity.owner, log);
  const after = await readFacts(state, identity, kind);
  printFacts("After", kind, after, log);
  return { before, after, mined };
}

/**
 * Re-issue a claim of `kind`: revoke the live one (if any), attest a fresh
 * one through the issuer, refresh, and read the facts back.
 */
async function reissueOnChain(state, identity, kind, label, log) {
  const k = KINDS[kind];
  const issuer = state.getContract(k.issuer);
  const first = await revokeOnChain(state, identity, kind, log);
  if (!first) return null;
  const signer = state.signers[k.wallet];
  const rc = await k.attest(issuer, signer, identity.address, label);
  log(
    `   ✅ ${kind} claim re-issued (ClaimIssuer.issueClaim, block ${rc.blockNumber})`,
  );
  const registered = first.after.registered;
  if (registered) await cacheVerification(state, identity.owner, log);
  const after = await readFacts(state, identity, kind);
  printFacts("After re-issue", kind, after, log);
  return { before: first.before, after };
}

/**
 * Reject (status REJECTED) or revoke (status REVOKED) a claim: the issuer
 * revokes it on chain; the local record follows the chain.
 */
async function markRevoked(state, identity, kind, status, log = console.log) {
  const r = await revokeOnChain(state, identity, kind, log);
  const verb = status === "REJECTED" ? "reject" : "revoke";
  if (!r) {
    displayError(`No ${kind} claim found on chain to ${verb}`);
    return;
  }
  if (r.after.valid) {
    displayError(`${kind} claim still valid on chain`);
    return;
  }
  const claim = state.claims.get(`${identity.address}_${kind}`);
  if (claim) {
    claim.status = status;
    claim[status === "REJECTED" ? "rejectedAt" : "revokedAt"] =
      new Date().toISOString();
  }
  if (r.mined)
    displaySuccess(
      `${kind} claim ${status.toLowerCase()} (not valid on chain)`,
    );
  else log("ℹ️  already not valid on chain; record updated");
}

/** The update sub-action: same prompt as before, the change made on chain. */
async function updateStatus(mod, identity, kind, log = console.log) {
  const claim = mod.state.claims.get(`${identity.address}_${kind}`);
  if (!claim) {
    displayError(`No ${kind} claim found to update`);
    return;
  }

  console.log("\n📋 Select new status:");
  console.log("1. ISSUED");
  console.log("2. REJECTED");
  console.log("3. REVOKED");
  console.log("4. EXPIRED");

  const choice = await mod.promptUser("Select status (1-4): ");
  if (choice === "2" || choice === "3") {
    await markRevoked(
      mod.state,
      identity,
      kind,
      choice === "2" ? "REJECTED" : "REVOKED",
      log,
    );
  } else if (choice === "1") {
    const code = claim.countryCode ?? identity.countryCode ?? 0;
    const r = await reissueOnChain(
      mod.state,
      identity,
      kind,
      `country:${code}`,
      log,
    );
    if (r && r.after.valid) {
      claim.status = "ISSUED";
      claim.updatedAt = new Date().toISOString();
      displaySuccess(`${kind} status updated to: ISSUED (valid on chain)`);
    } else displayError(`${kind} claim not re-issued`);
  } else if (choice === "4") {
    log("   ⚠️  EXPIRED is not set by hand: a claim lapses at the validTo its");
    log("      issuer signed (option 11 shows one lapse). Nothing changed.");
  } else {
    displayError("Invalid choice");
  }
}

module.exports = {
  readFacts,
  revokeOnChain,
  reissueOnChain,
  markRevoked,
  updateStatus,
};
