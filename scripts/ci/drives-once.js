#!/usr/bin/env node
"use strict";
// U2 round 7 (lead ruling R7-C5) and round 8 (lane G's G-CI1): demo and
// deploy-drives split the drives, so every drive script runs exactly once
// across the workflow. The drives are the named smoke and CLI scripts and
// every scripts/ci/*-drive*.sh, so a new drive is counted too. A run is a
// step's `run` command line starting with the script (or after `&&`):
// YAML comments are not parsed into it and whole-line # comments inside a
// run are stripped first, as scripts-referenced.js strips them. No step
// of demo or deploy-drives may set `continue-on-error` or `if:` (either
// lets a drive's failure or its absence pass). Exits 1 naming each fault;
// `node scripts/ci/drives-once.js [ci.yml]`.
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
  const runs = Object.values(jobs)
    .flatMap((j) => j.steps || [])
    .map((s) => String(s.run ?? "").replace(/^\s*#.*$/gm, ""))
    .join("\n");
  const errors = [];
  for (const d of names) {
    const at = new RegExp(
      `(^|&&)\\s*scripts/ci/${esc(d)}\\.sh(?![\\w.-])`,
      "gm",
    );
    const n = (runs.match(at) || []).length;
    if (n !== 1) errors.push(`scripts/ci/${d}.sh runs ${n} times, not once`);
  }
  for (const id of JOBS) {
    const job = jobs[id];
    if (!job) {
      errors.push(`no ${id} job`);
      continue;
    }
    for (const k of ["continue-on-error", "if"]) {
      if (k in job) errors.push(`${id} job sets ${k}`);
      for (const s of job.steps || []) {
        if (k in s) errors.push(`${id} step "${s.name ?? s.run}" sets ${k}`);
      }
    }
  }
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
