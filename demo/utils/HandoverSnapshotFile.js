/**
 * @fileoverview Handover ceremony, plan v2 Task 5.6b (review B-6): the
 * preflight snapshot file and its hash.
 *
 * The full phase writes `<config>.snapshot.json` and, beside it,
 * `<config>.snapshot.json.sha256` (one `sha256sum` line: the hex digest of
 * the file's bytes, two spaces, the path). Both are written atomically to
 * a new path and renamed into place, so a read-only file left at either
 * path by an earlier run is replaced, not written through; the temporary
 * files are created before the deployer's first transaction, so a
 * directory the CLI cannot write stops the run before step 1. The accept
 * phase hashes the file before it parses it and refuses a digest that
 * differs from the sidecar's or from HANDOVER_SNAPSHOT_SHA256 (the digest
 * the full phase printed, from the run's records). The variable is
 * required (SnapshotDigestMissing): the sidecar sits next to the file, so
 * only the recorded digest proves the pair was not rewritten together.
 */

const crypto = require("crypto");
const fs = require("fs");

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const sidecarOf = (p) => `${p}.sha256`;
const tmpOf = (p) => `${p}.tmp`;

/** A named refusal: err.name SnapshotHashMismatch, message starts so. */
function mismatch(msg) {
  return Object.assign(new Error(`snapshot hash mismatch: ${msg}`), {
    name: "SnapshotHashMismatch",
  });
}

/** Task 5.6b round 2: the operator's recorded digest is required. */
function missingDigest(p) {
  return Object.assign(
    new Error(
      `snapshot digest missing: set HANDOVER_SNAPSHOT_SHA256 to the digest the full phase printed for ${p} ("snapshot sha256: <hex>", kept in the run's records); the sidecar alone cannot prove the file was not rewritten with it`,
    ),
    { name: "SnapshotDigestMissing" },
  );
}

/**
 * Before any transaction: create the two temporary files, proving the
 * directory is writable. Returns a release() that removes them (call it
 * when the run stops before writeSnapshotFile).
 */
function reserveSnapshotFile(p) {
  for (const f of [tmpOf(p), tmpOf(sidecarOf(p))]) fs.writeFileSync(f, "");
  return () => {
    for (const f of [tmpOf(p), tmpOf(sidecarOf(p))])
      fs.rmSync(f, { force: true });
  };
}

/** Write `data` (an object) and its digest; returns { digest, replaced }. */
function writeSnapshotFile(p, data) {
  const bytes = Buffer.from(JSON.stringify(data, null, 2));
  const digest = sha256(bytes);
  const replaced = fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
  fs.writeFileSync(tmpOf(p), bytes);
  fs.renameSync(tmpOf(p), p);
  // The file first: a crash between the renames leaves a pair that
  // disagrees, which the accept phase refuses.
  fs.writeFileSync(tmpOf(sidecarOf(p)), `${digest}  ${p}\n`);
  fs.renameSync(tmpOf(sidecarOf(p)), sidecarOf(p));
  return { digest, replaced };
}

/**
 * The parsed snapshot after its digest matched the sidecar's and
 * `expected` (HANDOVER_SNAPSHOT_SHA256, required). Throws
 * SnapshotDigestMissing or SnapshotHashMismatch otherwise; returns
 * { snap, digest }.
 */
function readSnapshotFile(p, expected) {
  if (!expected) throw missingDigest(p);
  const bytes = fs.readFileSync(p);
  const digest = sha256(bytes);
  const side = sidecarOf(p);
  if (!fs.existsSync(side)) {
    throw mismatch(
      `${side} is missing: nothing records the digest the full phase wrote for ${p}; run the full phase again`,
    );
  }
  const recorded = fs.readFileSync(side, "utf8").trim().split(/\s+/)[0];
  if (recorded !== digest) {
    throw mismatch(
      `${p} hashes to ${digest}, but ${side} records ${recorded}: the file was edited after the full phase wrote it; a completion against it is a re-run, not a pass`,
    );
  }
  if (expected.toLowerCase() !== digest) {
    throw mismatch(
      `${p} hashes to ${digest}, but HANDOVER_SNAPSHOT_SHA256 is ${expected}: the file and its sidecar are not the pair the full phase printed`,
    );
  }
  return { snap: JSON.parse(bytes.toString("utf8")), digest };
}

module.exports = {
  reserveSnapshotFile,
  writeSnapshotFile,
  readSnapshotFile,
  sidecarOf,
};
