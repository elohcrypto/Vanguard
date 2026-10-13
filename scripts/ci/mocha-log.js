#!/usr/bin/env node
"use strict";
// Mocha output for the coverage runs (Task 5.10), two halves:
//
// AS A MODULE (hardhat.config.ts requires it when MOCHA_TIMINGS names a
// file): a root afterEach hook appends one JSON line per passing test,
// {title, file, ms, timeout}, where timeout is the test's own effective
// mocha timeout (this.timeout() in a suite overrides the config's).
//
// AS A CLI:
//   failures <log> [max]   print mocha's numbered failure blocks (title,
//                          error message, stack), from the "N failing"
//                          summary on, capped at max lines (default 200),
//                          so a red CI step shows why, not only which.
//   durations <timings>    near-timeout guard over the hook's file: a test
//                          over 50% of its own timeout gets a ::warning::,
//                          over 75% fails. The runner is slower than a
//                          laptop, and run 38390892827 lost a coverage run
//                          to a 38 s test that hit the 60 s timeout there.
//                          Prints the slowest 10 either way. Exits 1 on a
//                          test over 75%, or on a file with no timing (a
//                          run that recorded nothing is not a pass). A
//                          test with timeout 0 (disabled) is listed only.
//
// `node scripts/ci/mocha-log.js failures <log> | durations <timings>`.
const fs = require("fs");
const path = require("path");

const out = process.env.MOCHA_TIMINGS;
/** Root hook: one JSON line per passing test into MOCHA_TIMINGS. */
const mochaHooks = {
  afterEach() {
    const t = this.currentTest;
    if (!out || !t || t.state !== "passed") return;
    const rec = {
      title: t.fullTitle(),
      file: t.file && path.relative(process.cwd(), t.file),
      ms: t.duration,
      timeout: t.timeout(),
    };
    fs.appendFileSync(out, JSON.stringify(rec) + "\n");
  },
};

function main() {
  const [mode, file, maxArg] = process.argv.slice(2);
  if (!["failures", "durations"].includes(mode) || !file) {
    console.error("usage: mocha-log.js failures|durations <log> [max]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`::error::mocha-log: ${file} not found`);
    process.exit(1);
  }
  const ANSI = /\x1b\[[0-9;]*m/g;
  const lines = fs.readFileSync(file, "utf8").replace(ANSI, "").split("\n");

  if (mode === "failures") {
    const max = Number(maxArg) || 200;
    const start = lines.findIndex((l) => /^\s+\d+ failing/.test(l));
    if (start < 0) {
      console.log(`mocha-log: no "N failing" summary in ${file}`);
      process.exit(0);
    }
    const block = lines.slice(start, start + max);
    console.log(block.join("\n"));
    if (lines.length > start + max) {
      console.log(
        `... (capped at ${max} lines; the full log is the job artifact)`,
      );
    }
    process.exit(0);
  }

  const tests = lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .sort((a, b) => b.ms - a.ms);
  if (!tests.length) {
    console.error(`::error::mocha-log: no test timing in ${file}`);
    process.exit(1);
  }
  console.log(
    `slowest of ${tests.length} passing tests (ms / own timeout; warn > 50%, fail > 75%):`,
  );
  for (const t of tests.slice(0, 10)) {
    console.log(
      `  ${String(t.ms).padStart(7)} / ${String(t.timeout || "none").padStart(6)}  ${t.title} (${t.file})`,
    );
  }
  let failed = false;
  for (const t of tests) {
    if (!t.timeout) continue;
    const share = `${t.ms} ms is over %s of its ${t.timeout} ms timeout: ${t.title} (${t.file})`;
    if (t.ms > t.timeout * 0.75) {
      console.log(`::error::${share.replace("%s", "75%")}`);
      failed = true;
    } else if (t.ms > t.timeout * 0.5) {
      console.log(`::warning::${share.replace("%s", "50%")}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
else module.exports = { mochaHooks };
