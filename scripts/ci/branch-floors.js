#!/usr/bin/env node
"use strict";
// Per-contract branch floors (plan v2 Task 5.10; CF-7). Reads a
// solidity-coverage coverage.json and asserts each contract's branch
// figure (arms hit / arms total) for the named run against its floor in
// branch-floors.json. Two runs exist in CI:
//  - "contracts": the ZK_PROOFS=0 suite (scripts/ci/coverage-ratchet.sh);
//  - "proofs": the proof suites alone (scripts/ci/zk-coverage.sh), the
//    only run in which PrivacyManager's proof-gated branches execute.
// A floor is a minimum: a figure below it fails, a figure 2+ points
// above a floor under 80 prints a notice to raise it. A listed contract
// missing from the json fails (a renamed file must not pass silently),
// and so does one with no branch arms recorded (nothing was measured).
// Exits 1 on any finding;
// `node scripts/ci/branch-floors.js <run> [coverage.json]`.
const fs = require("fs");
const path = require("path");

const { floors } = require("./branch-floors.json");
const [run, file = "coverage.json"] = process.argv.slice(2);
const mine = floors.filter((f) => f.run === run);
if (!mine.length) {
  const runs = [...new Set(floors.map((f) => f.run))].join(", ");
  console.error(`usage: branch-floors.js <run> [coverage.json]; runs: ${runs}`);
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`::error::branch floors: ${file} not found`);
  process.exit(1);
}
const cov = JSON.parse(fs.readFileSync(file, "utf8"));

/** Branch percentage of the contract whose path ends in `suffix`. */
function branchPct(suffix) {
  const key = Object.keys(cov).find((k) =>
    k.split(path.sep).join("/").endsWith(suffix),
  );
  if (!key) return null;
  let hit = 0;
  let total = 0;
  for (const arms of Object.values(cov[key].b)) {
    total += arms.length;
    hit += arms.filter((n) => n > 0).length;
  }
  return total ? (100 * hit) / total : NaN;
}

let failed = false;
for (const { contract, min } of mine) {
  const pct = branchPct(contract);
  if (pct === null) {
    console.error(`::error::branch floors: ${contract} not in ${file}`);
    failed = true;
    continue;
  }
  if (Number.isNaN(pct)) {
    console.error(
      `::error::branch floors: ${contract} has no branch arms in ${file} (not instrumented?)`,
    );
    failed = true;
    continue;
  }
  const shown = pct.toFixed(2);
  console.log(`${contract}: ${shown}% branches (floor ${min}, run ${run})`);
  if (Number(shown) < min) {
    console.error(
      `::error::${contract} branch coverage ${shown}% is below its floor ${min}%`,
    );
    failed = true;
  } else if (min < 80 && Number(shown) >= min + 2) {
    console.log(
      `::notice::${contract} branches ${shown}%: raise its floor in scripts/ci/branch-floors.json`,
    );
  }
}
process.exit(failed ? 1 : 0);
