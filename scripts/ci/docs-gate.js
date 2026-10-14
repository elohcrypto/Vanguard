#!/usr/bin/env node
"use strict";
// Task 5.5 docs gate (plan v2): checks over every markdown file
// git tracks or would track (untracked, not ignored), outside .omc/ and
// .superpowers/ (plan and review notes).
//  0. Every code fence is closed (an open one turns the rest to code).
//  1. README's project tree: every entry it names exists (or is
//     a gitignored root build directory), and under
//     contracts/ it lists every directory holding such a file (a
//     directory of ignored files only, e.g. a tool's state, is not in
//     the repo and does not count).
//  2. Every relative markdown link (inline or reference-style) resolves to a tracked file or
//     directory, and a #anchor to a heading in the target file (GitHub's
//     slug rule). Links inside code fences and inline code are skipped.
//  3. Every demo option cited in prose ("option 31", "options 61 to
//     73b", "Options 33a, 34a and 35a") is a `case "N":` of the menu in
//     demo/core/MenuSystem.js, read from the source.
// Exits 1 on any finding; `node scripts/ci/docs-gate.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Tracked plus untracked, not ignored: a new doc is checked before commit.
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((f) => f && fs.existsSync(f));
const trackedDirs = new Set();
for (const f of tracked) {
  for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) {
    trackedDirs.add(d);
  }
}
const exists = (p) => tracked.includes(p) || trackedDirs.has(p);
// Build output the tree names (typechain-types/) is gitignored, not absent:
// an absent entry passes only as one of these root build directories.
const BUILD_DIRS = new Set([
  "artifacts",
  "cache",
  "build",
  "typechain-types",
  "coverage",
  "node_modules",
]);
function ignored(p) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", p + "/"]);
    return true;
  } catch {
    return false;
  }
}
const docs = tracked.filter(
  (f) => f.endsWith(".md") && !/^\.(omc|superpowers)\//.test(f),
);
const findings = [];

// Prose lines of a markdown file: [lineNo, text, raw] outside code
// fences; text has inline code spans blanked, raw keeps them.
function proseLines(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (!fence) out.push([i + 1, line.replace(/`[^`]*`/g, "``"), line]);
  });
  return out;
}

// 0. A file that ends inside a code fence renders the rest as code.
for (const doc of docs) {
  const fences = fs
    .readFileSync(doc, "utf8")
    .split("\n")
    .filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2) findings.push(`${doc}: a code fence is never closed`);
}

// 1. README tree.
{
  const lines = fs.readFileSync("README.md", "utf8").split("\n");
  const start = lines.findIndex((l) => /^├── contracts\//.test(l));
  if (start < 0) findings.push("README.md: no project tree with contracts/");
  const stack = [];
  const listed = new Set();
  for (let i = start; i >= 0 && i < lines.length; i++) {
    const m = /^((?:│ {3}| {4})*)(?:├──|└──) (\S+)/.exec(lines[i]);
    if (!m) break; // end of the tree block
    const depth = m[1].length / 4;
    stack.length = depth;
    const name = m[2].replace(/\/$/, "");
    stack.push(name);
    const p = stack.join("/");
    if (m[2].includes("*")) continue; // a glob names a family of files
    if (!exists(p) && !(BUILD_DIRS.has(p) && ignored(p))) {
      findings.push(`README.md:${i + 1}: tree names ${p}, absent`);
    }
    if (m[2].endsWith("/")) listed.add(p);
  }
  for (const d of trackedDirs) {
    if (d.startsWith("contracts/") && !listed.has(d)) {
      findings.push(`README.md: tree misses directory ${d}`);
    }
  }
}

// 2. Relative links and anchors.
function slugs(file) {
  const seen = new Map();
  const out = new Set();
  // A heading's slug keeps the text of its code spans (raw line).
  for (const [, , line] of proseLines(fs.readFileSync(file, "utf8"))) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    const html = [...line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)];
    for (const a of html) out.add(a[1]);
    if (!h) continue;
    const base = h[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}
for (const doc of docs) {
  const text = fs.readFileSync(doc, "utf8");
  for (const [n, line] of proseLines(text)) {
    const inline = [
      ...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g),
    ];
    const ref = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line); // [x]: path
    for (const m of ref ? [...inline, ref] : inline) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:
      const [rel, anchor] = target.split("#");
      // A leading "/" is the repository root, as GitHub renders it.
      const from = rel.startsWith("/") ? "." : path.posix.dirname(doc);
      const file = rel ? path.posix.join(from, rel) : doc;
      if (!exists(file.replace(/\/$/, ""))) {
        findings.push(`${doc}:${n}: link ${target}: ${file} absent`);
        continue;
      }
      if (anchor && file.endsWith(".md") && !slugs(file).has(anchor)) {
        findings.push(`${doc}:${n}: link ${target}: no heading #${anchor}`);
      }
    }
  }
}

// 3. Demo options cited in docs.
const menu = new Set(
  [
    ...fs
      .readFileSync("demo/core/MenuSystem.js", "utf8")
      .matchAll(/case "([^"]+)":/g),
  ].map((m) => m[1]),
);
const OPT = String.raw`\d+(?:\.\d+)?[a-z]?`;
const cite = new RegExp(
  String.raw`\boptions?\s+(${OPT}(?:\s*(?:,|/|-|–|and|or|to)\s*${OPT})*)`,
  "gi",
);
for (const doc of docs) {
  for (const [n, line] of proseLines(fs.readFileSync(doc, "utf8"))) {
    for (const m of line.matchAll(cite)) {
      for (const opt of m[1].match(new RegExp(OPT, "g"))) {
        if (!menu.has(opt)) {
          findings.push(`${doc}:${n}: cites option ${opt}, not in the menu`);
        }
      }
    }
  }
}

if (findings.length) {
  for (const f of findings) console.error(`::error::docs gate: ${f}`);
  process.exit(1);
}
console.log(
  `docs gate: README tree, links in ${docs.length} docs, option citations ok (menu ${menu.size})`,
);
