#!/usr/bin/env node
"use strict";
// Phase 4 exit row (plan v2 Task 4.15, D49; every file since Task 4.17,
// CF-6): no hand-written file at or above 500 lines. Hand-written means
// every git-tracked file but the EXEMPT ones below: root files, .github/,
// utils/, circuits/ sources, contracts/, demo/, scripts/, test/, docs/.
// The files that were already at or above 500 when the gate was
// written are allowlisted with their line count then, shrink-only: the
// cap follows the file down. An allowlisted file may not grow past its
// cap; when it shrinks the entry must be lowered to the new count in the
// same commit (so it cannot regrow unnoticed), and once it drops under
// 500 the entry must go. Both say so. Tests and docs on the list are
// split in Phase 5. Exits 1 on any finding;
// `node scripts/ci/line-count-ratchet.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");

const LIMIT = 500;
// Not hand-written, so not counted. Kept short on purpose: a file goes
// here only when a tool writes it.
const EXEMPT = [
  /^contracts\/privacy\/verifiers\//, // snarkjs-generated PLONK verifiers
  /^package-lock\.json$/, // npm writes it
  // binary or build output, none tracked today (circuit keys, wasm, images)
  /\.(zkey|ptau|wasm|r1cs|sym|png|jpe?g|gif|ico|pdf)$/i,
];
// Allowlist, measured at aa65de8 (2026-10-12, the start of Task 4.15);
// empty since Task 5.5 split the last two docs. Keep it empty.
const ALLOW = {};

function lineCount(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// A tracked file with a NUL byte is binary whatever its name: exempt too.
const isBinary = (f) => fs.readFileSync(f).includes(0);
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(
    (f) =>
      f && fs.existsSync(f) && !EXEMPT.some((re) => re.test(f)) && !isBinary(f),
  );

const findings = [];
const seen = new Set();
for (const file of tracked) {
  const n = lineCount(file);
  const cap = ALLOW[file];
  if (cap !== undefined) {
    seen.add(file);
    if (n > cap) {
      findings.push(`${file}: ${n} lines, grew past its allowlisted ${cap}`);
    } else if (n < LIMIT) {
      findings.push(
        `${file}: ${n} lines, now under ${LIMIT}: remove it from ALLOW`,
      );
    } else if (n < cap) {
      findings.push(`${file}: ${n} lines, lower ALLOW to ${n}`);
    }
  } else if (n >= LIMIT) {
    findings.push(`${file}: ${n} lines (limit ${LIMIT}, not allowlisted)`);
  }
}
for (const file of Object.keys(ALLOW)) {
  if (!seen.has(file)) findings.push(`${file}: allowlisted but not tracked`);
}

const scanned = tracked.length;
if (findings.length) {
  for (const f of findings) console.error(`::error::line-count ratchet: ${f}`);
  console.error(`${findings.length} finding(s) over ${scanned} files`);
  process.exit(1);
}
console.log(
  `line-count ratchet: ${scanned} tracked files (${EXEMPT.length} exempt patterns), ` +
    `${Object.keys(ALLOW).length} allowlisted (shrink-only), none at or above ${LIMIT}`,
);
