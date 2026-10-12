/**
 * @fileoverview The demo's one onboarding path (plan v2 Task 4.16, L-6).
 *
 * A wallet becomes a verified identity in four idempotent steps, each
 * read back from chain: an OnchainID through the OnchainIDFactory (which
 * pins the KeyManager it is set to, Task 4.11), the KYC and AML claims
 * through the trusted ClaimIssuers (Kyc.attestAll), the registry entry
 * with its country, and the verification cache (Task 4.9). A step whose
 * result already exists is skipped, so a re-run repairs instead of
 * failing. Options 6, 11, 22, 23, 24, 62 and 89 and the smokes call this
 * instead of each keeping its own copy of the steps.
 */

const { ethers } = require("hardhat");
const { attestAll, cacheVerification } = require("./Kyc");

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
 * @param {boolean} [opts.attest=true] - Issue the KYC and AML claims.
 * @param {boolean} [opts.register=true] - Register in the IdentityRegistry.
 * @param {boolean} [opts.cache=true] - refreshVerified after registering.
 * @param {number} [opts.validTo] - Claim expiry (Kyc.attestAll default).
 * @param {Function} [opts.log] - Printer for the cache step; silent by default.
 * @returns {Promise<Object>} { identity, created, registered, attested,
 *   cached, verified, gasUsed, receipts: { deploy, kyc, aml, register,
 *   cache } } where every flag says whether this call did the step.
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
    if (same(identity, ZERO)) {
      take(
        "deploy",
        await (
          await factory.deployOnchainID(address, ethers.randomBytes(32))
        ).wait(),
      );
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

  // 3. Both claims, through the trusted issuers (the only verifying path).
  let attested = false;
  if (opts.attest !== false) {
    const { kyc, aml } = await attestAll(
      state,
      identity,
      opts.label || `onboard:${address}`,
      opts.validTo,
    );
    take("kyc", kyc);
    take("aml", aml);
    attested = true;
  }

  // 4. The verification cache (Task 4.9), once registered.
  let cached = false;
  if (
    opts.cache !== false &&
    registry &&
    !same(await registry.identity(address), ZERO)
  ) {
    const { receipt } = await cacheVerification(state, address, log);
    if (receipt) {
      take("cache", receipt);
      cached = true;
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

module.exports = { onboard, defaultCountry, registryAgent };
