#!/usr/bin/env node
"use strict";
// U2 round 7 (lead ruling R7-C5), round 8 (lane G's G-CI1), round 9
// (item E, lane G's GCI1-GCI5 and GCI8) and round 10 (item C, lane G's
// GCI-9, R10-C2): every drive script runs exactly once across the
// workflow, and nothing can hide its failure. The drives are the named
// smoke and CLI scripts and every scripts/ci/*-drive*.sh, so a new drive
// is counted too. The drive jobs (demo, deploy-drives) follow an
// allow-list; any other key, at any level, is refused by name:
// - job keys: name, runs-on (a GitHub-hosted ubuntu label), needs,
//   timeout-minutes (above 0), env (known names), steps;
// - step keys: name, id, uses (actions/checkout@, actions/setup-node@ or
//   the shipped ./.github/actions/prepare), with (that action's known
//   inputs), run, env (known names, never BASH_ENV);
// - a run there is one line of drive scripts (`scripts/ci/<drive>.sh`,
//   joined by ` && `) and nothing else (no `|| true`, pipe, `false &&`,
//   `cd`, comment or second line);
// - a drive script named anywhere else (`./x-drive.sh`, a `../` path) is
//   refused; no job calls a reusable workflow; continue-on-error appears
//   nowhere; the workflow sets no `defaults`;
// - every other workflow file beside it is refused if it runs a drive
//   script or names a drive job, and every local action
//   (.github/actions/*/action.yml, the shipped prepare included) if it
//   runs a drive script.
// Exits 1 naming each fault; `node scripts/ci/drives-once.js [ci.yml]`.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const NAMED = ["demo-smoke", "whitelist-cli"];
const JOBS = ["demo", "deploy-drives"];
const JOB_KEYS = [
  "name",
  "runs-on",
  "needs",
  "timeout-minutes",
  "env",
  "steps",
];
const STEP_KEYS = ["name", "id", "uses", "with", "run", "env"];
// The variables the drive jobs set today (demo's node and smoke output).
const ENV = ["DEMO_RPC_URL", "DEMO_SMOKE_OUT"];
// Each action a drive job may use, with the inputs it may pass.
const USES = [
  [/^actions\/checkout@[0-9a-f]{40}$/, ["persist-credentials"]],
  [/^actions\/setup-node@[0-9a-f]{40}$/, ["node-version", "cache"]],
  [/^\.\/\.github\/actions\/prepare$/, []],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The drive scripts: the named ones and every *-drive*.sh in `dir`. */
function drives(dir) {
  const found = fs
    .readdirSync(dir)
    .filter((f) => /-drive.*\.sh$/.test(f))
    .map((f) => f.replace(/\.sh$/, ""));
  return [...new Set([...NAMED, ...found])].sort();
}

/** `names` as a script anywhere in a line, by any path to it. */
const named = (names) =>
  new RegExp(`(^|[^\\w.-])(${names.map(esc).join("|")})\\.sh(?![\\w.-])`);

/** Each key of `o` outside `keys`, refused as `${at} sets <key>`. */
const extra = (o, keys, at) =>
  Object.keys(o)
    .filter((k) => !keys.includes(k))
    .map((k) => `${at} sets ${k}`);

/** Each fault of workflow `doc` for `names`, as one line. */
function check(doc, names) {
  const jobs = doc.jobs || {};
  const any = named(names);
  const line = new RegExp(
    `^scripts/ci/(${names.map(esc).join("|")})\\.sh( && scripts/ci/(${names.map(esc).join("|")})\\.sh)*$`,
  );
  const ran = Object.fromEntries(names.map((d) => [d, 0]));
  const errors = [];
  const label = (s) => s.name ?? s.uses ?? s.run;
  if ("defaults" in doc) errors.push("the workflow sets defaults");
  for (const [id, job] of Object.entries(jobs)) {
    const drive = JOBS.includes(id);
    if (Object.keys(job).some((k) => k.trim() === "continue-on-error"))
      errors.push(`${id} job sets continue-on-error`);
    if ("uses" in job)
      errors.push(`${id} job calls the reusable workflow ${job.uses}`);
    if (drive) {
      errors.push(...extra(job, JOB_KEYS, `${id} job`));
      const on = job["runs-on"];
      if (!/^ubuntu-(latest|\d\d\.\d\d)$/.test(on))
        errors.push(
          `${id} job runs on ${on}, not a GitHub-hosted ubuntu label`,
        );
      if (!(job["timeout-minutes"] > 0))
        errors.push(`${id} job timeout-minutes is not above 0`);
      errors.push(...unknownEnv(job.env, `${id} job`));
    }
    for (const s of job.steps || []) {
      const at = `${id} step "${label(s)}"`;
      if (Object.keys(s).some((k) => k.trim() === "continue-on-error"))
        errors.push(`${at} sets continue-on-error`);
      if (drive) {
        errors.push(...extra(s, STEP_KEYS, at));
        errors.push(...unknownEnv(s.env, at));
        if ("uses" in s) {
          const ok = USES.find(([re]) => re.test(String(s.uses)));
          if (!ok)
            errors.push(
              `${at} uses ${s.uses}, not actions/checkout, actions/setup-node or ./.github/actions/prepare`,
            );
          else errors.push(...extra(s.with ?? {}, ok[1], `${at} with`));
        } else if ("with" in s) errors.push(`${at} sets with`);
      }
      if (!("run" in s)) continue;
      const run = String(s.run ?? "").trim();
      if (!drive) {
        if (any.test(run))
          errors.push(`${at} runs a drive outside ${JOBS.join(" and ")}`);
      } else if (!line.test(run)) {
        errors.push(
          `${at} is not a drive line (scripts/ci/<drive>.sh, joined by " && ")`,
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
  return [...new Set(errors)];
}

/** Each env name in `env` the drive jobs do not use, refused by name. */
const unknownEnv = (env, at) =>
  Object.keys(env ?? {})
    .filter((k) => !ENV.includes(k))
    .map((k) => `${at} sets env ${k}`);

/** Each workflow file in `dir` but `main` that runs a drive or names a drive job. */
function others(dir, main, names) {
  const job = new RegExp(`^\\s*(${JOBS.map(esc).join("|")})\\s*:`, "m");
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && f !== path.basename(main))
    .filter((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      return named(names).test(text) || job.test(text);
    })
    .map(
      (f) =>
        `${path.join(dir, f)} runs a drive script or names a drive job: drives run only in ${path.basename(main)}'s ${JOBS.join(" and ")}`,
    );
}

/** Each local action under `dir` (.github/actions) that runs a drive. */
function actions(dir, names) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((a) => ["action.yml", "action.yaml"].map((f) => path.join(dir, a, f)))
    .flat()
    .filter((f) => fs.existsSync(f))
    .filter((f) => named(names).test(fs.readFileSync(f, "utf8")))
    .map((f) => `${f} runs a drive script: drives run only in the drive jobs`);
}

if (require.main === module) {
  const file = process.argv[2] || ".github/workflows/ci.yml";
  const names = drives(path.join(path.dirname(file), "../../scripts/ci"));
  const errors = [
    ...check(yaml.load(fs.readFileSync(file, "utf8")), names),
    ...others(path.dirname(file), file, names),
    ...actions(path.join(path.dirname(file), "../actions"), names),
  ];
  errors.forEach((e) => console.error(`::error::${e}`));
  if (errors.length) process.exit(1);
  console.log(`${names.length} drives, each run exactly once in ${file}`);
}
module.exports = { check, drives, others, actions };
