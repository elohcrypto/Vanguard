#!/usr/bin/env node
"use strict";
// Audit ratchet: npm audit's high count may not RISE above the baseline
// in audit-baseline.json (its `why` and `history` carry the reasons and
// every change of the number). A drop prints a notice to lower it. A
// missing or non-numeric count fails: an audit that did not run is not
// a pass. Exits 1 on a finding; `node scripts/ci/audit-ratchet.js`.
const { spawnSync } = require("child_process");

const { high: BASELINE } = require("./audit-baseline.json");
if (!Number.isInteger(BASELINE) || BASELINE < 0) {
  console.error(
    `::error::audit-baseline.json high is not a count: ${BASELINE}`,
  );
  process.exit(1);
}
const audit = (...args) =>
  spawnSync("npm", ["audit", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

let count;
try {
  count = JSON.parse(audit("--json").stdout).metadata.vulnerabilities.high;
} catch (e) {
  count = undefined;
}
console.log(`high vulnerabilities: ${count} (baseline ${BASELINE})`);
if (!Number.isInteger(count)) {
  console.error(`::error::npm audit gave no numeric high count: '${count}'`);
  process.exit(1);
}
if (count > BASELINE) {
  console.error(
    `::error::High-severity count rose from ${BASELINE} to ${count}.`,
  );
  process.stdout.write(audit("--audit-level=high").stdout);
  process.exit(1);
}
if (count < BASELINE) {
  console.log(
    `::notice::High count dropped to ${count} — lower high in scripts/ci/audit-baseline.json.`,
  );
}
