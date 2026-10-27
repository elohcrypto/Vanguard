#!/usr/bin/env node
"use strict";
// U2 round 7 (lead ruling R7-C5), round 8 (lane G's G-CI1) and round 9
// (item E, lane G's GCI1-GCI5 and GCI8): every drive script runs exactly
// once across the workflow, and nothing can hide its failure. The drives
// are the named smoke and CLI scripts and every scripts/ci/*-drive*.sh,
// so a new drive is counted too. Round 9 reads a grammar instead of a
// list of faults:
// - a drive step is any step whose run names a drive script; its run is
//   one line of drive scripts (`scripts/ci/<drive>.sh`, joined by
//   ` && `) and nothing else (no `|| true`, pipe, `false &&`, comment or
//   second line);
// - drive steps live only in the demo and deploy-drives jobs;
// - those jobs and their steps set no continue-on-error, if, strategy or
//   matrix;
// - continue-on-error appears nowhere else in the workflow.
// Exits 1 naming each fault; `node scripts/ci/drives-once.js [ci.yml]`.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const NAMED = ["demo-smoke", "whitelist-cli"];
const JOBS = ["demo", "deploy-drives"];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The drive scripts: the named ones and every *-drive*.sh in `dir`. */
function drives(dir) {
  const found = fs
    .readdirSync(dir)
    .filter((f) => /-drive.*\.sh$/.test(f))
    .map((f) => f.replace(/\.sh$/, ""));
  return [...new Set([...NAMED, ...found])].sort();
}

/** Each fault of workflow `doc` for `names`, as one line. */
function check(doc, names) {
  const jobs = doc.jobs || {};
  const any = new RegExp(
    `scripts/ci/(${names.map(esc).join("|")})\\.sh(?![\\w.-])`,
  );
  const line = new RegExp(
    `^scripts/ci/(${names.map(esc).join("|")})\\.sh( && scripts/ci/(${names.map(esc).join("|")})\\.sh)*$`,
  );
  const ran = Object.fromEntries(names.map((d) => [d, 0]));
  const errors = [];
  const label = (s) => s.name ?? s.uses ?? s.run;
  for (const [id, job] of Object.entries(jobs)) {
    const drive = JOBS.includes(id);
    if ("continue-on-error" in job)
      errors.push(`${id} job sets continue-on-error`);
    if (drive) {
      for (const k of ["if", "strategy", "matrix"])
        if (k in job) errors.push(`${id} job sets ${k}`);
    }
    for (const s of job.steps || []) {
      if ("continue-on-error" in s)
        errors.push(`${id} step "${label(s)}" sets continue-on-error`);
      if (drive) {
        for (const k of ["if", "strategy", "matrix"])
          if (k in s) errors.push(`${id} step "${label(s)}" sets ${k}`);
      }
      const run = String(s.run ?? "").trim();
      if (!any.test(run)) continue;
      if (!drive) {
        errors.push(
          `${id} step "${label(s)}" runs a drive outside ${JOBS.join(" and ")}`,
        );
      } else if (!line.test(run)) {
        errors.push(
          `${id} step "${label(s)}" is not a drive line (scripts/ci/<drive>.sh, joined by " && ")`,
        );
      } else {
        for (const d of run.split(" && "))
          ran[d.replace(/^scripts\/ci\/|\.sh$/g, "")]++;
      }
    }
  }
  for (const d of names) {
    if (ran[d] !== 1)
      errors.push(`scripts/ci/${d}.sh runs ${ran[d]} times, not once`);
  }
  for (const id of JOBS) if (!jobs[id]) errors.push(`no ${id} job`);
  return errors;
}

if (require.main === module) {
  const file = process.argv[2] || ".github/workflows/ci.yml";
  const names = drives(path.join(path.dirname(file), "../../scripts/ci"));
  const errors = check(yaml.load(fs.readFileSync(file, "utf8")), names);
  errors.forEach((e) => console.error(`::error::${e}`));
  if (errors.length) process.exit(1);
  console.log(`${names.length} drives, each run exactly once in ${file}`);
}
module.exports = { check, drives };
