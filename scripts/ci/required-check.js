#!/usr/bin/env node
"use strict";
// Review E-3 (Q22): `required` is the one check branch protection needs.
// Its needs must equal the other job ids, and its shape is pinned so it
// runs and fails when a need failed or was skipped (a skipped check reads
// as passed). js-yaml is hoisted (mocha, solhint): a loss fails loudly.
const fs = require("fs");
const yaml = require("js-yaml");

const IF = "${{ always() && !github.event.deleted }}";
const RUN = `jq -e 'all(.[]; .result == "success")' <<< "$RESULTS"`;
const ENV = "${{ toJSON(needs) }}";
const show = JSON.stringify;
const list = (ids) => ids.join(", ") || "none";
const without = (ids, set) => list(ids.filter((id) => !set.includes(id)));
function check(doc) {
  const jobs = doc.jobs || {};
  const job = jobs.required;
  if (!job) return ["no `required` job"];
  const step = (job.steps || [])[0] || {};
  const errors = [];
  const only = (at, obj, keys) =>
    Object.keys(obj).forEach(
      (k) => keys.includes(k) || errors.push(`${at} sets ${k}`),
    );
  const pin = (at, got, want) =>
    got === want || errors.push(`${at} is ${show(got)}, not ${show(want)}`);
  // Any other key can skip, soften or rename the check.
  only("required", job, ["if", "needs", "runs-on", "timeout-minutes", "steps"]);
  only("required.steps[0]", step, ["name", "env", "run"]);
  only("required.steps[0].env", step.env || {}, ["RESULTS"]);
  pin("required step count", (job.steps || []).length, 1);
  pin("required.if", job.if, IF);
  pin("required.steps[0].run", step.run, RUN);
  pin("required.steps[0].env.RESULTS", (step.env || {}).RESULTS, ENV);
  if (!Array.isArray(job.needs)) {
    return [...errors, `required.needs is ${show(job.needs)}, not a list`];
  }
  const others = Object.keys(jobs).filter((id) => id !== "required");
  const needs = [...job.needs].sort();
  if (show(needs) === show([...others].sort())) return errors;
  const dup = list(needs.filter((id, i) => needs.indexOf(id) !== i));
  return [
    ...errors,
    `required.needs missing: ${without(others, needs)}; not a job: ` +
      `${without(needs, others)}; duplicate: ${dup}`,
  ];
}

if (require.main === module) {
  const file = process.argv[2] || ".github/workflows/ci.yml";
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  const errors = check(doc);
  errors.forEach((e) => console.error(`::error::${file}: ${e}`));
  if (errors.length) process.exit(1);
  const n = Object.keys(doc.jobs).length - 1;
  console.log(`required needs all ${n} other jobs in ${file}`);
}
module.exports = { check };
