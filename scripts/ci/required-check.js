#!/usr/bin/env node
"use strict";
// Review E-3 (Q22): branch protection requires one check, the `required`
// job in .github/workflows/ci.yml. Its needs must equal every other job
// id, so a new job cannot be left out, and its `if` must hold always(),
// so a failed or skipped need fails it instead of skipping it (protection
// reads a skipped check as passed). Exits 1 on any gap;
// `node scripts/ci/required-check.js [workflow.yml]`.
// js-yaml is not a direct dependency: npm ci hoists 4.x from mocha and
// solhint. Losing it fails the require loudly; a regex would miss quietly.
const fs = require("fs");
const yaml = require("js-yaml");

// The parsed workflow -> one string per gap, [] when clean.
function check(doc) {
  const jobs = doc.jobs || {};
  const required = jobs.required;
  if (!required) return ["no `required` job"];
  const errors = [];
  if (!String(required.if).includes("always()")) {
    errors.push(`required.if is ${JSON.stringify(required.if)}, without always()`);
  }
  const others = Object.keys(jobs)
    .filter((id) => id !== "required")
    .sort();
  const needs = [].concat(required.needs || []).sort();
  const missing = others.filter((id) => !needs.includes(id));
  const extra = needs.filter((id) => !others.includes(id));
  if (missing.length || extra.length) {
    errors.push(
      `required.needs [${needs.join(", ")}] differs from the other jobs ` +
        `[${others.join(", ")}]; missing: ${missing.join(", ") || "none"}; ` +
        `not a job: ${extra.join(", ") || "none"}`,
    );
  }
  return errors;
}

function main() {
  const file = process.argv[2] || ".github/workflows/ci.yml";
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  const errors = check(doc);
  errors.forEach((e) => console.error(`::error::${file}: ${e}`));
  if (errors.length) process.exit(1);
  const n = Object.keys(doc.jobs).length - 1;
  console.log(`required needs all ${n} other jobs in ${file}`);
}

if (require.main === module) main();
module.exports = { check };
