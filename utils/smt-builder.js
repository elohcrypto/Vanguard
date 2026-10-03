const { newMemEmptyTrie } = require("circomlibjs");

/**
 * @title Sanctions sparse Merkle tree (blacklist circuit, Task 3.7)
 * @dev Wraps circomlibjs's SMT (Poseidon; the hashes circomlib's SMTVerifier
 *      checks in circuits/blacklist_membership.circom). Keys are identity
 *      field elements, the same value the whitelist commitment
 *      Poseidon(identity, secret) hides; the demo uses BigInt(OnchainID).
 *      Every listed key holds the value 1; the value is not part of the
 *      non-membership statement.
 */

// BN254 scalar field order: SMTVerifier decomposes the key with
// Num2Bits_strict, so a key must be a canonical field element.
const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Sanctions-tree depth the committed circuit is compiled with:
// BlacklistNonMembership(20, 20).
const SMT_LEVELS = 20;

const LISTED_VALUE = 1n;

function toKey(identity, label = "identity") {
  let v;
  try {
    v = BigInt(identity);
  } catch {
    throw new Error(`${label} is not an integer: ${identity}`);
  }
  if (v <= 0n || v >= SNARK_SCALAR_FIELD) {
    throw new Error(
      `${label} must be in 1..field order - 1 (got ${v.toString()})`,
    );
  }
  return v;
}

/**
 * Build the sanctions tree.
 * @param {Array<bigint|string|number>} identities listed identities
 * @param {number} levels circuit depth (default SMT_LEVELS)
 * @returns {Promise<{root: bigint, tree: object, levels: number, size: number}>}
 *
 * Refuses a duplicate identity and any tree deeper than `levels`: two
 * identities sharing their lowest `levels` bits would need a deeper path
 * than the circuit can check, and every proof against that root that walks
 * the deep branch would fail. An empty list gives root 0 (circomlib's empty
 * tree).
 */
async function buildBlacklistSmt(identities, levels = SMT_LEVELS) {
  if (!Array.isArray(identities)) {
    throw new Error("buildBlacklistSmt: identities must be an array");
  }
  const tree = await newMemEmptyTrie();
  const seen = new Set();
  for (const id of identities) {
    const key = toKey(id, "blacklisted identity");
    if (seen.has(key)) {
      throw new Error(`buildBlacklistSmt: duplicate identity ${key}`);
    }
    seen.add(key);
    await tree.insert(key, LISTED_VALUE);
  }
  for (const key of seen) {
    const res = await tree.find(key);
    if (res.siblings.length > levels) {
      throw new Error(
        `buildBlacklistSmt: identity ${key} sits at depth ${res.siblings.length}, ` +
          `deeper than the circuit's ${levels} levels (identities collide in their low bits)`,
      );
    }
  }
  tree.levels = levels;
  return {
    root: tree.F.toObject(tree.root),
    tree,
    levels,
    size: seen.size,
  };
}

/**
 * True when `identity` is a key of the tree.
 */
async function isListed(tree, identity) {
  const res = await tree.find(toKey(identity));
  return res.found;
}

/**
 * Non-membership witness for the circuit's SMTVerifier (fnc = 1).
 * @param {object} tree tree returned by buildBlacklistSmt
 * @param {bigint|string|number} identity the prover's identity
 * @param {number} levels circuit depth (default the tree's)
 * @returns {Promise<{root: bigint, siblings: bigint[], oldKey: bigint, oldValue: bigint, isOld0: number}>}
 * @throws when the identity is listed: no non-membership witness exists.
 */
async function nonInclusionWitness(tree, identity, levels) {
  const depth = levels || tree.levels || SMT_LEVELS;
  const key = toKey(identity);
  const F = tree.F;
  const res = await tree.find(key);
  if (res.found) {
    throw new Error(
      `Identity ${key} is on the sanctions list: no non-membership proof exists for it`,
    );
  }
  if (res.siblings.length > depth) {
    throw new Error(
      `Non-membership path has ${res.siblings.length} levels, more than the circuit's ${depth}`,
    );
  }
  const siblings = res.siblings.map((s) => F.toObject(s));
  while (siblings.length < depth) siblings.push(0n);
  return {
    root: F.toObject(tree.root),
    siblings,
    // circomlib convention: with isOld0 = 1 the old leaf is unused and set
    // to zero; otherwise it is the leaf found where the key would sit.
    oldKey: res.isOld0 ? 0n : F.toObject(res.notFoundKey),
    oldValue: res.isOld0 ? 0n : F.toObject(res.notFoundValue),
    isOld0: res.isOld0 ? 1 : 0,
  };
}

module.exports = {
  SMT_LEVELS,
  SNARK_SCALAR_FIELD,
  buildBlacklistSmt,
  isListed,
  nonInclusionWitness,
};
