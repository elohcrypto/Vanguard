/**
 * @fileoverview The demo's one onboarding path (plan v2 Task 4.16, L-6).
 *
 * A wallet becomes a verified identity in four idempotent steps, each
 * read back from chain: an OnchainID through the OnchainIDFactory (which
 * pins the KeyManager it is set to, Task 4.11), the KYC and AML claims
 * through the trusted ClaimIssuers (Kyc.attestAll), the registry entry
 * with its country, and the verification cache (Task 4.9). A step whose
 * result already exists is skipped (a claim the issuer still holds live,
 * a cache entry not yet lapsed), so a re-run repairs instead of failing
 * and a second call sends nothing. Options 6, 11, 22, 23, 24, 62 and 89
 * and the smokes call this instead of each keeping its own copy.
 */

const { ethers } = require("hardhat");
const {
  attestKyc,
  attestAml,
  cacheVerification,
  issuerOwnerSigner,
  KYC_TOPIC,
  AML_TOPIC,
} = require("./Kyc");

const ZERO = ethers.ZeroAddress;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The first allowed country of VSC's jurisdiction rule, else 840 (US). */
async function defaultCountry(state) {
  const rules = state.getContract("complianceRules");
  const token = state.getContract("digitalToken");
  if (!rules || !token) return 840;
  try {
    const rule = await rules.getJurisdictionRule(await token.getAddress());
    return rule.allowedCountries.length > 0
      ? Number(rule.allowedCountries[0])
      : 840;
  } catch {
    return 840;
  }
}

/** A loaded wallet that is a registry agent (the deployer, ops), or null. */
async function registryAgent(state) {
  const registry = state.getContract("identityRegistry");
  for (const s of state.signers) {
    if (await registry.isAgent(s.address)) return s;
  }
  return null;
}

/**
 * Onboard `address` (a wallet) as a verified identity.
 *
 * @param {Object} state - DemoState (factory, issuers, registry, signers).
 * @param {string} address - The wallet to onboard.
 * @param {Object} [opts]
 * @param {number} [opts.country] - Registry country; default: the token's
 *   first allowed country, else 840.
 * @param {string} [opts.label] - Folded into the claim data.
 * @param {boolean} [opts.attest=true] - Issue each claim the issuer does
 *   not hold live for the identity (revoked or expired counts as missing).
 * @param {number} [opts.renewWithin=0] - Also re-issue a live claim that
 *   expires within this many seconds (the renew window; 0: none).
 * @param {boolean} [opts.register=true] - Register in the IdentityRegistry.
 * @param {boolean} [opts.cache=true] - refreshVerified after registering,
 *   unless the registry's cache entry for the identity is still live.
 * @param {number} [opts.validTo] - Claim expiry (Kyc.attestKyc default).
 * @param {Function} [opts.log] - Printer for the cache step; silent by default.
 * @returns {Promise<Object>} { identity, created, registered, attested,
 *   cached, verified, gasUsed, receipts: { deploy, register, kyc, aml,
 *   cache } } where every flag says whether this call did the step and
 *   receipts holds only the transactions it sent.
 */
async function onboard(state, address, opts = {}) {
  const factory = state.getContract("onchainIDFactory");
  const registry = state.getContract("identityRegistry");
  const log = opts.log || (() => {});
  const receipts = {};
  let gasUsed = 0n;
  const take = (key, rc) => {
    receipts[key] = rc;
    gasUsed += rc.gasUsed;
  };

  // 1. The identity the registry reads, else the factory's record, else new.
  let identity = registry ? await registry.identity(address) : ZERO;
  let created = false;
  if (same(identity, ZERO)) {
    identity = await factory.getIdentityByOwner(address);
    // Review D2-6: ownerToIdentity is set at creation only, so it may name
    // an identity the wallet no longer owns; adopted only if its own.
    if (
      !same(identity, ZERO) &&
      !(await ownIdentity(factory, address, identity))
    ) {
      throw new Error(
        `factory identity ${identity} of ${address} is not its own (the factory's, owned by it, its one MANAGEMENT key, the pinned recovery manager): not adopted`,
      );
    }
    if (same(identity, ZERO)) {
      const rc = await deployIdentity(
        factory,
        address,
        // A production deploy replays its record (Task 5.7): its salt is
        // stable per wallet (DemoState.production), else random.
        state.production?.identitySalt?.(address) ?? ethers.randomBytes(32),
      );
      if (rc) take("deploy", rc);
      identity = await factory.getIdentityByOwner(address);
      created = true;
    }
  }

  // 2. The registry entry, by a registry agent, with the country.
  let registered = false;
  if (opts.register !== false && registry) {
    if (same(await registry.identity(address), ZERO)) {
      const agent = await registryAgent(state);
      if (!agent) {
        throw new Error(
          `no loaded wallet is an IdentityRegistry agent: cannot register ${address}`,
        );
      }
      const country = opts.country ?? (await defaultCountry(state));
      take(
        "register",
        await (
          await registry
            .connect(agent)
            .registerIdentity(address, identity, country)
        ).wait(),
      );
      registered = true;
    }
  }

  // 3. Each claim the issuer does not hold live (revoked, expired, or
  //    expiring inside the renew window), through the trusted issuers:
  //    the only path IdentityRegistry.isVerified() accepts.
  let attested = false;
  if (opts.attest !== false) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const label = opts.label || `onboard:${address}`;
    for (const [key, topic, attest] of [
      ["kyc", KYC_TOPIC, attestKyc],
      ["aml", AML_TOPIC, attestAml],
    ]) {
      const issuer = state.getContract(`${key}Issuer`);
      if (await claimLive(issuer, identity, topic, now, opts.renewWithin)) {
        continue;
      }
      const signer = await issuerOwnerSigner(state, issuer);
      take(key, await attest(issuer, signer, identity, label, opts.validTo));
      attested = true;
    }
  }

  // 4. The verification cache (Task 4.9), once registered, unless the
  //    registry's entry for the identity is still live.
  let cached = false;
  if (
    opts.cache !== false &&
    registry &&
    !same(await registry.identity(address), ZERO)
  ) {
    const [, until] = await registry.verifiedUntil(identity);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    if (Number(until) <= now) {
      const { receipt } = await cacheVerification(state, address, log);
      if (receipt) {
        take("cache", receipt);
        cached = true;
      }
    }
  }

  const verified = registry ? await registry.isVerified(address) : false;
  return {
    identity,
    created,
    registered,
    attested,
    cached,
    verified,
    gasUsed,
    receipts,
  };
}

/**
 * Whether `id` is `address`'s own factory identity: the factory's, owned
 * by `address`, whose one MANAGEMENT key is `address`'s, pinned to the
 * factory's recovery manager (I-2).
 */
async function ownIdentity(factory, address, id) {
  if (same(id, ZERO) || !(await factory.isOnchainID(id))) return false;
  const oid = await ethers.getContractAt("OnchainID", id);
  const key = ethers.solidityPackedKeccak256(["address"], [address]);
  const keys = await oid.getKeysByPurpose(1);
  const pinned = await factory.recoveryManager();
  return (
    same(await oid.owner(), address) &&
    keys.length === 1 &&
    keys[0] === key &&
    !same(pinned, ZERO) &&
    same(await oid.recoveryManager(), pinned)
  );
}

/**
 * The factory's deployOnchainID for `address` with `salt`: its receipt, or
 * null when another sender's copy of the call mined first (Task 5.7, M-1:
 * the factory is permissionless and the salt is visible while pending).
 * That identity is accepted only if it is `address`'s own (ownIdentity);
 * anything else rethrows the failure.
 */
async function deployIdentity(factory, address, salt) {
  try {
    return await (await factory.deployOnchainID(address, salt)).wait();
  } catch (e) {
    const id = await factory.getIdentityByOwner(address);
    if (!(await ownIdentity(factory, address, id))) throw e;
    return null;
  }
}

/**
 * Whether `issuer` holds a live claim on (identity, topic) that does not
 * expire within `renewWithin` seconds of `now` (0: any live claim counts).
 */
async function claimLive(issuer, identity, topic, now, renewWithin = 0) {
  if (!(await issuer.hasValidClaim(identity, topic))) return false;
  if (!renewWithin) return true;
  const claim = await issuer.issuedClaims(
    await issuer.latestClaimId(identity, topic),
  );
  return claim.validTo === 0n || Number(claim.validTo) - now > renewWithin;
}

module.exports = {
  onboard,
  deployIdentity,
  defaultCountry,
  registryAgent,
  claimLive,
};
