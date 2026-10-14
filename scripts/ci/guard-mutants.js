#!/usr/bin/env node
"use strict";
// Guard mutants (plan v2 Task 5.3 fix round; run by hand, not in CI):
// for every "tested" row of test/guards/table whose site key contains
// FILTER (all rows if none), switch the site's guard off once (a
// require's condition becomes `true || (cond)`, a revert gets
// `if (false)` in front), run only the row's named test (its file,
// --grep its title, ZK_PROOFS=0 unless set), restore the contract, and
// print KILLED or SURVIVED. A survivor means the row names a test that
// does not fire its guard. It edits contracts/ in place and recompiles
// per site, so run it in a copy of the tree, never where another run
// compiles. Exits 1 on any survivor;
// `node scripts/ci/guard-mutants.js --in-place [FILTER]`.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { enumerateSites, TABLE_DIR } = require("./guards-table");

const args = process.argv.slice(2);
if (!args.includes("--in-place")) {
  console.error(
    "usage: guard-mutants.js --in-place [FILTER] (edits contracts/; use a copy)",
  );
  process.exit(2);
}
const filter = args.find((a) => a !== "--in-place") || "";
const { sites } = enumerateSites();
const byKey = new Map(sites.map((s) => [s.key, s]));
const rows = fs
  .readdirSync(TABLE_DIR)
  .filter((f) => f.endsWith(".json"))
  .flatMap(
    (f) => JSON.parse(fs.readFileSync(path.join(TABLE_DIR, f), "utf8")).sites,
  )
  .filter((r) => r.class === "tested" && r.site.includes(filter));

let survived = 0;
for (const r of rows) {
  const s = byKey.get(r.site);
  if (!s) continue; // a stale row; guards-table.js reports it
  const orig = fs.readFileSync(s.file, "utf8");
  const mut = s.crange
    ? orig.slice(0, s.crange[0]) +
      "true || (" +
      orig.slice(s.crange[0], s.crange[1] + 1) +
      ")" +
      orig.slice(s.crange[1] + 1)
    : orig.slice(0, s.range[0]) + "if (false) " + orig.slice(s.range[0]);
  fs.writeFileSync(s.file, mut);
  try {
    const grep = r.test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const res = spawnSync("npx", ["hardhat", "test", r.file, "--grep", grep], {
      encoding: "utf8",
      env: { ...process.env, ZK_PROOFS: process.env.ZK_PROOFS || "0" },
    });
    const out = res.stdout + res.stderr;
    const fail = (out.match(/(\d+) failing/) || [])[1];
    const killed = res.status !== 0 && fail;
    if (!killed) survived++;
    console.log(
      `${killed ? "KILLED" : "SURVIVED"} ${s.file}:${s.line} ${r.site} :: ${r.test}`,
    );
  } finally {
    fs.writeFileSync(s.file, orig);
  }
}
console.log(`guard mutants: ${rows.length} rows, ${survived} survived`);
process.exit(survived ? 1 : 0);
