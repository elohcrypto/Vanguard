"use strict";
// Task 5.17 (CI run 39308877486): under coverage, artifacts/ holds the
// instrumented build. A test that spawns a child `hardhat run` (it
// compiles first) overwrote it with the clean build mid-run, and every
// later suite failed a code-hash pin far from the cause. The coverage
// runs' root hooks (scripts/ci/mocha-log.js, MOCHA_PENDING) record this
// fingerprint at the start and compare it at the end: one clear failure
// naming the cause instead.
const fs = require("fs");
const path = require("path");

/** "relative/path size mtimeMs" for every .json under `dir`, sorted. */
function fingerprint(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        const st = fs.statSync(p);
        out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** The failure message when `before` and `after` differ, else null. */
function artifactsChanged(before, after) {
  const a = new Set(before);
  const b = new Set(after);
  const diff = [
    ...before.filter((x) => !b.has(x)),
    ...after.filter((x) => !a.has(x)),
  ].map((x) => x.split(" ")[0]);
  if (!diff.length) return null;
  const names = [...new Set(diff)];
  return `artifacts/ changed during the coverage run: a child process recompiled; wrap that suite in describeUnlessCoverage or pass --no-compile (${names.length} artifact(s) changed, e.g. ${names.slice(0, 3).join(", ")})`;
}

module.exports = { fingerprint, artifactsChanged };
