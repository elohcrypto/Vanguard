"use strict";
// U2 round 16 (A, R16-C1, R16-CS4, lane G G15-1): npm's project config is
// pinned empty, proven by npm itself. npm 10.9.8 expands `${VAR}` inside
// an .npmrc key after ini has parsed the file, so the gate's ports of
// npm's key grammar (round 14: quoting; round 15: ini's decode/unsafe)
// both missed a key npm honours. The gate no longer re-derives that
// grammar: drives-lines.js refuses any .npmrc in the tree by name, and
// config() asks the npm the later steps run, in the gate's own
// environment, what config the root adds over a fresh empty directory.
// For drives-once.js.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** `npm config list` (`--json` if `json`) in `cwd`, user and global config pinned to `user` and `global`: its output, else the refusal. */
function list(cwd, user, global, json) {
  // R16-CS6: npm 10.9.8 takes an env npm_config_globalconfig over the
  // --globalconfig flag (npx exports one), so both are pinned.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_(userconfig|globalconfig)$/i.test(k)));
  const r = cp.spawnSync("npm", ["config", "list", ...(json ? ["--json"] : []), `--userconfig=${user}`, `--globalconfig=${global}`], {
    cwd,
    env: { ...env, npm_config_userconfig: user, npm_config_globalconfig: global },
    encoding: "utf8",
    timeout: 60000,
  });
  try {
    if (r.status !== 0) throw new Error("exit");
    if (!json) return { text: r.stdout };
    const o = JSON.parse(r.stdout);
    if (o && typeof o === "object" && !Array.isArray(o)) return { json: o };
  } catch {
    // refused below
  }
  const why = String(r.stderr || r.error?.message || `exit ${r.status}`).replace(/\s+/g, " ").trim();
  return `npm config list failed: ${why.slice(0, 200)}`;
}

/** The config sources a text listing names: [[source, where], ...]. */
const sources = (text) => [...text.matchAll(/^; "([^"]+)" config from (.+)$/gm)].map((m) => [m[1], m[2].trim()]);

/**
 * Each npm config key whose value at `root` differs from a fresh empty
 * directory's (JSON per key; a new key differs too), refused as "npm's
 * project config sets <key>"; and, from the text listing, each config
 * source npm reads at `root` and not in the empty directory, refused as
 * "npm reads a <source> config: <where>": the pins below are on the
 * command line, which beats the project layer, so a project config
 * holding only userconfig or globalconfig changes no effective key but
 * still shows as a source. npm failing or printing no JSON object is
 * refused. User and global config are two DISTINCT empty files (one file
 * for both makes npm exit 1, "double-loading config"), pinned by flag and
 * by env; every other key of process.env is passed through, as the later
 * steps see it. No allow-list: a legitimate
 * .npmrc edits the gate in the same PR, as the run-line table does. npm
 * names no source for an .npmrc with no key (empty, comments only): the
 * claim is that npm reads no project config key here.
 */
function config(root) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drives-npm-"));
  try {
    const [user, global, empty] = ["user", "global", "empty"].map((f) => path.join(tmp, f));
    fs.writeFileSync(user, "");
    fs.writeFileSync(global, "");
    fs.mkdirSync(empty);
    const runs = [root, empty].flatMap((d) => [list(d, user, global, true), list(d, user, global, false)]);
    const bad = runs.filter((x) => typeof x === "string");
    if (bad.length) return [...new Set(bad)];
    const [at, , base] = runs.map((x) => x.json);
    const known = new Set(sources(runs[3].text).map(([s]) => s));
    return [
      ...[...new Set([...Object.keys(at), ...Object.keys(base)])]
        .filter((k) => JSON.stringify(at[k]) !== JSON.stringify(base[k]))
        .sort()
        .map((k) => `npm's project config sets ${k}`),
      ...sources(runs[1].text)
        .filter(([s]) => !known.has(s))
        .map(([s, where]) => `npm reads a ${s} config: ${where}`),
    ];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { config };
