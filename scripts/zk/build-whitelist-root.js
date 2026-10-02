#!/usr/bin/env node
/**
 * Whitelist root builder (plan v2 Task 3.5; D29/D30, R-3R-10).
 *
 * The operator receives one commitment Poseidon(identity, secret) per
 * onboarded investor, never the secret, and publishes the Merkle root of
 * those commitments on PrivacyManager. This file is both the library the
 * demo and the tests call and the operator's CLI:
 *
 *   node scripts/zk/build-whitelist-root.js --in entries.json --out root.json
 *
 * entries.json: [{ "identity": "<decimal|0x>", "commitment": "<decimal|0x>" }]
 * root.json:    { root, depth: 20, leaves, count, builtAt }; the root alone
 *               goes to stdout. Investors prove against root.json
 *               (scripts/zk/prove-whitelist.js), so publish it with the root.
 *
 * Leaf order is input order: the same entries in the same order always give
 * the same root (builtAt is the only field that changes). Refused: an empty
 * list, more than 2^20 leaves, a second entry for one identity (one
 * commitment per identity per root, D29/D30), a repeated commitment, a value
 * that is not a canonical BN254 scalar field element, and commitment 0 (the
 * value of an empty leaf).
 *
 * Optional, for ops: --publish --rpc <url> --privacy-manager <addr> with the
 * listOperator's key in env WHITELIST_OPS_KEY sends publishWhitelistRoot.
 * Plain node + ethers; no hardhat runtime.
 */

const fs = require("fs");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");

/** Depth of the whitelist_membership circuit. */
const DEPTH = 20;
const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const hex32 = (v) => "0x" + v.toString(16).padStart(64, "0");

/**
 * Parse a field element given as a bigint, a safe integer, or a decimal or
 * 0x-hex string. The error names `label` only, never the value, so a secret
 * passed here cannot leak through a message.
 */
function toField(value, label) {
  let v;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number" && Number.isSafeInteger(value))
    v = BigInt(value);
  else if (
    typeof value === "string" &&
    /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value.trim())
  )
    v = BigInt(value.trim());
  else throw new Error(`${label}: expected a decimal or 0x-hex field element`);
  if (v < 0n || v >= SNARK_SCALAR_FIELD) {
    throw new Error(
      `${label}: not a canonical field element (must be below the BN254 scalar field)`,
    );
  }
  return v;
}

/** Smallest accepted secret: 128 bits of entropy at least. */
const MIN_SECRET = 2n ** 128n;

/**
 * Parse the investor's secret (never named in an error). Below 2^128 it is
 * refused: the leaves are public (every investor gets root.json) and the
 * identities are OnchainID addresses, public in the IdentityRegistry, so a
 * small secret is found by trying values against the leaf, and whoever
 * finds it proves for their own wallet first and takes the per-root
 * nullifier (D29). Make one with prove-whitelist.js --new-secret.
 */
function toSecret(value) {
  const s = toField(value, "secret");
  if (s < MIN_SECRET) {
    throw new Error(
      "secret: below 2^128, so it can be brute-forced from the public leaf and identity, and whoever recovers it binds their own wallet first; generate one with `node scripts/zk/prove-whitelist.js --new-secret`",
    );
  }
  return s;
}

let builderPromise;
/** One initialised Poseidon instance, shared by every call. */
function poseidonBuilder() {
  builderPromise ??= (async () => {
    const b = new MerkleTreeBuilder(DEPTH);
    await b.initialize();
    return b;
  })();
  return builderPromise;
}

/**
 * The investor's commitment Poseidon(identity, secret) (D30 a), the value
 * handed to the operator at onboarding.
 */
async function computeCommitment(identity, secret) {
  const id = toField(identity, "identity");
  const s = toSecret(secret);
  return (await poseidonBuilder()).commitment(id, s);
}

/**
 * Validate the operator's entries and return them as field elements.
 * @returns {{identity: bigint, commitment: bigint}[]}
 */
function parseEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("entries: expected a non-empty array");
  }
  if (entries.length > 2 ** DEPTH) {
    throw new Error(
      `entries: ${entries.length} exceed the ${2 ** DEPTH} leaves a depth-${DEPTH} tree holds`,
    );
  }
  const byIdentity = new Map();
  const byCommitment = new Map();
  return entries.map((e, i) => {
    if (!e || typeof e !== "object") {
      throw new Error(`entry ${i}: expected { identity, commitment }`);
    }
    const identity = toField(e.identity, `entry ${i} identity`);
    const commitment = toField(e.commitment, `entry ${i} commitment`);
    if (identity === 0n) {
      throw new Error(`entry ${i}: identity 0 is not an OnchainID`);
    }
    if (commitment === 0n) {
      throw new Error(`entry ${i}: commitment 0 is the empty-leaf value`);
    }
    if (byIdentity.has(identity)) {
      throw new Error(
        `entry ${i}: identity ${identity} already has a commitment (entry ${byIdentity.get(identity)}); one commitment per identity per root (D29/D30)`,
      );
    }
    if (byCommitment.has(commitment)) {
      throw new Error(
        `entry ${i}: commitment ${hex32(commitment)} repeats entry ${byCommitment.get(commitment)}`,
      );
    }
    byIdentity.set(identity, i);
    byCommitment.set(commitment, i);
    return { identity, commitment };
  });
}

/**
 * Build the whitelist root file from the operator's entries.
 * @param {{identity, commitment}[]} entries - leaf order = input order
 * @returns {Promise<{root: string, depth: number, leaves: string[],
 *          count: number, builtAt: string}>} root and leaves as 0x 32-byte hex
 */
async function buildWhitelistRoot(entries) {
  const commitments = parseEntries(entries).map((e) => e.commitment);
  const tree = await MerkleTreeBuilder.createFromCommitments(
    commitments,
    DEPTH,
  );
  return {
    root: hex32(tree.getRoot()),
    depth: DEPTH,
    leaves: commitments.map(hex32),
    count: commitments.length,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Check a root file and rebuild its tree: the root must be the root of its
 * leaves. Refuses a tampered or truncated file before anyone proves on it.
 * @returns {Promise<{root: bigint, leaves: bigint[]}>}
 */
async function loadRootFile(file) {
  if (!file || typeof file !== "object")
    throw new Error("root file: not an object");
  if (file.depth !== DEPTH) {
    throw new Error(
      `root file: depth ${JSON.stringify(file.depth)}, expected the number ${DEPTH}`,
    );
  }
  if (!Array.isArray(file.leaves) || file.leaves.length === 0) {
    throw new Error("root file: no leaves");
  }
  if (file.count !== undefined && file.count !== file.leaves.length) {
    throw new Error(
      `root file: count ${file.count} != ${file.leaves.length} leaves`,
    );
  }
  const root = toField(file.root, "root file root");
  const leaves = file.leaves.map((l, i) => toField(l, `root file leaf ${i}`));
  if (leaves.includes(0n) || new Set(leaves).size !== leaves.length) {
    throw new Error("root file: a zero or repeated leaf");
  }
  const tree = await MerkleTreeBuilder.createFromCommitments(leaves, DEPTH);
  if (tree.getRoot() !== root) {
    throw new Error("root file: the root is not the root of its leaves");
  }
  return { root, leaves };
}

/**
 * The PrivacyManager surface the two CLIs use, custom errors included so a
 * revert reads as its name (NotListOperator, RootNotCurrent, ...).
 */
const PM_ABI = [
  "function publishWhitelistRoot(bytes32 root)",
  "function whitelistRoot() view returns (bytes32)",
  "function whitelistVersion() view returns (uint256)",
  "function listOperator() view returns (address)",
  "function owner() view returns (address)",
  "function submitWhitelistProof(uint256[24] proof, uint256[3] signals)",
  "function whitelistBindings(address) view returns (uint256 version, uint256 nullifier, uint256 expiresAt)",
  "function hasValidWhitelistProof(address) view returns (bool)",
  "error NotListOperator()",
  "error InvalidWhitelistRoot()",
  "error RootNotCurrent()",
  "error WalletBindingMismatch()",
  "error NullifierBoundToOtherWallet(address wallet, uint256 version)",
  "error InvalidWhitelistProof()",
];

/** PrivacyManager at `address` for `runner` (a signer or a provider). */
function privacyManagerAt(address, runner) {
  const { ethers } = require("ethers");
  return new ethers.Contract(address, PM_ABI, runner);
}

/** A revert as `Name(args)` when it is a PrivacyManager error. */
function revertReason(e) {
  if (e && e.revert && e.revert.name) {
    return `${e.revert.name}(${e.revert.args.map(String).join(", ")})`;
  }
  return String((e && (e.shortMessage || e.message)) || e);
}

/** Who may publish: the list operator, or the owner while none is set. */
async function publisherOf(pm) {
  const { ethers } = require("ethers");
  const op = await pm.listOperator();
  return op === ethers.ZeroAddress
    ? `the owner ${await pm.owner()} (no list operator set)`
    : `the list operator ${op} (or the owner)`;
}

/**
 * Publish the root on PrivacyManager as the list operator (or owner).
 * @param {Object} p
 * @param {string} p.root - 0x 32-byte root
 * @param {string} p.privacyManager - address
 * @param {Object} p.signer - ethers signer of ops (the CLI builds it)
 * @returns {Promise<{version: string, txHash: string|null}>}
 */
async function publishRoot({ root, privacyManager, signer }) {
  const pm = privacyManagerAt(privacyManager, signer);
  if ((await pm.whitelistRoot()) === root) {
    return { version: (await pm.whitelistVersion()).toString(), txHash: null };
  }
  let rx;
  try {
    rx = await (await pm.publishWhitelistRoot(root)).wait();
  } catch (e) {
    throw new Error(
      `publishWhitelistRoot reverted: ${revertReason(e)}; ${await publisherOf(pm)} publishes`,
    );
  }
  return { version: (await pm.whitelistVersion()).toString(), txHash: rx.hash };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error("unexpected positional argument");
    const key = a.slice(2);
    if (["publish", "help"].includes(key)) args[key] = true;
    else if (["in", "out", "rpc", "privacy-manager"].includes(key)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      args[key] = argv[++i];
    } else throw new Error(`unknown option ${a}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/zk/build-whitelist-root.js --in <entries.json> [--out <root.json>]
         [--publish --rpc <url> --privacy-manager <addr>]   (key: env WHITELIST_OPS_KEY)
entries.json: [{ "identity": "<decimal|0x>", "commitment": "<decimal|0x>" }]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.in) throw new Error(`--in is required\n${USAGE}`);
  const file = await buildWhitelistRoot(
    JSON.parse(fs.readFileSync(args.in, "utf8")),
  );
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(file, null, 2) + "\n");
    console.error(`root file (${file.count} commitments) -> ${args.out}`);
  }
  if (args.publish) {
    if (
      !args.rpc ||
      !args["privacy-manager"] ||
      !process.env.WHITELIST_OPS_KEY
    ) {
      throw new Error(
        "--publish needs --rpc, --privacy-manager and env WHITELIST_OPS_KEY",
      );
    }
    const { ethers } = require("ethers");
    const p = await publishRoot({
      root: file.root,
      privacyManager: args["privacy-manager"],
      signer: new ethers.Wallet(
        process.env.WHITELIST_OPS_KEY,
        new ethers.JsonRpcProvider(args.rpc),
      ),
    });
    console.error(
      p.txHash
        ? `published (version ${p.version}, tx ${p.txHash})`
        : `already the current root (version ${p.version})`,
    );
  }
  console.log(file.root);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`build-whitelist-root: ${e.message}`);
      process.exit(1);
    },
  );
}

module.exports = {
  DEPTH,
  SNARK_SCALAR_FIELD,
  hex32,
  toField,
  toSecret,
  MIN_SECRET,
  computeCommitment,
  buildWhitelistRoot,
  loadRootFile,
  publishRoot,
  PM_ABI,
  privacyManagerAt,
  revertReason,
  publisherOf,
};
