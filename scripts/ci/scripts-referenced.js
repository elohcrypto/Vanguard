#!/usr/bin/env node
"use strict";
// Phase 4 exit row (plan v2 Task 4.15): every file under scripts/ is
// referenced. "Referenced" means its repository path or its basename
// occurs, as text, in another tracked file among package.json, the CI
// workflows, README.md, docs/, demo/, test/ or scripts/ (an npm script,
// a workflow step, a runbook line, a require/import or a spawn); a file
// nothing names is an orphan (Task 4.7 deleted 17 of them). ENTRY_POINTS
// lists files that are run by hand only; each carries its reason. Exits
// 1 on any orphan; `node scripts/ci/scripts-referenced.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ENTRY_POINTS = {
  // (none: every script is named by package.json, ci.yml, a doc or a caller)
};

const git = (...args) =>
  execFileSync("git", ["ls-files", "-z", ...args], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

const scripts = git("scripts/");
const haystack = git(
  "package.json",
  "README.md",
  ".github/",
  "docs/",
  "demo/",
  "test/",
  "scripts/",
).filter((f) => fs.statSync(f).isFile());
const texts = new Map(haystack.map((f) => [f, fs.readFileSync(f, "utf8")]));

const orphans = [];
for (const s of scripts) {
  if (ENTRY_POINTS[s]) continue;
  const base = path.basename(s);
  const referenced = haystack.some(
    (f) => f !== s && (texts.get(f).includes(s) || texts.get(f).includes(base)),
  );
  if (!referenced) orphans.push(s);
}

if (orphans.length) {
  for (const o of orphans) {
    console.error(
      `::error::scripts gate: ${o} is referenced nowhere (package.json, CI, README, docs/, demo/, test/, scripts/); delete it or list it in ENTRY_POINTS with a reason`,
    );
  }
  process.exit(1);
}
console.log(
  `scripts gate: ${scripts.length} files under scripts/ all referenced` +
    ` (${Object.keys(ENTRY_POINTS).length} entry points)`,
);
