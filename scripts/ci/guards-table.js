#!/usr/bin/env node
"use strict";
// Guard table gate (plan v2 Task 5.3; closes C CF-8). Every require /
// revert / custom-error revert site in contracts/ has one row in
// test/guards/table/<dir>.json (dir = the contract's folder under
// contracts/; one row per line keeps each file under the line-count
// ratchet) saying how it is covered:
//  - tested: `file` + `test` name an it() title in that test file; the
//    file names the site's reason string or error name (a test that
//    builds the reason from a template gives the literal part as
//    `asserts`), and the titled block itself names it and calls the
//    site's function (see blockMisses for `via` and `calls`). This
//    catches a row pointed at a test that neither names nor calls its
//    site; it is not proof the test fires that site (mutation is:
//    scripts/ci/guard-mutants.js, run by hand);
//  - unreachable: no caller can make it fire in the current code (an
//    earlier check or the callee's own revert always fires first);
//    `reason` says why and `mutant` names the mutation that leaves the
//    suite green;
//  - defensive: unreachable from any external caller in the current
//    wiring (not merely hard to reach); `reason` says why.
// Not enumerated: contracts/test/ (mocks and harnesses deployed only by
// tests) and contracts/privacy/verifiers/ (snarkjs-generated; their only
// reverts are assembly `revert(0, 0)`).
// Also refused in scope: assert() and inline-assembly revert (the table
// cannot key them), and one site key in two files (a copied contract).
// Not covered here: checks that report instead of reverting, such as
// Token._checkTransferFull's `return (false, "...")` branches; their
// reasons reach users through the transfer and canTransfer tests.
// A site is keyed by contract, function, condition and reason, not by
// line, so it survives line drift: `C.fn | condition | reason`, where a
// revert's condition is its innermost enclosing `if` (`!(...)` in an
// else, `catch` in a catch clause) and a repeat of the same key in one
// function gets ` #2`, ` #3`.
// The gate fails if a site has no row, a row names a site that no
// longer exists, a row is malformed, a tested row's title or reason is
// missing from its file, its it() never runs (under describe.skip,
// xdescribe, context.skip, xcontext or a `.only`: disabledIts; deep
// review H-1), or any test asserts a bare `.reverted` /
// `.rejected` (one without its reason string or custom error; CF-8).
// With --ran (the tests job's records), a tested row whose test did not
// pass there fails too (notPassed; slice A review HIGH-1): CI runs that
// after the tests job; the static checks stay the fast local gate.
// Exits 1 on any finding;
// `node scripts/ci/guards-table.js`            the gate
// `node scripts/ci/guards-table.js --ran <timings>...`  and the runs
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

/**
 * Every guard site in the in-scope contracts, keyed as above, plus the
 * checks this table cannot key (assert() and inline-assembly revert),
 * which the gate refuses in scope.
 */
function enumerateSites() {
  const sites = [];
  const banned = [];
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
    const add = (node, ctx, cond, reason, named, crange) => {
      let key = `${ctx.contract}.${ctx.fn} | ${cond} | ${reason}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) key += ` #${n}`;
      const line = node.loc.start.line;
      sites.push({
        key,
        file,
        line,
        fn: ctx.fn,
        named,
        range: node.range,
        crange,
      });
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
      if (node.type === "AssemblyCall" && node.functionName === "revert")
        banned.push(`${file}:${node.loc.start.line} assembly revert`);
      if (
        node.type === "FunctionCall" &&
        node.expression.type === "Identifier"
      ) {
        const [a0, a1] = node.arguments;
        const lit = (a) => (a && a.type === "StringLiteral" ? a.value : "");
        if (node.expression.name === "assert")
          banned.push(`${file}:${node.loc.start.line} assert()`);
        if (node.expression.name === "require") {
          const r = a1 ? lit(a1) || text(a1) : "";
          add(node, ctx, text(a0), r, lit(a1), a0.range);
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
  return { sites, banned };
}

const TITLE = /\bit\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
/**
 * it() titles of a test file, with their offsets; `it.skip` and `xit`
 * excluded. `off` names the form that keeps the test from counting
 * (see disabledIts), "" for a live one.
 */
const parsed = new Map();
function titlesOf(src, file = "test.ts") {
  const memo = `${file}\0${src}`;
  if (parsed.has(memo)) return parsed.get(memo);
  const off = disabledIts(src, file);
  const out = [];
  for (const m of src.matchAll(TITLE))
    out.push({ title: m[2], at: m.index, off: off.get(m.index) || "" });
  parsed.set(memo, out);
  return out;
}

const SUITE = new Set(["describe", "context", "it", "specify"]);
const XSUITE = new Set(["xdescribe", "xcontext", "xit", "xspecify"]);
/**
 * Deep review H-1: a tested row is evidence only if its it() runs, and
 * the TITLE regex sees the it( text, not its scope. Parse the file (the
 * TypeScript parser reads .js and .ts) and track describe/context
 * nesting: an it() under `describe.skip`, `context.skip`, `xdescribe`
 * or `xcontext` never runs, and one under `.only` (or an `it.only`) is
 * a focus left in, which CI refuses (hardhat.config.ts forbidOnly).
 * Returns: offset of the it() call -> the outermost such form.
 */
function disabledIts(src, file) {
  const ts = require("typescript");
  const kind = /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const form = (e) => {
    if (ts.isIdentifier(e)) {
      if (XSUITE.has(e.text)) return { base: e.text, off: e.text };
      return SUITE.has(e.text) ? { base: e.text, off: "" } : null;
    }
    if (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      SUITE.has(e.expression.text) &&
      ["skip", "only"].includes(e.name.text)
    )
      return { base: e.expression.text, off: e.getText(sf) };
    return null;
  };
  const out = new Map();
  const walk = (node, off) => {
    if (ts.isCallExpression(node)) {
      const f = form(node.expression);
      if (f) {
        off = off || f.off;
        if (f.base === "it" && off) out.set(node.getStart(sf), off);
      }
    }
    ts.forEachChild(node, (c) => walk(c, off));
  };
  walk(sf, "");
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
    const titles = titlesOf(src, file);
    titles.forEach((t, i) => {
      const block = src.slice(
        t.at,
        i + 1 < titles.length ? titles[i + 1].at : src.length,
      );
      if (t.off || !re.test(block)) return;
      if (fnCall.test(block) && !fallback?.exact)
        fallback = { file, test: t.title, exact: true };
      else if (!fallback) fallback = { file, test: t.title, exact: false };
    });
    if (fallback?.exact) break;
  }
  return fallback;
}

/**
 * The named it() block (its title to the next it(); any block of that
 * title, when a file repeats it) must hold the test's evidence, not just
 * its file: the reason (or `asserts`), or else `via`, the helper or
 * const the block asserts it through; and, for an external function,
 * its call `fn(`, or `calls`, the entry the block drives it through (a
 * helper, a manager, a selector string). A constructor, modifier or
 * internal (`_x`) site is checked for `calls` only when the row gives
 * one. A block under a skip or a focus (titlesOf `off`) is not evidence.
 * Returns what is missing, or "".
 */
function blockMisses(r, s, src, file) {
  const titles = titlesOf(src, file);
  const reason = r.asserts || s.named;
  const internal = /^(constructor|receive|fallback|modifier |_|<)/.test(s.fn);
  const call = r.calls || (internal ? "" : `${s.fn}(`);
  let why = "";
  for (let i = 0; i < titles.length; i++) {
    if (titles[i].title !== r.test) continue;
    if (titles[i].off) {
      why = why || `never runs: it sits in ${titles[i].off}`;
      continue;
    }
    const end = i + 1 < titles.length ? titles[i + 1].at : src.length;
    const block = src.slice(titles[i].at, end);
    if (r.via !== undefined && (r.via.length < 3 || !block.includes(r.via)))
      why = `block never uses "via" ${r.via}`;
    else if (r.via === undefined && reason && !block.includes(reason))
      why = `block never names "${reason}"`;
    else if (call && !block.includes(call)) why = `block never calls ${call}`;
    else return "";
  }
  return why;
}

/**
 * Slice A review HIGH-1: a tested row is evidence only if its test RAN
 * AND PASSED. The static checks read text, so a file commented out line
 * by line, or a describe under `if (process.env.X)`, still passed them.
 * `ran` are the tests job's MOCHA_TIMINGS records (scripts/ci/mocha-log.js:
 * one line per passing test, {kind, name, file}; that job forbids pending,
 * so every file it loads runs). Returns the rows whose (file, title) no
 * passing test matches; a title holding `${...}` matches any expansion.
 */
function notPassed(rows, ran) {
  const passed = new Map();
  for (const r of ran) {
    if (r.kind !== "test") continue;
    if (!passed.has(r.file)) passed.set(r.file, []);
    passed.get(r.file).push(r.name);
  }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rows.filter((r) => {
    const re = new RegExp(
      `^${r.test
        .split(/\$\{[^}]*\}/)
        .map(esc)
        .join(".*")}$`,
    );
    return !(passed.get(r.file) || []).some((n) => re.test(n));
  });
}

/** The MOCHA_TIMINGS records in `files` (JSON lines); empty files refused. */
function readRan(files) {
  const out = [];
  for (const f of files) {
    const recs = fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (!recs.some((r) => r.kind === "test"))
      throw new Error(`${f} records no passing test (no run?)`);
    out.push(...recs);
  }
  return out;
}

function main() {
  const suggest = process.argv.includes("--suggest");
  const ranAt = process.argv.indexOf("--ran");
  const ran = ranAt < 0 ? null : readRan(process.argv.slice(ranAt + 1));
  if (ran && ranAt + 1 >= process.argv.length)
    throw new Error("--ran needs the tests job's MOCHA_TIMINGS files");
  const { sites, banned } = enumerateSites();
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
  const live = new Map();
  for (const s of sites) {
    const other = live.get(s.key);
    // Two contracts of one name in two files share keys, so a copy would
    // need no rows: refuse it (rename one) rather than key by path.
    if (other && other.file !== s.file)
      errors.push(`site key in ${other.file} and ${s.file}: ${s.key}`);
    live.set(s.key, s);
  }
  for (const b of banned)
    errors.push(`${b}: use require/revert with a reason (not keyed here)`);
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
      else if (!titlesOf(src, r.file).some((t) => t.title === r.test))
        errors.push(`no test titled "${r.test}" in ${r.file}: ${r.site}`);
      else if (!titlesOf(src, r.file).some((t) => t.title === r.test && !t.off))
        errors.push(
          `"${r.test}" (${r.file}) never runs, it sits in ${titlesOf(src, r.file).find((t) => t.title === r.test).off}: ${r.site}`,
        );
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
      else {
        const why = blockMisses(r, s, src, r.file);
        if (why) errors.push(`"${r.test}" (${r.file}) ${why}: ${r.site}`);
      }
    } else if (!r.reason || (r.class === "unreachable" && !r.mutant)) {
      errors.push(
        `${r.class} row needs reason${r.class === "unreachable" ? " and mutant" : ""}: ${r.site}`,
      );
    }
  }
  if (ran) {
    const tested = rows.filter((r) => r.class === "tested" && live.has(r.site));
    for (const r of notPassed(tested, ran))
      errors.push(
        `"${r.test}" (${r.file}) did not pass in the recorded test runs: ${r.site}`,
      );
    console.log(
      `ran: ${ran.filter((r) => r.kind === "test").length} passing tests recorded; ${tested.length} tested rows checked against them`,
    );
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

if (require.main === module) main();
else module.exports = { enumerateSites, titlesOf, notPassed, TABLE_DIR, SKIP };
