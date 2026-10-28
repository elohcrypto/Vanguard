"use strict";
// U2 round 13 (item C, lane G's round-12 hides; R13-C1, R13-C5, R13-C6):
// the deny-list grammar failed twice (GCI11, lane G round 12), so the gate
// refuses what it does not know. scripts/ci/run-lines.json holds every run
// line and `uses:` of ci.yml's jobs but the drive jobs, and the prepare
// action's run lines, each with its job key ("./.github/actions/prepare"
// for the action); an unlisted line or uses is refused by name, in ci.yml,
// in any second workflow and in the action. An edit of a run line or uses
// there needs the table's edit in the same PR, by design. For drives-once.js
// (split out of it by the 500-line rule).
const fs = require("fs");
const path = require("path");
const { reached } = require("./drives-scripts");

const TABLE = "scripts/ci/run-lines.json";
// What `npm ci|install|pack|version` may run of package.json's scripts.
const LIFE = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
  "preversion",
  "version",
  "postversion",
];
const NPM_LIFE = /^npm\s+(ci|install|pack|version)(?=\s|$)/;

/** The table at `root` (job key -> its run lines and uses), else null. */
function table(root) {
  const f = path.join(root, TABLE);
  if (!fs.existsSync(f)) return null;
  const t = {};
  for (const e of JSON.parse(fs.readFileSync(f, "utf8"))) {
    const k = (t[e.job] ??= { run: new Set(), uses: new Set() });
    if ("run" in e) k.run.add(String(e.run).trim());
    if ("uses" in e) k.uses.add(String(e.uses));
  }
  return t;
}

/** Each run line or uses of step `s` of `job` that `tab` does not list. */
function unlisted(tab, job, s) {
  const k = tab?.[job];
  const out = [];
  const run = String(s.run ?? "").trim();
  if ("run" in s && !k?.run.has(run))
    out.push(`run line not in ${TABLE}: ${job}: ${run}`);
  if ("uses" in s && !k?.uses.has(String(s.uses)))
    out.push(`uses not in ${TABLE}: ${job}: ${s.uses}`);
  return out;
}

/**
 * Each lifecycle script of package.json (`scripts`, scriptsOf()'s) that
 * `run`, an `npm ci|install|pack|version` line, runs and `bad` names
 * (bad(text) -> "runs a drive" | "builds a command at run time" | "").
 */
function lifecycle(run, scripts, at, bad) {
  const m = NPM_LIFE.exec(run);
  if (!m) return [];
  const out = [];
  for (const k of LIFE) {
    if (typeof scripts[k] !== "string") continue;
    const why = [scripts[k], ...reached(scripts[k], scripts)]
      .map(bad)
      .find(Boolean);
    if (why) out.push(`${at} runs npm ${m[1]}, whose ${k} script ${why}`);
  }
  return out;
}

/** Each .npmrc under `root` (node_modules and .git skipped) setting script-shell. */
function npmrc(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink())
      return e.name === "node_modules" || e.name === ".git" ? [] : npmrc(root, f);
    if (e.name !== ".npmrc") return [];
    return /^\s*script-shell\s*=/m.test(fs.readFileSync(f, "utf8"))
      ? [`${path.relative(root, f)} sets script-shell`]
      : [];
  });
}

/**
 * Each value of `o` (an env or a with) naming a drive or scripts/ci/
 * (`bad`, drives-once.js's verdict()), refused as `${at} <key> names a drive`.
 */
const drivey = (o, at, bad) =>
  Object.entries(o && typeof o === "object" ? o : {})
    .filter(([, v]) => /scripts\/ci\//.test(String(v)) || bad(String(v)) === "runs a drive")
    .map(([k]) => `${at} ${k} names a drive`);

/** Each run line and uses of workflow file `f` that `tab` does not list. */
function workflow(f, tab) {
  let doc;
  try {
    doc = require("js-yaml").load(fs.readFileSync(f, "utf8")) ?? {};
  } catch {
    return [`${f} is not YAML`];
  }
  return Object.entries(doc.jobs ?? {}).flatMap(([id, j]) =>
    (j?.steps ?? []).flatMap((s) => unlisted(tab, id, s)),
  );
}

module.exports = { TABLE, table, unlisted, lifecycle, npmrc, drivey, workflow };
