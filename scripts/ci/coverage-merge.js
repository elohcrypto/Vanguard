#!/usr/bin/env node
"use strict";
// Merge the coverage shards' coverage.json files (plan v2 Task 5.15): per
// contract the hit counts of every statement, function, branch arm and
// line are summed, so anything hit in one shard is hit in the merge.
// Lines are summed as recorded: solidity-coverage instruments lines on
// their own, and istanbul's mergeFileCoverage would re-derive them from
// statements instead (a different figure: 97.46 for 97.61 on one run).
// Writes the merged coverage.json and prints the summary in
// solidity-coverage's "All files" row format (sc-istanbul's summary, the
// one solidity-coverage prints), which scripts/ci/coverage-ratchet.sh
// reads (lines is the fifth column).
//
// Refused (exit 1, review L-5): another number of shard files than
// expected, or shards that instrumented different contracts (one run on
// another tree, or one that lost files, must not pass as the whole run).
//
//   node scripts/ci/coverage-merge.js <out.json> <expected n> <shard.json>...
const fs = require("fs");
const istanbul = require("sc-istanbul");

const add = (into, from) => {
  for (const [k, n] of Object.entries(from || {})) into[k] = (into[k] || 0) + n;
};

function merge(files) {
  const out = {};
  for (const f of files) {
    for (const [file, c] of Object.entries(
      JSON.parse(fs.readFileSync(f, "utf8")),
    )) {
      const m = out[file];
      if (!m) {
        out[file] = JSON.parse(JSON.stringify(c));
        continue;
      }
      for (const k of ["s", "f", "l"]) add((m[k] ??= {}), c[k]);
      for (const [k, arms] of Object.entries(c.b)) {
        m.b[k] = m.b[k] ? m.b[k].map((n, i) => n + arms[i]) : [...arms];
      }
    }
  }
  return out;
}

/** solidity-coverage's "All files" row for `cov`. */
function summaryRow(cov) {
  const s = istanbul.utils.summarizeCoverage(cov);
  const col = (k) => String(s[k].pct).padStart(8);
  const cols = ["statements", "branches", "functions", "lines"].map(col);
  return `${"All files".padEnd(31)}|${cols.join(" |")} |                |`;
}

if (require.main === module) {
  const [out, expected, ...files] = process.argv.slice(2);
  if (!out || !/^[1-9][0-9]*$/.test(expected || "") || !files.length) {
    console.error(
      "usage: coverage-merge.js <out.json> <expected n> <shard.json>...",
    );
    process.exit(1);
  }
  if (files.length !== Number(expected)) {
    console.error(
      `::error::coverage merge: ${files.length} shard file(s), expected ${expected}`,
    );
    process.exit(1);
  }
  const keys = files.map((f) =>
    Object.keys(JSON.parse(fs.readFileSync(f, "utf8"))).sort(),
  );
  for (const [i, k] of keys.entries()) {
    const extra = [
      ...k.filter((x) => !keys[0].includes(x)),
      ...keys[0].filter((x) => !k.includes(x)),
    ];
    if (extra.length) {
      console.error(
        `::error::coverage merge: ${files[i]} and ${files[0]} instrumented other contracts (${extra.join(", ")})`,
      );
      process.exit(1);
    }
  }
  const cov = merge(files);
  fs.writeFileSync(out, JSON.stringify(cov));
  console.log(`merged ${files.length} shard(s) into ${out}`);
  console.log(summaryRow(cov));
}
module.exports = { merge, summaryRow };
