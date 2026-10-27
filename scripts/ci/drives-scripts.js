"use strict";
// U2 round 12 (item B, lane G's GCI11-1): the package scripts a run line
// of the workflow reaches, for scripts/ci/drives-once.js (split out of it
// by the 500-line rule). scriptsOf() reads the root package.json and every
// workspace package's, reached() follows npm, npx, yarn, pnpm and bun
// through flags, aliases and pre/post hooks.
const fs = require("fs");
const path = require("path");

// Round 12 (B): a package manager's flags, and what runs a script or a bin.
const FLAG = String.raw`(?:(?:--prefix|--workspace|-w|-C|--dir|--cwd|--filter|-F)(?:=|\s+)\S+|-\S+)\s+`;
const RUNS = [
  new RegExp(
    String.raw`\b(?:npm\s+(?:${FLAG})*(?:run|run-script|rum|urn)|(?:yarn|pnpm)\s+(?:${FLAG})*(?:run\s+)?|bun\s+(?:${FLAG})*run)\s*(?:${FLAG})*([\w:.-]+)`,
    "g",
  ),
  new RegExp(String.raw`\bnpm\s+(?:${FLAG})*(test|t|tst|start)\b`, "g"),
  new RegExp(
    String.raw`\b(?:npx|bunx|(?:npm|pnpm|yarn)\s+(?:${FLAG})*exec|pnpm\s+dlx)\s+(?:${FLAG})*(?:--\s+)?([\w@/.:-]+)`,
    "g",
  ),
];

/**
 * Round 12 (B): the package scripts `text` reaches, each with its pre and
 * post hooks and what they reach in turn (`scripts`: name -> line, and
 * "bin:<name>" -> the bin's file, scriptsOf()'s).
 */
function reached(text, scripts, seen = new Set()) {
  const keys = RUNS.flatMap((re, i) =>
    [...text.matchAll(re)].map(([, k]) =>
      i === 2 ? `bin:${k}` : k === "t" || k === "tst" ? "test" : k,
    ),
  );
  const out = [];
  for (const k of keys) {
    for (const j of [`pre${k}`, k, `post${k}`]) {
      if (seen.has(j) || typeof scripts[j] !== "string") continue;
      seen.add(j);
      out.push(scripts[j], ...reached(scripts[j], scripts, seen));
    }
  }
  return out;
}

/**
 * Round 12 (B): the scripts of the package.json in `root` and of every
 * workspace package it names (`dir` or `dir/*`), merged by name (a name
 * several define reads all their lines), and each bin as "bin:<name>".
 */
function scriptsOf(root) {
  const out = {};
  const read = (dir) => {
    const f = path.join(dir, "package.json");
    if (!fs.existsSync(f)) return null;
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    const bins =
      typeof p.bin === "string" ? { [p.name]: p.bin } : (p.bin ?? {});
    const add = (k, v) => (out[k] = out[k] ? `${out[k]} ; ${v}` : v);
    for (const [k, v] of Object.entries(p.scripts ?? {})) add(k, String(v));
    for (const [k, v] of Object.entries(bins)) add(`bin:${k}`, String(v));
    return p;
  };
  const top = read(root);
  const ws = top?.workspaces;
  for (const w of Array.isArray(ws) ? ws : (ws?.packages ?? [])) {
    const base = path.join(root, String(w).replace(/\/\*$/, ""));
    if (!String(w).endsWith("/*")) read(base);
    else if (fs.existsSync(base))
      for (const d of fs.readdirSync(base)) read(path.join(base, d));
  }
  return out;
}

module.exports = { reached, scriptsOf };
