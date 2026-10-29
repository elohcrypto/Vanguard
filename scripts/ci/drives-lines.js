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
// Round 14 (item B, lane G's round-13 hides; R14-C3, R14-C4, R14-C9): a
// uses entry is the step's full literal, its uses and its `with` (absent =
// {}), compared as `<uses> with <JSON of with, keys sorted>` (literal());
// every uses is one, the drive jobs' and the prepare action's too. The
// table is a regular file; .npmrc keys node-options, shell and
// onload-script are refused beside script-shell; so is npm's implicit
// node-gyp install (gyp()).
// Round 15 (A, R15-C1): an .npmrc key as npm's ini reads it (npmrcKeys()),
// userconfig and globalconfig refused too.
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
  // Round 14 (R14-C9): npm ci and npm install run these too (npm 10.9.8).
  "prepublish",
  "preprepare",
  "postprepare",
  "dependencies",
];
const NPM_LIFE = /^npm\s+(ci|install|pack|version)(?=\s|$)/;

/** A uses step's full literal: its uses and its with, keys sorted. */
const literal = (s) =>
  `${s.uses} with ${JSON.stringify(Object.fromEntries(Object.entries(s.with ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))}`;

/** The table at `root` (job key -> its run lines and uses), else null. */
function table(root) {
  const f = path.join(root, TABLE);
  // Round 14 (R14-C3, lane G H11): a regular file, never a symlink.
  if (!fs.lstatSync(f, { throwIfNoEntry: false })?.isFile()) return null;
  const t = {};
  for (const e of JSON.parse(fs.readFileSync(f, "utf8"))) {
    const k = (t[e.job] ??= { run: new Set(), uses: new Set() });
    if ("run" in e) k.run.add(String(e.run).trim());
    if ("uses" in e) k.uses.add(literal(e));
  }
  return t;
}

/** Each run line (if `runs`) or uses of step `s` of `job` that `tab` does not list. */
function unlisted(tab, job, s, runs = true) {
  const k = tab?.[job];
  const out = [];
  const run = String(s.run ?? "").trim();
  if (runs && "run" in s && !k?.run.has(run))
    out.push(`run line not in ${TABLE}: ${job}: ${run}`);
  if ("uses" in s && !k?.uses.has(literal(s)))
    out.push(`uses not in ${TABLE}: ${job}: ${literal(s)}`);
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

/** Each .npmrc under `root` (node_modules and .git skipped) setting a key that runs code. */
function npmrc(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink())
      return e.name === "node_modules" || e.name === ".git" ? [] : npmrc(root, f);
    if (e.name !== ".npmrc") return [];
    return npmrcKeys(fs.readFileSync(f, "utf8"))
      .filter((k) => NPMRC.has(k))
      .map((k) => `${path.relative(root, f)} sets ${k}`);
  });
}
// The keys that run code or name another config file (R15-C1).
const NPMRC = new Set(["script-shell", "node-options", "shell", "onload-script", "userconfig", "globalconfig"]);

/**
 * Round 15 (A, R15-C1, lane G G14-1): each line's key as npm's ini 5.0.0
 * decode() reads it: blank and ;/# lines skipped, the text before the
 * first `=` (unsafe(): trimmed; quoted, the quotes off and JSON read; else
 * cut at an unescaped ; or #). Keys are case-sensitive. Sections are not
 * tracked: a key under [x] stays refused (over-refusal, as at effed74).
 */
const npmrcKeys = (text) =>
  text.split(/[\r\n]+/).flatMap((line) => {
    const m = /^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/.exec(line);
    return !m || m[1] !== undefined || /^\s*([;#]|$)/.test(line) ? [] : [unsafe(m[2])];
  });
function unsafe(v) {
  v = v.trim();
  if (/^(".*"|'.*')$/s.test(v)) {
    try {
      return JSON.parse(v[0] === "'" ? v.slice(1, -1) : v);
    } catch {
      return v[0] === "'" ? v.slice(1, -1) : v;
    }
  }
  let out = "", esc = false;
  for (const c of v) {
    if (esc) {
      out += "\\;#".includes(c) ? c : `\\${c}`;
      esc = false;
    } else if (";#".includes(c)) break;
    else if (c === "\\") esc = true;
    else out += c;
  }
  return (esc ? `${out}\\` : out).trim();
}

/** Round 14 (R14-C3, lane G H18): npm's implicit `node-gyp rebuild` install. */
function gyp(root) {
  const p = path.join(root, "package.json");
  return [
    ...(fs.existsSync(path.join(root, "binding.gyp"))
      ? ["binding.gyp at the root: npm installs it with node-gyp rebuild"]
      : []),
    ...(fs.existsSync(p) && "gypfile" in JSON.parse(fs.readFileSync(p, "utf8"))
      ? ["package.json sets gypfile"]
      : []),
  ];
}

/**
 * Each value of `o` (an env or a with) naming a drive or scripts/ci/
 * (`bad`, drives-once.js's verdict()), refused as `${at} <key> names a drive`.
 */
const drivey = (o, at, bad) =>
  Object.entries(o && typeof o === "object" ? o : {})
    .filter(([, v]) => /scripts\/ci\//.test(String(v)) || bad(String(v)) === "runs a drive")
    .map(([k]) => `${at} ${k} names a drive`);

/** Workflow file `f` (R14-C2): a mapping (else {}), or null when it is no YAML. */
function load(f) {
  try {
    const d = require("js-yaml").load(fs.readFileSync(f, "utf8"));
    return d && typeof d === "object" ? d : {};
  } catch {
    return null;
  }
}

module.exports = { TABLE, table, unlisted, lifecycle, npmrc, gyp, drivey, load };
