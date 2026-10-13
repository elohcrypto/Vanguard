#!/usr/bin/env node
"use strict";
// Mocha output for the coverage runs (Task 5.10).
//
//   failures <log> [max]   print mocha's numbered failure blocks (title,
//                          error message, stack), from the "N failing"
//                          summary on, capped at max lines (default 200),
//                          so a red CI step shows why, not only which.
//
// `node scripts/ci/mocha-log.js failures <log> [max]`.
const fs = require("fs");

function main() {
  const [mode, file, maxArg] = process.argv.slice(2);
  if (mode !== "failures" || !file) {
    console.error("usage: mocha-log.js failures <log> [max]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`::error::mocha-log: ${file} not found`);
    process.exit(1);
  }
  const ANSI = /\x1b\[[0-9;]*m/g;
  const lines = fs.readFileSync(file, "utf8").replace(ANSI, "").split("\n");
  const max = Number(maxArg) || 200;
  const start = lines.findIndex((l) => /^\s+\d+ failing/.test(l));
  if (start < 0) {
    console.log(`mocha-log: no "N failing" summary in ${file}`);
    process.exit(0);
  }
  console.log(lines.slice(start, start + max).join("\n"));
  if (lines.length > start + max) {
    console.log(
      `... (capped at ${max} lines; the full log is the job artifact)`,
    );
  }
}

main();
