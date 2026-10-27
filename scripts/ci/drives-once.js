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
// Round 11 (item B, lane G's GCI10-1): the workflow around the drive
// jobs follows an allow-list too:
// - top-level keys: name, on, permissions, concurrency, env, jobs; the
//   workflow's env sets CIRCOM_VERSION only (a BASH_ENV or SHELLOPTS
//   there reaches every run step); job keys are lower-case;
// - runs-on and every run are strings; the drive jobs' env values keep
//   their shipped shape (DEMO_RPC_URL on 127.0.0.1, DEMO_SMOKE_OUT a
//   /tmp/<name>.json file);
// - a run outside the drive jobs that may run a drive (a glob or a name
//   built from a variable under scripts/ci/, or an npm script whose
//   package.json line does) counts toward "runs once" and is refused;
// - every local action file (action.yml or action.yaml, any case, any
//   depth) is a composite action whose steps only use actions/setup-node,
//   download-artifact or cache/restore by SHA or run lines that never
//   name GITHUB_ENV, BASH_ENV or GITHUB_PATH, and runs no drive;
// - a second workflow file that may run a drive, names a drive job
//   (quoted or not) or calls ci.yml is refused.
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
// The variables the drive jobs set today (demo's node and smoke output),
// each with the shape of its shipped value.
const VALUES = {
  DEMO_RPC_URL: [/^http:\/\/127\.0\.0\.1:\d+$/, "a http://127.0.0.1:<port> URL"],
  DEMO_SMOKE_OUT: [/^\/tmp\/[\w.-]+\.json$/, "a /tmp/<name>.json file"],
};
const ENV = Object.keys(VALUES);
const TOP = ["name", "on", "permissions", "concurrency", "env", "jobs"];
// What a step of a local action may use or name.
const ACTION_USES =
  /^actions\/(setup-node|download-artifact|cache\/restore)@[0-9a-f]{40}$/;
const ACTION_KEYS = ["name", "uses", "with", "run", "shell"];
const WRITES = /GITHUB_ENV|BASH_ENV|GITHUB_PATH/;
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

/**
 * The drives `text` may run: each named in it, each a glob or a name
 * built from a variable under scripts/ci/ matches, and those of each npm
 * script it runs (`scripts`, package.json's).
 */
function hits(text, names, scripts = {}, seen = new Set()) {
  const out = new Set(names.filter((d) => named([d]).test(text)));
  for (const [, p] of text.matchAll(/scripts\/ci\/([^\s;|&<>()"'`]*)/g)) {
    if (!/[*?[$]/.test(p)) continue;
    const re = new RegExp(
      `^${esc(p.replace(/\$\{?\w*\}?/g, "\0"))
        .replace(/\0|\\\*/g, ".*")
        .replace(/\\\?/g, ".")
        .replace(/\\\[[^\]]*\\\]/g, ".")}$`,
    );
    for (const d of names) if (re.test(`${d}.sh`) || re.test(d)) out.add(d);
  }
  const npm = /\bnpm\s+(?:run(?:-script)?\s+(?:-\S+\s+)*([\w:.-]+)|(test|t|start)\b)/g;
  for (const [, a, b] of text.matchAll(npm)) {
    const k = a ?? (b === "t" ? "test" : b);
    if (seen.has(k) || typeof scripts[k] !== "string") continue;
    seen.add(k);
    for (const d of hits(scripts[k], names, scripts, seen)) out.add(d);
  }
  return out;
}

/** Each key of `o` outside `keys`, refused as `${at} sets <key>`. */
const extra = (o, keys, at) =>
  Object.keys(o)
    .filter((k) => !keys.includes(k))
    .map((k) => `${at} sets ${k}`);

/** Each fault of workflow `doc` for `names`, as one line. */
function check(doc, names, scripts = {}) {
  const jobs = doc.jobs || {};
  const any = named(names);
  const line = new RegExp(
    `^scripts/ci/(${names.map(esc).join("|")})\\.sh( && scripts/ci/(${names.map(esc).join("|")})\\.sh)*$`,
  );
  const ran = Object.fromEntries(names.map((d) => [d, 0]));
  const errors = [];
  const label = (s) => s.name ?? s.uses ?? s.run;
  if ("defaults" in doc) errors.push("the workflow sets defaults");
  errors.push(...extra(doc, TOP, "the workflow"));
  errors.push(
    ...Object.keys(doc.env ?? {})
      .filter((k) => k !== "CIRCOM_VERSION")
      .map((k) => `the workflow sets env ${k}`),
  );
  for (const [id, job] of Object.entries(jobs)) {
    const drive = JOBS.includes(id);
    if (!/^[a-z][a-z0-9-]*$/.test(id))
      errors.push(`job key ${id} is not lower-case`);
    if (Object.keys(job).some((k) => k.trim() === "continue-on-error"))
      errors.push(`${id} job sets continue-on-error`);
    if ("uses" in job)
      errors.push(`${id} job calls the reusable workflow ${job.uses}`);
    if (drive) {
      errors.push(...extra(job, JOB_KEYS, `${id} job`));
      const on = job["runs-on"];
      if (typeof on !== "string" || !/^ubuntu-(latest|\d\d\.\d\d)$/.test(on))
        errors.push(
          `${id} job runs on ${typeof on === "string" ? on : JSON.stringify(on)}, not a GitHub-hosted ubuntu label`,
        );
      if (!(job["timeout-minutes"] > 0))
        errors.push(`${id} job timeout-minutes is not above 0`);
      errors.push(...unknownEnv(job.env, `${id} job`));
      errors.push(...badValue(job.env, `${id} job`));
    }
    for (const s of job.steps || []) {
      const at = `${id} step "${label(s)}"`;
      if (Object.keys(s).some((k) => k.trim() === "continue-on-error"))
        errors.push(`${at} sets continue-on-error`);
      if (drive) {
        errors.push(...extra(s, STEP_KEYS, at));
        errors.push(...unknownEnv(s.env, at));
        errors.push(...badValue(s.env, at));
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
      if (typeof s.run !== "string") {
        errors.push(`${at} run is not a string`);
        continue;
      }
      const run = String(s.run ?? "").trim();
      if (!drive) {
        if (any.test(run))
          errors.push(`${at} runs a drive outside ${JOBS.join(" and ")}`);
        else {
          const may = hits(run, names, scripts);
          if (may.size)
            errors.push(`${at} runs a drive outside ${JOBS.join(" and ")}`);
          for (const d of may) ran[d]++;
        }
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

/** Each value of `env` off its shipped shape, refused by name. */
const badValue = (env, at) =>
  Object.entries(env ?? {})
    .filter(([k, v]) => VALUES[k] && !VALUES[k][0].test(String(v)))
    .map(([k, v]) => `${at} env ${k} is ${v}, not ${VALUES[k][1]}`);

/** Each workflow file in `dir` but `main` that runs a drive or names a drive job. */
function others(dir, main, names, scripts = {}) {
  const job = new RegExp(`^\\s*(${JOBS.map(esc).join("|")})\\s*:`, "m");
  // Round 11 (B): quoted or any case; a call of `main` itself.
  const quoted = new RegExp(`^\\s*["']?(${JOBS.map(esc).join("|")})["']?\\s*:`, "mi");
  const calls = new RegExp(`uses:\\s*["']?\\.?/?\\.github/workflows/${esc(path.basename(main))}`);
  const main0 = path.basename(main);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && f !== main0);
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  return [
    ...files
      .filter((f) => {
        const text = read(f);
        return (
          named(names).test(text) ||
          job.test(text) ||
          quoted.test(text) ||
          hits(text, names, scripts).size > 0
        );
      })
      .map(
        (f) =>
          `${path.join(dir, f)} runs a drive script or names a drive job: drives run only in ${main0}'s ${JOBS.join(" and ")}`,
      ),
    ...files
      .filter((f) => calls.test(read(f)))
      .map((f) => `${path.join(dir, f)} calls ${main0}: it runs only once`),
  ];
}

/** Every action file under `dir`, any depth, action.yml or .yaml, any case. */
function actionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? actionFiles(path.join(dir, e.name))
        : /^action\.ya?ml$/i.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );
}

/**
 * Each fault of the local actions under `dir` (.github/actions): a drive
 * run, and (round 11) anything but a composite action of pinned
 * setup-node, download-artifact or cache/restore steps and run lines
 * that never name GITHUB_ENV, BASH_ENV or GITHUB_PATH.
 */
function actions(dir, names, scripts = {}) {
  const errors = [];
  for (const f of actionFiles(dir)) {
    const text = fs.readFileSync(f, "utf8");
    if (named(names).test(text) || hits(text, names, scripts).size)
      errors.push(`${f} runs a drive script: drives run only in the drive jobs`);
    let doc;
    try {
      doc = yaml.load(text) ?? {};
    } catch (x) {
      errors.push(`${f} is not YAML: ${x.message.split("\n")[0]}`);
      continue;
    }
    const using = doc.runs?.using;
    if (using !== "composite")
      errors.push(`${f} runs using ${using}, not composite`);
    for (const s of doc.runs?.steps ?? []) {
      const at = `${f} step "${s.name ?? s.uses ?? s.run}"`;
      errors.push(...extra(s, ACTION_KEYS, at));
      if ("uses" in s && !ACTION_USES.test(String(s.uses)))
        errors.push(
          `${at} uses ${s.uses}, not setup-node, download-artifact or cache/restore`,
        );
      if ("run" in s && typeof s.run !== "string")
        errors.push(`${at} run is not a string`);
      else if (WRITES.test(String(s.run ?? "")))
        errors.push(`${at} names GITHUB_ENV, BASH_ENV or GITHUB_PATH`);
    }
  }
  return errors;
}

if (require.main === module) {
  const file = process.argv[2] || ".github/workflows/ci.yml";
  const root = path.join(path.dirname(file), "../..");
  const names = drives(path.join(root, "scripts/ci"));
  const pkg = path.join(root, "package.json");
  const scripts = fs.existsSync(pkg)
    ? (JSON.parse(fs.readFileSync(pkg, "utf8")).scripts ?? {})
    : {};
  const errors = [
    ...check(yaml.load(fs.readFileSync(file, "utf8")), names, scripts),
    ...others(path.dirname(file), file, names, scripts),
    ...actions(path.join(path.dirname(file), "../actions"), names, scripts),
  ];
  errors.forEach((e) => console.error(`::error::${e}`));
  if (errors.length) process.exit(1);
  console.log(`${names.length} drives, each run exactly once in ${file}`);
}
module.exports = { check, drives, others, actions };
