#!/usr/bin/env node
"use strict";
// Phase 4 exit row (plan v2 Task 4.15; reachability since Task 4.17,
// CF-5): every file under scripts/ is reachable from a root. The roots
// are the npm scripts in package.json, the CI workflows, and every file
// under demo/ and test/. A scripts/ file is reachable when a root or an
// already reachable scripts/ file references it, so a file named only by
// a dead script, or a dead pair naming each other, is an orphan too. A
// reference is one of:
//  - its repository path (`scripts/x.js`, or `scripts/x` without the
//    extension as an import writes it) as text;
//  - a relative require/import/spawn specifier in demo/, test/ or
//    scripts/ that resolves to it (`require("./x")` from scripts/);
//  - its bare basename, standing alone (not another path's segment such
//    as demo/index.js), in an npm script or a workflow file.
// Comments count for nothing: // and /* */ comments are stripped from
// .js/.ts files (by the TypeScript transpiler, so strings and regex
// literals survive), and whole-line # comments from workflows and shell
// scripts, before matching. Prose in README.md or docs/ is not a root.
// A file nothing reaches is an orphan (Task 4.7 deleted 17 of them).
// ENTRY_POINTS lists files run by hand only, each with its reason; they
// are roots too. Exits 1 on any orphan;
// `node scripts/ci/scripts-referenced.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ENTRY_POINTS = {
  "scripts/print-role-wallets.js":
    "operator tool run by hand: prints the role wallets of a mnemonic (.env.example, docs/TESTNET_SETUP.md)",
  "scripts/ci/guard-mutants.js":
    "run by hand in a copy: switches each tested guard off once and runs its named test (Task 5.3)",
  "scripts/test-proof-generation.js":
    "manual check that all five circuits prove (docs/ZK_CIRCUIT_BUILD_GUIDE.md)",
};

const EXEC_LINE =
  /\b(require|import|spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\b|hardhat run|\bnpx\b/;
const SPECIFIER = /["'](\.{1,2}\/[^"']+)["']/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const git = (...args) =>
  execFileSync("git", ["ls-files", "-z", ...args], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

/** Text of `f` with its comments removed (see the header). */
function stripComments(f, text) {
  if (/\.(c|m)?(js|ts)$/.test(f)) {
    const ts = require("typescript");
    return ts.transpileModule(text.replace(/^#!.*/, ""), {
      fileName: f.endsWith("ts") ? "x.ts" : "x.js",
      compilerOptions: {
        removeComments: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        allowJs: true,
      },
    }).outputText;
  }
  if (/\.(ya?ml|sh)$/.test(f)) return text.replace(/^\s*#.*$/gm, "");
  return text;
}

const exists = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
const scripts = git("scripts/").filter(exists);
const roots = [
  "package.json",
  ...git(".github/workflows/", "demo/", "test/"),
].filter(exists);
const texts = new Map(
  [...new Set([...roots, ...scripts])].map((f) => [
    f,
    stripComments(f, fs.readFileSync(f, "utf8")),
  ]),
);
texts.set(
  "package.json",
  Object.values(JSON.parse(texts.get("package.json")).scripts || {}).join("\n"),
);

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
  return f === "package.json" || f.startsWith(".github/") ? texts.get(f) : "";
}

/** Does reachable file `f` reference scripts/ file `s`? */
function references(f, s) {
  if (f === s) return false;
  const stem = s.replace(/\.(js|ts|sh)$/, "");
  const pathForm = new RegExp(`${esc(stem)}(?![\\w.\\-/])|${esc(s)}`);
  const standalone = new RegExp(
    `(^|[\\s"'=:])${esc(path.basename(s))}(?=$|[\\s"'&;|)])`,
    "m",
  );
  if (pathForm.test(texts.get(f))) return true;
  if (resolvedSpecifiers(f).some((r) => r === s || r === stem)) return true;
  return standalone.test(commandText(f));
}

// Fixpoint: a scripts/ file joins the sources once something reaches it.
const reached = new Set(scripts.filter((s) => ENTRY_POINTS[s]));
const sources = [...roots, ...reached];
for (let grew = true; grew;) {
  grew = false;
  for (const s of scripts) {
    if (reached.has(s) || !sources.some((f) => references(f, s))) continue;
    reached.add(s);
    sources.push(s);
    grew = true;
  }
}
const orphans = scripts.filter((s) => !reached.has(s));

if (orphans.length) {
  for (const o of orphans) {
    console.error(
      `::error::scripts gate: ${o} is reachable from no root (an npm script, a CI workflow, demo/ or test/, directly or through reachable scripts/ files; comments do not count); delete it or list it in ENTRY_POINTS with a reason`,
    );
  }
  process.exit(1);
}
console.log(
  `scripts gate: ${scripts.length} files under scripts/ all reachable` +
    ` from ${roots.length} roots (${Object.keys(ENTRY_POINTS).length} entry points)`,
);
