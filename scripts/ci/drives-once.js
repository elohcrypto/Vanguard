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
// Round 12 (item B, lane G's GCI11-1, GCI11-2; R12-C3, R12-C5):
// - an npm script a run line reaches is read with its pre/post hooks and
//   what it runs in turn, through flags, aliases (run-script, rum, urn,
//   test, start), `npx`/`npm exec` of a package.json bin, yarn, pnpm and
//   bun, in the root package.json and every workspace package's;
// - outside the drive jobs a run line (or a script it reaches) that
//   builds a command at run time (node -e/-p, sh -c, eval, xargs) is
//   refused, so is any `${{ }}` in it but `${{ matrix.<k> }}` of an
//   integer list, and a token joining that to a path;
// - no BASH_ENV, ENV, SHELLOPTS or BASHOPTS in any env; a local `uses:`
//   is the prepare action only, in any job and any workflow; a symlink
//   under .github/actions is refused, not followed; an action step's
//   `with` is one of the shipped inputs, its shell bash, its run neither
//   redirects nor expands a name indirectly; a drive job's checkout and
//   setup-node take the shipped inputs only.
// Exits 1 naming each fault; `node scripts/ci/drives-once.js [ci.yml]`.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
// Round 12 (B): the package.json reader, split out (the 500-line rule).
const { reached, scriptsOf } = require("./drives-scripts");

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
// Round 12 (B): the inputs each action takes, as shipped (a drive job's
// checkout and setup-node; the local actions' three).
const WITH = {
  checkout: [{ "persist-credentials": false }],
  "setup-node": [{ "node-version": "22", cache: "npm" }],
  "download-artifact": [{ name: "contracts" }],
  "cache/restore": [
    {
      path: "~/.cargo/bin/circom",
      key: "circom-${{ runner.os }}-${{ env.CIRCOM_VERSION }}",
      "fail-on-cache-miss": true,
    },
    {
      path: "build/circuits/powersOfTau28_hez_final_15.ptau",
      key: "ptau-hez-final-15-982372c8",
    },
  ],
};
/** `w`, an action's `with`, is one `uses` takes as shipped ("" if so). */
function shipped(uses, w, at) {
  const k = /^actions\/([\w/-]+)@/.exec(String(uses))?.[1];
  const ok = (WITH[k] ?? []).some(
    (x) => JSON.stringify(x) === JSON.stringify(w ?? {}),
  );
  return ok
    ? []
    : [`${at} with ${JSON.stringify(w ?? {})} is not ${k}'s shipped input`];
}
const PRE = "./.github/actions/prepare";
// Round 12 (B, R12-C3): a command built when the line runs.
const BUILDS =
  /(?:^|[\s;&|(`'"])(node\s+(?:-\S+\s+)*?(?:-e|--eval|-p|--print)(?=[\s=]|$)|(?:ba|da|z)?sh\s+(?:-\w+\s+)*-\w*c\w*(?=\s|$)|eval(?=\s|$)|xargs(?=\s|$))/;
// Round 12 (B): env names that change how every later shell runs.
const SHELLENV = /^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/;
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
 * built from a variable under scripts/ci/ matches, and those of each
 * package script it reaches (`scripts`, scriptsOf()'s).
 */
function hits(text, names, scripts = {}) {
  const out = new Set();
  for (const t of [text, ...reached(text, scripts)]) {
    for (const d of names) if (named([d]).test(t)) out.add(d);
    for (const [, p] of t.matchAll(/scripts\/ci\/([^\s;|&<>()"'`]*)/g)) {
      if (!/[*?[$]/.test(p)) continue;
      const re = new RegExp(
        `^${esc(p.replace(/\$\{?\w*\}?/g, "\0"))
          .replace(/\0|\\\*/g, ".*")
          .replace(/\\\?/g, ".")
          .replace(/\\\[[^\]]*\\\]/g, ".")}$`,
      );
      for (const d of names) if (re.test(`${d}.sh`) || re.test(d)) out.add(d);
    }
  }
  return out;
}

/**
 * Round 12 (B, R12-C5): each fault of `run`, a run line outside the drive
 * jobs of `job`: a command built at run time (in it or a script it
 * reaches), a `${{ }}` but `${{ matrix.<k> }}` of a literal integer list
 * (no include or exclude), and a token joining such a value to a path.
 */
function builds(run, job, scripts, at) {
  const errors = [];
  for (const t of [run, ...reached(run, scripts)]) {
    const m = BUILDS.exec(t);
    if (m) errors.push(`${at} builds a command at run time (${m[1].trim()})`);
  }
  const mx = job.strategy?.matrix;
  const plain =
    mx && typeof mx === "object" && !("include" in mx) && !("exclude" in mx);
  const marked = run.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (all, x) => {
    const k = /^matrix\.([\w-]+)$/.exec(x)?.[1];
    if (plain && Array.isArray(mx[k]) && mx[k].every(Number.isInteger))
      return "\u0001";
    errors.push(`${at} expands ${all} in its run line`);
    return "";
  });
  for (const t of marked.split(/\s+/))
    if (t.includes("\u0001") && /scripts\/ci|\/[A-Za-z._-]/.test(t))
      errors.push(
        `${at} builds a name at run time (${t.replace(/\u0001/g, "${{ matrix }}")})`,
      );
  return errors;
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
    errors.push(...shellEnv(job.env, `${id} job`));
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
      errors.push(...shellEnv(s.env, at));
      if (!drive && String(s.uses ?? "").startsWith("./") && s.uses !== PRE)
        errors.push(`${at} uses ${s.uses}, a local action other than ${PRE}`);
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
          else {
            errors.push(...extra(s.with ?? {}, ok[1], `${at} with`));
            if (ok[1].length) errors.push(...shipped(s.uses, s.with, at));
          }
        } else if ("with" in s) errors.push(`${at} sets with`);
      }
      if (!("run" in s)) continue;
      if (typeof s.run !== "string") {
        errors.push(`${at} run is not a string`);
        continue;
      }
      const run = String(s.run ?? "").trim();
      if (!drive) {
        errors.push(...builds(run, job, scripts, at));
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

/** Round 12 (B): each env name in `env` that changes how a shell runs. */
const shellEnv = (env, at) =>
  Object.keys(env ?? {})
    .filter((k) => SHELLENV.test(k))
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
    // Round 12 (B): any local path but the prepare action.
    ...files
      .filter((f) =>
        [...read(f).matchAll(/uses:\s*["']?(\.\/[^\s"'#]*)/g)].some(
          ([, u]) => u !== PRE,
        ),
      )
      .map((f) => `${path.join(dir, f)} uses a local path other than ${PRE}`),
  ];
}

/**
 * Every action file under `dir`, any depth, action.yml or .yaml, any
 * case; round 12 (B): a symlink there is pushed to `links`, not followed.
 */
function actionFiles(dir, links = []) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      links.push(f);
      return [];
    }
    if (e.isDirectory()) return actionFiles(f, links);
    return /^action\.ya?ml$/i.test(e.name) ? [f] : [];
  });
}

/**
 * Each fault of the local actions under `dir` (.github/actions): a drive
 * run, and (round 11) anything but a composite action of pinned
 * setup-node, download-artifact or cache/restore steps and run lines
 * that never name GITHUB_ENV, BASH_ENV or GITHUB_PATH.
 */
function actions(dir, names, scripts = {}) {
  const errors = [];
  const links = [];
  const files = actionFiles(dir, links);
  for (const l of links)
    errors.push(`${l} is a symlink: refused, not followed`);
  for (const f of files) {
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
      else if ("uses" in s) errors.push(...shipped(s.uses, s.with, at));
      if ("shell" in s && s.shell !== "bash")
        errors.push(`${at} shell is ${s.shell}, not bash`);
      if ("run" in s && typeof s.run !== "string")
        errors.push(`${at} run is not a string`);
      else if (WRITES.test(String(s.run ?? "")))
        errors.push(`${at} names GITHUB_ENV, BASH_ENV or GITHUB_PATH`);
      else if (/[<>]|\$\{!/.test(String(s.run ?? "")))
        errors.push(`${at} redirects or expands a name indirectly`);
      else if (BUILDS.test(String(s.run ?? "")))
        errors.push(`${at} builds a command at run time`);
    }
  }
  return errors;
}

if (require.main === module) {
  const file = process.argv[2] || ".github/workflows/ci.yml";
  const root = path.join(path.dirname(file), "../..");
  const names = drives(path.join(root, "scripts/ci"));
  const scripts = scriptsOf(root);
  const errors = [
    ...check(yaml.load(fs.readFileSync(file, "utf8")), names, scripts),
    ...others(path.dirname(file), file, names, scripts),
    ...actions(path.join(path.dirname(file), "../actions"), names, scripts),
  ];
  errors.forEach((e) => console.error(`::error::${e}`));
  if (errors.length) process.exit(1);
  console.log(`${names.length} drives, each run exactly once in ${file}`);
}
module.exports = { check, drives, others, actions, scriptsOf };
