/**
 * Attestation fields (split from scripts/zk/attest.js, Task 3.10): the three
 * attestation circuits and the validation of every field an issuer signs,
 * the expiry included. Plain node; no hardhat runtime.
 */

const { ethers } = require("ethers");
const { toField } = require("./build-whitelist-root");

/** The three attestation circuits: CLI name -> circuit id, domain, build name. */
const CIRCUITS = {
  jurisdiction: {
    id: ethers.id("JURISDICTION_PROOF"),
    domain: 1n,
    build: "jurisdiction_proof",
    attributes: ["mask"],
  },
  accreditation: {
    id: ethers.id("ACCREDITATION_PROOF"),
    domain: 2n,
    build: "accreditation_proof",
    attributes: ["amount"],
  },
  compliance: {
    id: ethers.id("COMPLIANCE_AGGREGATION"),
    domain: 3n,
    build: "compliance_aggregation",
    attributes: ["kyc", "aml", "jurisdiction", "accreditation"],
  },
};

const MAX_64 = 2n ** 64n;

function circuitOf(name) {
  const c = CIRCUITS[name];
  if (!c) {
    throw new Error(
      `circuit: expected one of ${Object.keys(CIRCUITS).join(", ")}`,
    );
  }
  return c;
}

/** An integer attribute in [0, max]; the error names the label only. */
function toUint(value, label, max) {
  const v = toField(value, label);
  if (v > max) throw new Error(`${label}: above ${max}`);
  return v;
}

/**
 * The circuit's attributes, validated, in circuit order.
 * jurisdiction { mask }: exactly one bit, below 2^64 (a jurisdiction bit);
 * accreditation { amount }: below 2^64; compliance { scores: [4] } each 0..100.
 */
function parseAttributes(circuit, { mask, amount, scores }) {
  if (circuit === "jurisdiction") {
    const m = toUint(mask, "mask", MAX_64 - 1n);
    if (m === 0n || (m & (m - 1n)) !== 0n) {
      throw new Error("mask: must be one jurisdiction bit (a power of two)");
    }
    return [m];
  }
  if (circuit === "accreditation") {
    return [toUint(amount, "amount", MAX_64 - 1n)];
  }
  circuitOf(circuit);
  const list = Array.isArray(scores) ? scores : String(scores).split(",");
  if (list.length !== 4) {
    throw new Error("scores: four values kyc,aml,jurisdiction,accreditation");
  }
  return list.map((s, i) =>
    toUint(s, `score ${CIRCUITS.compliance.attributes[i]}`, 100n),
  );
}

/** A non-zero field element; the error names `label` only. */
function nonZero(value, label) {
  const v = toField(value, label);
  if (v === 0n) throw new Error(`${label}: zero`);
  return v;
}
/** The identity (the OnchainID address, or any field element); the chain id. */
const toIdentity = (identity) => nonZero(identity, "identity");
const toChainId = (chainId) => nonZero(chainId, "chainId");

/**
 * The expiry the issuer signs (Task 3.10): unix seconds, non-zero and below
 * 2^64 (the circuits range-check it). PrivacyManager refuses the proof from
 * that time on and caps the record's expiresAt at it.
 */
function toValidUntil(value) {
  if (value === undefined || value === null) {
    throw new Error("validUntil: required (the attestation's expiry)");
  }
  return nonZero(toUint(value, "validUntil", MAX_64 - 1n), "validUntil");
}

/** A unix time (seconds) as an ISO date, for messages. */
const isoOf = (t) => new Date(Number(t) * 1000).toISOString();

/**
 * validUntil from the CLI: exactly one of --valid-until <ISO date> and
 * --valid-days <n>, and after `now` (unix seconds).
 */
function validityFromArgs({ validUntil, validDays }, now) {
  if ((validUntil === undefined) === (validDays === undefined)) {
    throw new Error(
      "the issuer sets the expiry: pass --valid-until <ISO date> or --valid-days <n> (one of them)",
    );
  }
  let t;
  if (validDays !== undefined) {
    if (!/^[1-9][0-9]{0,5}$/.test(String(validDays))) {
      throw new Error("--valid-days: a whole number of days, 1 or more");
    }
    t = BigInt(now) + BigInt(validDays) * 86400n;
  } else {
    const ms = Date.parse(String(validUntil));
    if (Number.isNaN(ms)) throw new Error("--valid-until: not an ISO date");
    t = BigInt(Math.floor(ms / 1000));
  }
  if (t <= BigInt(now)) {
    throw new Error(`--valid-until ${isoOf(t)} is not in the future`);
  }
  return toValidUntil(t);
}

/** The PrivacyManager an attestation is for, checksummed and non-zero. */
function toPrivacyManager(address) {
  let a;
  try {
    a = ethers.getAddress(String(address));
  } catch {
    throw new Error("privacyManager: not an address");
  }
  if (a === ethers.ZeroAddress) throw new Error("privacyManager: zero");
  return a;
}

module.exports = {
  CIRCUITS,
  circuitOf,
  toUint,
  parseAttributes,
  toIdentity,
  toChainId,
  toValidUntil,
  validityFromArgs,
  isoOf,
  toPrivacyManager,
};
