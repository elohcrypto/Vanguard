#!/usr/bin/env node
"use strict";
// Audit ratchet: npm audit's high count may not RISE above the baseline
// in audit-baseline.json (its `why` and `history` carry the reasons and
// every change of the number), and neither may the production tree's
// (`npm audit --omit=dev`, baseline `omitDev.high`). A drop prints a
// notice to lower the baseline. A missing or non-numeric count or
// baseline fails: an audit that did not run is not a pass. Exits 1 on a
// finding; `node scripts/ci/audit-ratchet.js`.
const { spawnSync } = require("child_process");

const isCount = (n) => Number.isInteger(n) && n >= 0;

// One ratchet per tree: { label, baseline, live, field } -> findings.
function ratchet({ label, baseline, live, field }) {
  const out = { log: [], errors: [], notices: [] };
  if (!isCount(baseline)) {
    out.errors.push(`audit-baseline.json ${field} is not a count: ${baseline}`);
    return out;
  }
  out.log.push(`high vulnerabilities${label}: ${live} (baseline ${baseline})`);
  if (!isCount(live)) {
    out.errors.push(`npm audit${label} gave no numeric high count: '${live}'`);
  } else if (live > baseline) {
    out.errors.push(
      `High-severity count${label} rose from ${baseline} to ${live}.`,
    );
  } else if (live < baseline) {
    out.notices.push(
      `High count${label} dropped to ${live} — lower ${field} in scripts/ci/audit-baseline.json.`,
    );
  }
  return out;
}

// The baseline file -> the two ratchets' inputs; live counts injected.
function checks(base, live) {
  return [
    ratchet({ label: "", baseline: base.high, live: live.all, field: "high" }),
    ratchet({
      label: ", --omit=dev",
      baseline: base.omitDev && base.omitDev.high,
      live: live.omitDev,
      field: "omitDev.high",
    }),
  ];
}

function main() {
  const base = require("./audit-baseline.json");
  const audit = (...args) =>
    spawnSync("npm", ["audit", ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  const high = (...args) => {
    try {
      return JSON.parse(audit(...args, "--json").stdout).metadata
        .vulnerabilities.high;
    } catch (e) {
      return undefined;
    }
  };
  const results = checks(base, { all: high(), omitDev: high("--omit=dev") });
  let failed = false;
  for (const r of results) {
    r.log.forEach((l) => console.log(l));
    r.notices.forEach((n) => console.log(`::notice::${n}`));
    r.errors.forEach((e) => console.error(`::error::${e}`));
    if (r.errors.length) failed = true;
  }
  if (failed) {
    process.stdout.write(audit("--audit-level=high").stdout);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { checks };
