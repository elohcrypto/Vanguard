#!/usr/bin/env node
"use strict";
// Phase 4 exit row (plan v2 Task 4.15): every file under scripts/ is
// referenced. A reference is one of:
//  - its repository path (`scripts/x.js`, or `scripts/x` without the
//    extension as an import writes it) as text in any other tracked
//    file among package.json, the CI workflows, README.md, docs/, demo/,
//    test/ or scripts/;
//  - a relative require/import/spawn specifier in demo/, test/ or
//    scripts/ that resolves to it (`require("./x")` from scripts/);
//  - its bare basename, standing alone (not another path's segment such
//    as demo/index.js), in an npm script or a workflow file.
// Prose naming a basename ("x.js was removed") counts for nothing. A file
// nothing references is an orphan (Task 4.7 deleted 17 of them).
// ENTRY_POINTS lists files run by hand only, each with its reason. Exits
// 1 on any orphan; `node scripts/ci/scripts-referenced.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ENTRY_POINTS = {
  // (none: every script is named by package.json, ci.yml, a doc or a caller)
};

const EXEC_LINE =
  /\b(require|import|spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\b|hardhat run|\bnpx\b/;
const SPECIFIER = /["'](\.{1,2}\/[^"']+)["']/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Relative specifiers on executable lines of `f`, resolved to repo paths. */
function resolvedSpecifiers(f) {
  if (!/^(demo|test|scripts)\//.test(f)) return [];
  const out = [];
  for (const line of texts.get(f).split("\n")) {
    if (!EXEC_LINE.test(line)) continue;
    for (const m of line.matchAll(SPECIFIER)) {
      out.push(
        path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])),
      );
    }
  }
  return out;
}

/** Text of `f` in which a standalone basename counts ("" if none). */
function commandText(f) {
  if (f === "package.json") {
    return Object.values(JSON.parse(texts.get(f)).scripts || {}).join("\n");
  }
  return f.startsWith(".github/") ? texts.get(f) : "";
}

function isReferenced(s) {
  const stem = s.replace(/\.(js|ts|sh)$/, "");
  const pathForm = new RegExp(`${esc(stem)}(?![\\w.-])|${esc(s)}`);
  const standalone = new RegExp(
    `(^|[\\s"'=:])${esc(path.basename(s))}(?=$|[\\s"'&;|)])`,
    "m",
  );
  return haystack.some((f) => {
    if (f === s) return false;
    if (pathForm.test(texts.get(f))) return true;
    if (resolvedSpecifiers(f).some((r) => r === s || r === stem)) return true;
    return standalone.test(commandText(f));
  });
}

const orphans = scripts.filter((s) => !ENTRY_POINTS[s] && !isReferenced(s));

if (orphans.length) {
  for (const o of orphans) {
    console.error(
      `::error::scripts gate: ${o} is referenced nowhere (its scripts/ path in package.json, CI, README, docs/, demo/, test/ or scripts/, a resolving require/import, or its standalone basename in an npm script or workflow); delete it or list it in ENTRY_POINTS with a reason`,
    );
  }
  process.exit(1);
}
console.log(
  `scripts gate: ${scripts.length} files under scripts/ all referenced` +
    ` (${Object.keys(ENTRY_POINTS).length} entry points)`,
);
