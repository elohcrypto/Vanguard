#!/usr/bin/env node
"use strict";
// Guard table gate (plan v2 Task 5.3; closes C CF-8). Every require /
// revert / custom-error revert site in contracts/ has one row in
// test/guards/table/<dir>.json (dir = the contract's folder under
// contracts/; one row per line keeps each file under the line-count
// ratchet) saying how it is covered:
//  - tested: `file` + `test` name an it() title in that test file, and
//    that file names the site's reason string or error name (a site
//    without a fixed reason is checked by title alone; a test that builds
//    the reason from a template gives the literal part as `asserts`);
//  - unreachable: no caller can make it fire in the current code (an
//    earlier check or the callee's own revert always fires first);
//    `reason` says why and `mutant` names the mutation that leaves the
//    suite green;
//  - defensive: unreachable from any external caller in the current
//    wiring (not merely hard to reach); `reason` says why.
// Not enumerated: contracts/test/ (mocks and harnesses deployed only by
// tests) and contracts/privacy/verifiers/ (snarkjs-generated; their only
// reverts are assembly `revert(0, 0)`).
// A site is keyed by contract, function, condition and reason, not by
// line, so it survives line drift: `C.fn | condition | reason`, where a
// revert's condition is its innermost enclosing `if` (`!(...)` in an
// else, `catch` in a catch clause) and a repeat of the same key in one
// function gets ` #2`, ` #3`.
// The gate fails if a site has no row, a row names a site that no
// longer exists, a row is malformed, a tested row's title or reason is
// missing from its file, or any test asserts a bare `.reverted` /
// `.rejected` (one without its reason string or custom error; CF-8).
// Exits 1 on any finding;
// `node scripts/ci/guards-table.js`            the gate
// `node scripts/ci/guards-table.js --suggest`  rows for missing sites
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TABLE_DIR = "test/guards/table";
const SKIP = [/^contracts\/test\//, /^contracts\/privacy\/verifiers\//];
const CLASSES = ["tested", "unreachable", "defensive"];

// @solidity-parser/parser is not a direct dependency: solidity-coverage
// (a direct one) pins 0.20.x, which reads named mapping parameters; the
// top-level copy (0.14, via eth-gas-reporter) does not.
const parser = require(
  require.resolve("@solidity-parser/parser", {
    paths: [path.dirname(require.resolve("solidity-coverage/package.json"))],
  }),
);

// Tracked files plus new ones not yet committed (not ignored ones).
const tracked = (dir) =>
  execFileSync("git", ["ls-files", "-co", "--exclude-standard", dir], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Every guard site in the in-scope contracts, keyed as above. */
function enumerateSites() {
  const sites = [];
  const files = tracked("contracts").filter(
    (f) => f.endsWith(".sol") && !SKIP.some((re) => re.test(f)),
  );
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const text = (n) => squash(src.slice(n.range[0], n.range[1] + 1));
    const ast = parser.parse(src, { loc: true, range: true });
    const seen = new Map();
    // `reason` keys the site; `named` is what a test can assert (a
    // literal reason or an error name; "" for none or a computed one).
    const add = (node, ctx, cond, reason, named) => {
      let key = `${ctx.contract}.${ctx.fn} | ${cond} | ${reason}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) key += ` #${n}`;
      const line = node.loc.start.line;
      sites.push({ key, file, line, fn: ctx.fn, named });
    };
    const visit = (node, ctx) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((c) => visit(c, ctx));
      if (node.type === "ContractDefinition")
        ctx = { ...ctx, contract: node.name, fn: "<body>" };
      if (node.type === "FunctionDefinition") {
        const fn = node.isConstructor
          ? "constructor"
          : node.isReceiveEther
            ? "receive"
            : node.isFallback
              ? "fallback"
              : node.name;
        ctx = { ...ctx, fn };
      }
      if (node.type === "ModifierDefinition")
        ctx = { ...ctx, fn: `modifier ${node.name}` };
      if (node.type === "IfStatement") {
        const c = text(node.condition);
        visit(node.condition, ctx);
        visit(node.trueBody, { ...ctx, cond: c });
        visit(node.falseBody, { ...ctx, cond: `!(${c})` });
        return;
      }
      if (node.type === "CatchClause") ctx = { ...ctx, cond: "catch" };
      if (
        node.type === "FunctionCall" &&
        node.expression.type === "Identifier"
      ) {
        const [a0, a1] = node.arguments;
        const lit = (a) => (a && a.type === "StringLiteral" ? a.value : "");
        if (node.expression.name === "require") {
          add(node, ctx, text(a0), a1 ? lit(a1) || text(a1) : "", lit(a1));
        } else if (node.expression.name === "revert") {
          add(
            node,
            ctx,
            ctx.cond || "",
            a0 ? lit(a0) || text(a0) : "",
            lit(a0),
          );
        }
      }
      if (node.type === "RevertStatement") {
        const callee = text(node.revertCall.expression);
        add(node, ctx, ctx.cond || "", callee, callee.split(".").pop());
      }
      for (const k of Object.keys(node)) {
        if (k === "loc" || k === "range") continue;
        const v = node[k];
        if (v && typeof v === "object") visit(v, ctx);
      }
    };
    visit(ast, { contract: "<file>", fn: "<file>", cond: "" });
  }
  return sites;
}

const TITLE = /\bit\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
/** it() titles of a test file, with their offsets; `.skip` excluded. */
function titlesOf(src) {
  const out = [];
  for (const m of src.matchAll(TITLE)) out.push({ title: m[2], at: m.index });
  return out;
}

const CHAIN =
  /((?:\s*\.\s*(?:to|be|not|eventually))+)\s*\.\s*(reverted|rejected)\b/g;
/** `file:line` of every bare .reverted / .rejected assertion. */
function bareReverts(files) {
  const hits = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(CHAIN)) {
      if (/\bnot\b/.test(m[1])) continue;
      const line = src.slice(0, m.index + m[0].length).split("\n").length;
      hits.push(`${file}:${line}`);
    }
  }
  return hits;
}

/**
 * A test for site `s`: the it() block that asserts its reason and calls
 * its function, else any block asserting the reason. { file, test } or
 * null. A suggestion only; the gate checks what the table says.
 */
function suggestTest(s, tests) {
  if (!s.named) return null;
  const q = s.named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(revertedWith\\s*\\(\\s*["'\`]${q}["'\`]|revertedWithCustomError\\s*\\([^)]*?["'\`]${q}["'\`]|rejectedWith\\s*\\([^)]*?${q})`,
  );
  const fnCall = new RegExp(`\\.${s.fn.replace(/^modifier /, "")}\\s*\\(`);
  let fallback = null;
  for (const [file, src] of tests) {
    const titles = titlesOf(src);
    titles.forEach((t, i) => {
      const block = src.slice(
        t.at,
        i + 1 < titles.length ? titles[i + 1].at : src.length,
      );
      if (!re.test(block)) return;
      if (fnCall.test(block) && !fallback?.exact)
        fallback = { file, test: t.title, exact: true };
      else if (!fallback) fallback = { file, test: t.title, exact: false };
    });
    if (fallback?.exact) break;
  }
  return fallback;
}

function main() {
  const suggest = process.argv.includes("--suggest");
  const sites = enumerateSites();
  const testFiles = tracked("test").filter((f) => /\.(ts|js)$/.test(f));
  const tests = new Map(testFiles.map((f) => [f, fs.readFileSync(f, "utf8")]));
  const rows = [];
  const tables = fs.readdirSync(TABLE_DIR).filter((n) => n.endsWith(".json"));
  for (const f of tables.sort()) {
    const dir = f.replace(/\.json$/, "");
    const { sites: rs } = JSON.parse(
      fs.readFileSync(path.join(TABLE_DIR, f), "utf8"),
    );
    for (const r of rs) rows.push({ ...r, dir });
  }
  const byKey = new Map();
  const errors = [];
  for (const r of rows) {
    if (byKey.has(r.site)) errors.push(`duplicate row: ${r.site}`);
    byKey.set(r.site, r);
  }
  const live = new Map(sites.map((s) => [s.key, s]));
  const missing = sites.filter((s) => !byKey.has(s.key));
  for (const s of missing)
    errors.push(`no row for ${s.file}:${s.line}  ${s.key}`);
  for (const r of rows) {
    const s = live.get(r.site);
    if (!s) {
      errors.push(`stale row (no such site): ${r.site}`);
      continue;
    }
    if (s.file.split("/")[1] !== r.dir)
      errors.push(`row in ${r.dir}.json for a site in ${s.file}: ${r.site}`);
    if (!CLASSES.includes(r.class)) {
      errors.push(`bad class "${r.class}": ${r.site}`);
      continue;
    }
    if (r.class === "tested") {
      const src = tests.get(r.file);
      if (!src)
        errors.push(
          `tested row names no tracked test file "${r.file}": ${r.site}`,
        );
      else if (!titlesOf(src).some((t) => t.title === r.test))
        errors.push(`no test titled "${r.test}" in ${r.file}: ${r.site}`);
      else if (
        r.asserts !== undefined &&
        (r.asserts.length < 6 || !s.named.includes(r.asserts))
      )
        errors.push(
          `"asserts" must be 6+ characters of the reason "${s.named}": ${r.site}`,
        );
      else if (s.named && !src.includes(r.asserts || s.named))
        errors.push(
          `${r.file} never names "${r.asserts || s.named}": ${r.site}`,
        );
    } else if (!r.reason || (r.class === "unreachable" && !r.mutant)) {
      errors.push(
        `${r.class} row needs reason${r.class === "unreachable" ? " and mutant" : ""}: ${r.site}`,
      );
    }
  }
  const bare = bareReverts(testFiles);
  for (const b of bare)
    errors.push(`bare .reverted/.rejected (assert the reason or error): ${b}`);

  if (suggest) {
    const out = missing.map((s) => {
      const t = suggestTest(s, tests);
      const at = `${s.file}:${s.line}`;
      return t
        ? {
            site: s.key,
            class: "tested",
            file: t.file,
            test: t.test,
            at,
            exact: t.exact,
          }
        : { site: s.key, class: "defensive", reason: `TODO ${at}` };
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const count = (c) =>
    rows.filter((r) => r.class === c && live.has(r.site)).length;
  console.log(
    `guard sites: ${sites.length} enumerated, ${rows.length} rows ` +
      `(tested ${count("tested")}, unreachable ${count("unreachable")}, ` +
      `defensive ${count("defensive")}); bare reverts: ${bare.length}`,
  );
  if (errors.length) {
    for (const e of errors) console.error(`::error::guards table: ${e}`);
    process.exit(1);
  }
}

main();
