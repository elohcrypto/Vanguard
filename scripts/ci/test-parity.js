#!/usr/bin/env node
"use strict";
// Test-file split parity (plan v2 Task 5.4, C §6). The test files the
// line-count ratchet allowlisted are split by moving describe blocks
// whole; this proves no test and no assertion was lost on the way.
// scripts/ci/test-parity-baseline.json holds, per original file (a
// "group"), every test's full title and state from a run before its
// split, and its assertion call sites counted on the AST; `files` lists
// the files the group lives in now (the original until it is split,
// then the new files and any fixture its hooks moved to). For each
// group the gate checks:
//  1. the multiset of (full title, state) of the tests the run found in
//     `files` equals the recorded one (a lost, renamed, duplicated,
//     newly skipped or failing test is red);
//  2. the assertion call sites in `files` equal the recorded counts per
//     kind: expect(...), `.to`, assert / assert.x(...), .revertedWith*(...).
// It also prints the run's passing/pending totals against the recorded
// ones (other tasks may add tests, so they are not gated).
//
// AS A MODULE: `Reporter`, mocha's spec reporter that also writes every
// test's {title, file, state} to TEST_PARITY_OUT at the end of the run
// (hardhat.config.ts installs it when that variable is set; CI's tests
// job does, so no extra suite run).
// AS A CLI:
//   check <run.json> [group...]   the gate (exit 1 on any difference),
//                                 optionally over the named groups only
//   record <run.json> <file...>   (re)write the baseline groups for the
//                                 named files from a run, files = [file]
// Retires when the ratchet allowlists no test/ file.
const fs = require("fs");
const path = require("path");

const BASELINE = "scripts/ci/test-parity-baseline.json";
const KINDS = ["expect", "to", "assert", "revertedWith"];

// The mocha hardhat runs (resolved from hardhat's directory).
const mocha = () =>
  require(
    require.resolve("mocha", {
      paths: [path.dirname(require.resolve("hardhat/package.json"))],
    }),
  );

function Reporter(runner, options) {
  mocha().reporters.Spec.call(this, runner, options);
  const seen = new Map();
  const put = (state) => (t) => seen.set(t, state);
  runner.on("pass", put("passed"));
  runner.on("pending", put("pending"));
  runner.on("fail", put("failed"));
  runner.once("end", () => {
    const tests = [...seen].map(([t, state]) => ({
      title: t.fullTitle(),
      file: t.file ? path.relative(process.cwd(), t.file) : "",
      state,
    }));
    fs.writeFileSync(process.env.TEST_PARITY_OUT, JSON.stringify(tests));
  });
}
Reporter.prototype = Object.create(mocha().reporters.Spec.prototype);

/** Assertion call sites per kind in `files`, from the TS/JS AST. */
function countAsserts(files) {
  const ts = require("typescript");
  const n = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const file of files) {
    const src = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const e = node.expression;
        if (ts.isIdentifier(e) && e.text === "expect") n.expect++;
        if (ts.isIdentifier(e) && e.text === "assert") n.assert++;
        if (ts.isPropertyAccessExpression(e)) {
          if (ts.isIdentifier(e.expression) && e.expression.text === "assert")
            n.assert++;
          if (e.name.text.startsWith("revertedWith")) n.revertedWith++;
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "to")
        n.to++;
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return n;
}

const key = (t) => `${t.state}\t${t.title}`;
const sorted = (tests) => tests.map(key).sort();

/** The baseline, one group per line (with its tests on that line). */
function write(base) {
  const lines = Object.entries(base.groups).map(
    ([g, v]) => `    ${JSON.stringify(g)}: ${JSON.stringify(v)}`,
  );
  const head = `{\n  "why": ${JSON.stringify(base.why)},\n  "totals": ${JSON.stringify(base.totals)},\n  "groups": {\n`;
  fs.writeFileSync(BASELINE, `${head}${lines.join(",\n")}\n  }\n}\n`);
}

function totals(run) {
  const t = { passed: 0, pending: 0, failed: 0 };
  for (const r of run) t[r.state]++;
  return t;
}

function record(run, files) {
  const base = fs.existsSync(BASELINE)
    ? JSON.parse(fs.readFileSync(BASELINE, "utf8"))
    : {
        why: "Task 5.4 split parity baseline, checked by scripts/ci/test-parity.js (its header says what is recorded and checked).",
        groups: {},
      };
  base.totals = totals(run);
  for (const f of files) {
    const tests = run.filter((r) => r.file === f);
    base.groups[f] = {
      files: [f],
      asserts: countAsserts([f]),
      tests: tests.map((t) => [t.title, t.state]).sort(),
    };
    console.log(`recorded ${f}: ${tests.length} tests`);
  }
  write(base);
}

function check(run, only) {
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (only.length) {
    for (const g of only) if (!base.groups[g]) throw new Error(`no group ${g}`);
    base.groups = Object.fromEntries(only.map((g) => [g, base.groups[g]]));
  }
  const errors = [];
  const owner = new Map();
  for (const [g, v] of Object.entries(base.groups)) {
    for (const f of v.files) {
      if (owner.has(f)) errors.push(`${f} is in ${owner.get(f)} and ${g}`);
      owner.set(f, g);
      if (!fs.existsSync(f)) errors.push(`${g}: listed file ${f} is missing`);
    }
    if (errors.length) continue;
    const got = sorted(run.filter((r) => v.files.includes(r.file)));
    const want = sorted(v.tests.map(([title, state]) => ({ title, state })));
    const diff = (a, b) => {
      const m = new Map();
      for (const x of a) m.set(x, (m.get(x) || 0) + 1);
      for (const x of b) m.set(x, (m.get(x) || 0) - 1);
      return [...m].filter(([, c]) => c > 0).map(([x, c]) => `${x} (x${c})`);
    };
    for (const x of diff(want, got)) errors.push(`${g}: lost ${x}`);
    for (const x of diff(got, want)) errors.push(`${g}: unexpected ${x}`);
    const a = countAsserts(v.files);
    for (const k of KINDS)
      if (a[k] !== v.asserts[k])
        errors.push(`${g}: ${k} sites ${a[k]}, recorded ${v.asserts[k]}`);
    console.log(
      `${g}: ${got.length}/${want.length} tests, asserts ` +
        KINDS.map((k) => `${k} ${a[k]}/${v.asserts[k]}`).join(", ") +
        ` in ${v.files.length} file(s)`,
    );
  }
  const t = totals(run);
  console.log(
    `suite: passed ${t.passed} pending ${t.pending} failed ${t.failed}; ` +
      `baseline passed ${base.totals.passed} pending ${base.totals.pending}`,
  );
  if (errors.length) {
    for (const e of errors) console.error(`::error::test parity: ${e}`);
    process.exit(1);
  }
}

function main() {
  const [mode, runFile, ...files] = process.argv.slice(2);
  const run = runFile && JSON.parse(fs.readFileSync(runFile, "utf8"));
  if (mode === "check" && run) return check(run, files);
  if (mode === "record" && run && files.length) return record(run, files);
  console.error(
    "usage: test-parity.js check <run.json> [group...] | record <run.json> <file...>",
  );
  process.exit(2);
}

if (require.main === module) main();
else module.exports = { Reporter, countAsserts };
