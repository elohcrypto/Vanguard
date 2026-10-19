#!/usr/bin/env node
"use strict";
// Mocha output for the coverage runs (Task 5.10), two halves:
//
// AS A MODULE (hardhat.config.ts loads its root hooks when MOCHA_TIMINGS
// names a file): one JSON line per passing test AND per hook ("before
// each" and the rest; the 5.2 failure was a hook), {kind, title, name,
// file, ms, timeout}: title the full title, name the runnable's own,
// timeout its own effective mocha timeout (this.timeout() in a suite
// overrides the config's). The tests job records it too: the guard
// table binds its tested rows to tests that passed there (Task 5.17). When
// MOCHA_PENDING names a file, a root after-all hook writes there
// {file: pending tests} for every test file the run loaded (0 included;
// deep review H-1).
//
// AS A CLI:
//   failures <log> [max]   print mocha's numbered failure blocks (title,
//                          error message, stack), from the "N failing"
//                          summary on, capped at max lines (default 200),
//                          so a red CI step shows why, not only which.
//   durations <timings>    near-timeout guard over the recorded file: a
//                          test or hook over 50% of its own timeout gets a
//                          ::warning::, over 75% fails; hooks are labelled
//                          [hook]. The runner is slower than a laptop: run
//                          38390892827 lost a coverage run to a test (a
//                          "before each" hook) that hit the 60 s timeout
//                          there. Prints the slowest 10 either way. Exits
//                          1 on one over 75%, or on a file with no timing
//                          (a run that recorded nothing is not a pass). A
//                          timeout of 0 (disabled) is listed only.
//   pending <recorded>     the pending gate of the coverage runs: every
//                          file the run loaded has exactly the pending
//                          count scripts/ci/coverage-pending.json lists
//                          for it (0 if unlisted), so a describe.skip
//                          outside the known proof and child-process
//                          suites fails, and so does a listed suite that
//                          no longer skips (the list must stay true).
//                          A listed file that is not tracked fails too.
//
// `node scripts/ci/mocha-log.js failures <log> | durations <timings>
//   | pending <recorded>`.
const fs = require("fs");
const path = require("path");

const out = process.env.MOCHA_TIMINGS;
let installed = false;

/**
 * Wrap mocha's Runnable#run (tests and hooks both run through it) so
 * every one that finishes without an error appends {kind, title, name,
 * file, ms, timeout} to MOCHA_TIMINGS. kind is "test" or "hook"; timeout is
 * the runnable's own effective timeout. The mocha patched is the one
 * hardhat loads (resolved from hardhat's directory).
 */
function install() {
  if (installed || !out) return;
  installed = true;
  const mocha = require(
    require.resolve("mocha", {
      paths: [path.dirname(require.resolve("hardhat/package.json"))],
    }),
  );
  const run = mocha.Runnable.prototype.run;
  mocha.Runnable.prototype.run = function (fn) {
    return run.call(this, (err, ...rest) => {
      // A recorder failure must never stop mocha (fn is always called:
      // without it the next runnable is never scheduled and the run
      // ends silently with exit 0) and must always fail the process.
      try {
        if (!err && typeof this.duration === "number") {
          const rec = {
            kind: this.type === "hook" ? "hook" : "test",
            title: this.fullTitle(),
            name: this.title, // its own title (guards-table.js --ran)
            file: this.file && path.relative(process.cwd(), this.file),
            ms: this.duration,
            timeout: this.timeout(),
          };
          fs.appendFileSync(out, JSON.stringify(rec) + "\n");
        }
      } catch (e) {
        recorderFailed(e);
      }
      return fn(err, ...rest);
    });
  };
}

let failure = null;
/**
 * First recorder error: print it once and make the process exit 1. The
 * exit code is forced in an 'exit' listener because hardhat's test task
 * sets process.exitCode to the failure count after mocha ends, which
 * would overwrite an earlier value.
 */
function recorderFailed(e, to = out) {
  if (failure) return;
  failure = e;
  console.error(
    `::error::mocha-log: recording to ${to} failed: ${e && e.message}`,
  );
  process.on("exit", () => {
    if (!process.exitCode) process.exitCode = 1;
  });
}

/**
 * {file: pending tests} over the whole suite tree under `suite`, every
 * test file counted (0 included). isPending() is true for it.skip, for
 * a test under describe.skip and for one that called this.skip().
 */
function pendingByFile(suite) {
  while (suite.parent) suite = suite.parent;
  const counts = {};
  const walk = (s) => {
    for (const t of s.tests) {
      const f = path.relative(process.cwd(), t.file || "<no file>");
      const key = f.split(path.sep).join("/");
      counts[key] = (counts[key] || 0) + (t.isPending() ? 1 : 0);
    }
    s.suites.forEach(walk);
  };
  walk(suite);
  return counts;
}

/** Root hooks: the first one installs the recorder. */
const mochaHooks = {
  beforeAll() {
    install();
  },
  afterAll() {
    const to = process.env.MOCHA_PENDING;
    if (!to) return;
    try {
      const counts = pendingByFile(this.test.parent);
      fs.writeFileSync(to, JSON.stringify(counts, null, 1) + "\n");
    } catch (e) {
      recorderFailed(e, to);
    }
  },
};

/**
 * The pending gate (see the header): `recorded` against the committed
 * list. Returns the findings, [] when they agree.
 */
function pendingFindings(recorded, listed, tracked) {
  const out = [];
  for (const f of Object.keys(listed)) {
    if (!tracked.includes(f))
      out.push(`${f} is listed in coverage-pending.json but not tracked`);
  }
  for (const [f, n] of Object.entries(recorded)) {
    const want = listed[f] || 0;
    if (n !== want)
      out.push(
        `${f}: ${n} pending, coverage-pending.json lists ${want}` +
          (n > want ? " (a skipped suite?)" : " (update the list)"),
      );
  }
  return out;
}

/** "[hook] title (file)" for a hook, "title (file)" for a test. */
const label = (t) =>
  `${t.kind === "hook" ? "[hook] " : ""}${t.title} (${t.file})`;

function main() {
  const [mode, file, maxArg] = process.argv.slice(2);
  if (!["failures", "durations", "pending"].includes(mode) || !file) {
    console.error("usage: mocha-log.js failures|durations|pending <log> [max]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`::error::mocha-log: ${file} not found`);
    process.exit(1);
  }
  if (mode === "pending") {
    const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
    const { pending: listed } = require("./coverage-pending.json");
    const tracked = require("child_process")
      .execFileSync("git", ["ls-files", "test"], { encoding: "utf8" })
      .split("\n");
    const total = Object.values(recorded).reduce((a, n) => a + n, 0);
    const files = Object.keys(recorded).length;
    console.log(`pending: ${total} in ${files} test files loaded`);
    const findings = pendingFindings(recorded, listed, tracked);
    if (!files) findings.push(`${file} records no test file (no run?)`);
    for (const f of findings) console.error(`::error::pending gate: ${f}`);
    process.exit(findings.length ? 1 : 0);
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
    console.error(
      `::error::mocha-log: no timings recorded in ${file} (did the run start? is MOCHA_TIMINGS reaching hardhat?)`,
    );
    process.exit(1);
  }
  console.log(
    `slowest of ${tests.length} passing tests and hooks (ms / own timeout; warn > 50%, fail > 75%):`,
  );
  for (const t of tests.slice(0, 10)) {
    console.log(
      `  ${String(t.ms).padStart(7)} / ${String(t.timeout || "none").padStart(6)}  ${label(t)}`,
    );
  }
  let failed = false;
  for (const t of tests) {
    if (!t.timeout) continue;
    const share = `${t.ms} ms is over %s of its ${t.timeout} ms timeout: ${label(t)}`;
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
else module.exports = { mochaHooks, pendingFindings };
