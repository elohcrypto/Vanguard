#!/usr/bin/env node
"use strict";
// CI shards (plan v2 Task 5.15, readiness review L-6): the test files a
// job of N runs, so the tests and the coverage run each split across
// parallel jobs. The file set is the one `hardhat test` runs (every .js
// and .ts under test/, helpers included), so every file lands in exactly
// one shard and the shards together are the whole suite. Files are dealt
// heaviest first to the lightest shard, by the seconds each took in a
// measured run (test-weights.json, [coverage, tests]); a file not in the
// table counts as the table's mean, so a stale table only unbalances the
// shards, never drops a file.
//
//   node scripts/ci/test-shards.js <run> <shard> <of>
//     run "coverage" or "tests"; prints the shard's files one per line.
//   node scripts/ci/test-shards.js check <of>
//     every file in exactly one shard of <of>, for both runs; exit 1 if not.
// hardhat.config.ts filters `hardhat test` and `hardhat coverage` by it
// when TEST_SHARD=<i>/<of> (shardOf); TEST_SHARD_RUN picks the weights.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const { weights } = require("./test-weights.json");

/** Every .js/.ts under test/, as hardhat collects them, sorted. */
function testFiles(dir = "test") {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...testFiles(rel));
    else if (/\.[cm]?[jt]s$/.test(e.name)) out.push(rel);
  }
  return out.sort();
}

/** The `of` shards for `run`: arrays of files, heaviest dealt first. */
function shards(run, of) {
  const col = { coverage: 0, tests: 1 }[run];
  if (col === undefined) throw new Error(`run must be coverage or tests`);
  const known = Object.values(weights).map((w) => w[col]);
  const mean = known.reduce((a, b) => a + b, 0) / (known.length || 1);
  const w = (f) => (weights[f] ? weights[f][col] : mean);
  const files = testFiles().sort((a, b) => w(b) - w(a) || a.localeCompare(b));
  const out = Array.from({ length: of }, () => ({ files: [], load: 0 }));
  for (const f of files) {
    const s = out.reduce((m, x) => (x.load < m.load ? x : m));
    s.files.push(f);
    s.load += w(f);
  }
  return out.map((s) => ({ files: s.files.sort(), load: s.load }));
}

function main(argv) {
  if (argv[0] === "check") {
    const of = Number(argv[1]);
    const all = testFiles();
    for (const run of ["coverage", "tests"]) {
      const got = shards(run, of).flatMap((s) => s.files);
      const once = all.every((f) => got.filter((g) => g === f).length === 1);
      if (!once || got.length !== all.length) {
        console.error(`::error::${run} shards do not cover each file once`);
        return 1;
      }
      const loads = shards(run, of).map((s) => Math.round(s.load));
      console.log(
        `${run}: ${all.length} files in ${of} shards, ~${loads.join(" / ")} s`,
      );
    }
    return 0;
  }
  const [run, shard, of] = [argv[0], Number(argv[1]), Number(argv[2])];
  if (!(shard >= 1 && shard <= of)) {
    console.error(
      "usage: test-shards.js <coverage|tests> <shard> <of> | check <of>",
    );
    return 1;
  }
  const { files } = shards(run, of)[shard - 1];
  console.log(files.join("\n"));
  return 0;
}

/**
 * The absolute paths in `files` (hardhat's list) that shard `spec`
 * ("i/n") of `run` (default "tests") holds; throws on a bad spec or on a
 * file no shard holds (hardhat and this lister disagree).
 */
function shardOf(spec, run = "tests", files) {
  const [i, n] = String(spec).split("/").map(Number);
  if (!(Number.isInteger(n) && n >= 1 && i >= 1 && i <= n)) {
    throw new Error(`TEST_SHARD must be <i>/<n>, got "${spec}"`);
  }
  const all = shards(run || "tests", n);
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
  const lost = files.filter((f) => !all.some((s) => s.files.includes(rel(f))));
  if (lost.length)
    throw new Error(`no shard holds ${lost.map(rel).join(", ")}`);
  const mine = new Set(all[i - 1].files);
  return files.filter((f) => mine.has(rel(f)));
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { testFiles, shards, shardOf };
