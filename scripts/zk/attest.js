#!/usr/bin/env node
/**
 * Attestation issuer (plan v2 Task 3.7b, D31 a). A trusted issuer signs an
 * investor's attribute message with an EdDSA Baby Jubjub key (Poseidon);
 * the investor proves the signature and the policy with
 * scripts/zk/prove-attestation.js, and PrivacyManager trusts the issuer's
 * public key (Ax, Ay) per circuit. Library for the demo and the tests, and
 * a CLI:
 *
 *   # once: a fresh issuer key; printed ONCE with its public key, keep it offline
 *   node scripts/zk/attest.js --new-key
 *   # the public key of a key (for the setTrustedAttestor vote)
 *   ATTESTOR_KEY=0x.. node scripts/zk/attest.js --public-key
 *   # sign an attestation for an investor
 *   ATTESTOR_KEY=0x.. node scripts/zk/attest.js --sign --circuit jurisdiction \
 *        --identity <OnchainID> --country <ISO 3166-1 numeric> \
 *        --rpc <url> --privacy-manager <addr> --valid-days 365 [--out att.json]
 *        (or --valid-until <ISO date>: the expiry is required)
 *        (offline: --mask <the code's PrivacyManager.jurisdictionBit>)
 *        ... --circuit accreditation --amount <amount>
 *        ... --circuit compliance --scores <kyc,aml,jurisdiction,accreditation>
 *
 * The key comes from env ATTESTOR_KEY only (32 bytes, 0x hex), never argv,
 * and is never printed except by --new-key. The message is
 * M = Poseidon(domain, chainId, verifierContext, validUntil, identity,
 * attributes..., salt) with a per-circuit domain (jurisdiction 1, accreditation 2,
 * compliance 3), so an attestation signed for one circuit never verifies in
 * another, and the chain id and PrivacyManager address (verifierContext) it
 * is for (--chain-id and --privacy-manager, or the chain id read from
 * --rpc): PrivacyManager refuses one signed for another chain or contract
 * (Task 3.8 M1). validUntil (unix seconds) is the expiry the issuer sets
 * (Task 3.10): PrivacyManager refuses the proof from then on and no record
 * outlives it; a new attestation renews. --sign refuses without one and
 * refuses a date not in the future (the chain's time with --rpc). The salt
 * is 31 fresh random bytes. Output, the attestation handed to the investor
 * (it carries the salt and the signature: treat it as the investor's
 * secret): { circuit, chainId, privacyManager, validUntil, identity,
 * attributes, salt, R8x, R8y, S, Ax, Ay }, decimal strings, on stdout; with
 * --out it goes only to that file (created with mode 0600, an existing file
 * is refused) and stdout carries the path, the expiry and the public
 * (Ax, Ay). Fields and validation: ./attestation-fields.js. Plain node; no
 * hardhat runtime.
 */

const crypto = require("crypto");
const fs = require("fs");
const { ethers } = require("ethers");
const {
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
} = require("./attestation-fields");
const { toField } = require("./build-whitelist-root");

let eddsaPromise;
let poseidonPromise;
/** Shared circomlibjs instances. */
function eddsa() {
  eddsaPromise ??= require("circomlibjs").buildEddsa();
  return eddsaPromise;
}
function poseidon() {
  poseidonPromise ??= require("circomlibjs").buildPoseidon();
  return poseidonPromise;
}

/** A fresh issuer key: 32 random bytes, 0x hex. */
function newAttestorKey() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

/** Parse an issuer key (never named in an error). */
function toAttestorKey(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new Error("attestor key: expected 32 bytes as 0x-prefixed hex");
  }
  return Buffer.from(value.trim().slice(2), "hex");
}

/** The issuer's public key { Ax, Ay } (bigints). */
async function attestorPublicKey(key) {
  const e = await eddsa();
  const A = e.prv2pub(toAttestorKey(key));
  return { Ax: e.F.toObject(A[0]), Ay: e.F.toObject(A[1]) };
}

/** keccak256(abi.encode(Ax, Ay)): PrivacyManager's trustedAttestor key. */
function attestorId(Ax, Ay) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [BigInt(Ax), BigInt(Ay)],
    ),
  );
}

/**
 * M = Poseidon(domain, chainId, verifierContext, validUntil, identity,
 * attributes..., salt); verifierContext = the PrivacyManager address as a
 * field element.
 */
async function attestationMessage(
  circuit,
  chainId,
  privacyManager,
  validUntil,
  identity,
  attributes,
  salt,
) {
  const p = await poseidon();
  return p.F.toObject(
    p([
      circuitOf(circuit).domain,
      chainId,
      BigInt(privacyManager),
      validUntil,
      identity,
      ...attributes,
      salt,
    ]),
  );
}

/**
 * Sign an attestation.
 * @param {Object} p
 * @param {string} p.key - the issuer key (0x, 32 bytes); never logged
 * @param {string} p.circuit - jurisdiction | accreditation | compliance
 * @param {*} p.chainId - the chain the attestation is for
 * @param {string} p.privacyManager - the PrivacyManager it is for
 * @param {*} p.validUntil - the expiry, unix seconds (required; not checked
 *        against the clock here: the CLI refuses a past date)
 * @param {*} p.identity - OnchainID address or field element
 * @param {*} [p.mask] [p.amount] [p.scores] - the circuit's attributes
 * @param {bigint} [p.salt] - tests only; default 31 fresh random bytes
 * @returns {Promise<Object>} { circuit, chainId, privacyManager, validUntil,
 *          identity, attributes, salt, R8x, R8y, S, Ax, Ay }, decimal strings (the
 *          address checksummed)
 */
async function signAttestation({
  key,
  circuit,
  chainId,
  privacyManager,
  validUntil,
  identity,
  salt,
  ...attrs
}) {
  const prv = toAttestorKey(key);
  const chain = toChainId(chainId);
  const pm = toPrivacyManager(privacyManager);
  const until = toValidUntil(validUntil);
  const id = toIdentity(identity);
  const attributes = parseAttributes(circuit, attrs);
  const s = salt ?? BigInt("0x" + crypto.randomBytes(31).toString("hex"));
  const e = await eddsa();
  const M = await attestationMessage(
    circuit,
    chain,
    pm,
    until,
    id,
    attributes,
    s,
  );
  const sig = e.signPoseidon(prv, e.F.e(M));
  const { Ax, Ay } = await attestorPublicKey(key);
  return {
    circuit,
    chainId: chain.toString(),
    privacyManager: pm,
    validUntil: until.toString(),
    identity: id.toString(),
    attributes: attributes.map(String),
    salt: s.toString(),
    R8x: e.F.toObject(sig.R8[0]).toString(),
    R8y: e.F.toObject(sig.R8[1]).toString(),
    S: sig.S.toString(),
    Ax: Ax.toString(),
    Ay: Ay.toString(),
  };
}

/**
 * Parse and check an attestation (from signAttestation or its file): every
 * field canonical, the attributes valid for the circuit and the signature
 * valid under (Ax, Ay). Error messages never carry the salt or signature.
 * @returns {Promise<Object>} the attestation with bigint fields
 */
async function loadAttestation(a) {
  if (!a || typeof a !== "object")
    throw new Error("attestation: not an object");
  circuitOf(a.circuit);
  const names = CIRCUITS[a.circuit].attributes;
  if (!Array.isArray(a.attributes) || a.attributes.length !== names.length) {
    throw new Error(
      `attestation: ${a.circuit} carries ${names.length} attribute(s)`,
    );
  }
  const attrs =
    a.circuit === "compliance"
      ? { scores: a.attributes }
      : { [names[0]]: a.attributes[0] };
  const att = {
    circuit: a.circuit,
    chainId: toChainId(a.chainId),
    privacyManager: toPrivacyManager(a.privacyManager),
    validUntil: toValidUntil(a.validUntil),
    identity: toIdentity(a.identity),
    attributes: parseAttributes(a.circuit, attrs),
  };
  for (const k of ["salt", "R8x", "R8y", "S", "Ax", "Ay"]) {
    att[k] = toField(a[k], `attestation ${k}`);
  }
  const e = await eddsa();
  att.verifierContext = BigInt(att.privacyManager);
  const M = await attestationMessage(
    att.circuit,
    att.chainId,
    att.privacyManager,
    att.validUntil,
    att.identity,
    att.attributes,
    att.salt,
  );
  let ok = false;
  try {
    ok = e.verifyPoseidon(
      e.F.e(M),
      { R8: [e.F.e(att.R8x), e.F.e(att.R8y)], S: att.S },
      [e.F.e(att.Ax), e.F.e(att.Ay)],
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      "attestation: the signature does not verify under its (Ax, Ay) for these fields",
    );
  }
  return att;
}

/**
 * The bit PrivacyManager assigned to an ISO 3166-1 numeric code (Task 3.8),
 * and whether ComplianceRules allows the code for the policy token now. A
 * code without a bit cannot be attested until the owner (a PrivacyParameters
 * vote after the handover) calls registerJurisdictionCode.
 * @returns {Promise<{code: bigint, bit: bigint, active: boolean}>}
 */
async function countryBit({ country, privacyManager, runner }) {
  const code = toUint(country, "country", 999n);
  if (code === 0n) throw new Error("country: zero");
  const pm = new ethers.Contract(
    privacyManager,
    [
      "function jurisdictionBit(uint256) view returns (uint256)",
      "function isJurisdictionActive(uint256) view returns (bool)",
    ],
    runner,
  );
  const bit = await pm.jurisdictionBit(code);
  if (bit === 0n) {
    throw new Error(
      `country ${code}: no jurisdiction bit on PrivacyManager (owner: registerJurisdictionCode)`,
    );
  }
  return { code, bit, active: await pm.isJurisdictionActive(code) };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--(key|attestor-key|private-key)(=|$)/.test(a)) {
      throw new Error(
        "never pass the issuer key on the command line (argv is visible to other processes): use env ATTESTOR_KEY",
      );
    }
    // Not echoed: a mistyped key would land in the logs.
    if (!a.startsWith("--")) throw new Error("unexpected positional argument");
    const k = a.slice(2);
    if (["new-key", "public-key", "sign", "help"].includes(k)) args[k] = true;
    else if (
      [
        "circuit",
        "identity",
        "mask",
        "country",
        "rpc",
        "privacy-manager",
        "chain-id",
        "valid-until",
        "valid-days",
        "amount",
        "scores",
        "out",
      ].includes(k)
    ) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      args[k] = argv[++i];
    } else throw new Error(`unknown option ${a}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/zk/attest.js --new-key
       node scripts/zk/attest.js --public-key
       node scripts/zk/attest.js --sign --circuit <jurisdiction|accreditation|compliance>
            --identity <id> --privacy-manager <addr> (--rpc <url> | --chain-id <n>)
            (--country <iso> (needs --rpc) | --mask <m> | --amount <a> | --scores <k,a,j,acc>)
            (--valid-days <n> | --valid-until <ISO date>) [--out <file>]
Key: env ATTESTOR_KEY (0x, 32 bytes).`;

function readKey(env) {
  if (!env.ATTESTOR_KEY) throw new Error("no issuer key: set env ATTESTOR_KEY");
  return env.ATTESTOR_KEY.trim();
}

async function main(keyBox) {
  const out = (s) => process.stdout.write(s + "\n");
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return out(USAGE);
  if (args["new-key"]) {
    const key = newAttestorKey();
    const { Ax, Ay } = await attestorPublicKey(key);
    console.error(
      "The private key is printed once: store it offline; it is never shown again.",
    );
    return out(
      JSON.stringify(
        { privateKey: key, Ax: Ax.toString(), Ay: Ay.toString() },
        null,
        2,
      ),
    );
  }
  keyBox.value = readKey(process.env);
  if (args["public-key"]) {
    const { Ax, Ay } = await attestorPublicKey(keyBox.value);
    return out(
      JSON.stringify({ Ax: Ax.toString(), Ay: Ay.toString() }, null, 2),
    );
  }
  if (!args.sign) throw new Error(USAGE);
  if (!args.circuit || args.identity === undefined) {
    throw new Error(`--circuit and --identity are required\n${USAGE}`);
  }
  // Task 3.8 M1: the attestation is for one chain and one PrivacyManager.
  if (!args["privacy-manager"]) {
    throw new Error(`--privacy-manager is required\n${USAGE}`);
  }
  const provider = args.rpc ? new ethers.JsonRpcProvider(args.rpc) : null;
  let chainId = args["chain-id"];
  if (provider) {
    const live = (await provider.getNetwork()).chainId;
    if (chainId !== undefined && toChainId(chainId) !== live) {
      throw new Error(`--chain-id ${chainId} is not --rpc's chain ${live}`);
    }
    chainId = live;
  }
  if (chainId === undefined) {
    throw new Error("--chain-id or --rpc is required");
  }
  // Task 3.10: the issuer sets the expiry; the chain's time with --rpc.
  const now = provider
    ? (await provider.getBlock("latest")).timestamp
    : Math.floor(Date.now() / 1000);
  const validUntil = validityFromArgs(
    { validUntil: args["valid-until"], validDays: args["valid-days"] },
    now,
  );
  let mask = args.mask;
  if (args.country !== undefined) {
    if (args.circuit !== "jurisdiction" || mask !== undefined) {
      throw new Error(
        "--country is for --circuit jurisdiction, without --mask",
      );
    }
    if (!provider) {
      throw new Error("--country needs --rpc (offline: --mask)");
    }
    const c = await countryBit({
      country: args.country,
      privacyManager: args["privacy-manager"],
      runner: provider,
    });
    mask = c.bit;
    console.error(
      `country ${c.code}: bit ${c.bit}${c.active ? "" : " (ComplianceRules does not allow it for the policy token now: a proof fails until it does)"}`,
    );
  }
  const att = await signAttestation({
    key: keyBox.value,
    circuit: args.circuit,
    chainId,
    privacyManager: args["privacy-manager"],
    validUntil,
    identity: args.identity,
    mask,
    amount: args.amount,
    scores: args.scores,
  });
  console.error(`attestation expires ${isoOf(validUntil)}`);
  const json = JSON.stringify(att, null, 2);
  if (!args.out) return out(json);
  // The attestation is a bearer credential: with --out it goes to the file
  // only (created 0600, never overwriting one), and stdout carries nothing
  // secret.
  fs.writeFileSync(args.out, json + "\n", { mode: 0o600, flag: "wx" });
  out(
    JSON.stringify(
      {
        out: args.out,
        circuit: att.circuit,
        validUntil: isoOf(validUntil),
        Ax: att.Ax,
        Ay: att.Ay,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  const keyBox = {};
  main(keyBox).then(
    () => process.exit(0),
    (e) => {
      // No message names the key, but scrub it anyway.
      let msg = String(e && e.message);
      const k = keyBox.value;
      if (k && k.length >= 4) {
        msg = msg.split(k).join("<key>").split(k.slice(2)).join("<key>");
      }
      console.error(`attest: ${msg}`);
      process.exit(1);
    },
  );
}

module.exports = {
  CIRCUITS,
  circuitOf,
  newAttestorKey,
  attestorPublicKey,
  attestorId,
  signAttestation,
  loadAttestation,
  attestationMessage,
  countryBit,
};
