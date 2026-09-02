#!/usr/bin/env node
/**
 * Inserts a code-length check after each existing zero-address check for
 * parameters that audit-setter-guards.js flagged as cast to a contract type.
 *
 * Written as a transform rather than 48 hand-edits: the risk in a repetitive
 * change is a typo that names the wrong parameter, which compiles fine and
 * guards nothing. Deriving each line mechanically from the parameter name
 * removes that failure mode.
 *
 * Only touches parameters that ALREADY have a `!= address(0)` require, so the
 * insertion point is unambiguous. Findings without a zero-check are reported
 * and left alone for manual handling.
 *
 * Usage:
 *   node scripts/apply-setter-guards.js --dry-run    # show planned edits
 *   node scripts/apply-setter-guards.js --file <p>   # limit to one file
 *   node scripts/apply-setter-guards.js              # apply
 */

const fs = require("fs");
const path = require("path");

const dryRun = process.argv.includes("--dry-run");
const fileArgIdx = process.argv.indexOf("--file");
const onlyFile = fileArgIdx !== -1 ? process.argv[fileArgIdx + 1] : null;

// Reuse the auditor's findings so detection and repair share one source of truth.
const { execSync } = require("child_process");
const auditOut = (() => {
  try {
    return execSync("node scripts/audit-setter-guards.js", {
      encoding: "utf8",
    });
  } catch (e) {
    return e.stdout || ""; // exits 1 when findings exist
  }
})();

const findings = [];
for (const line of auditOut.split("\n")) {
  const m = line.match(
    /^\s+(\S+\.sol):(\d+)\s+(\w+)\((\w+)\)\s+->\s+(\S+)\s+\[(.+)\]/,
  );
  if (!m) continue;
  const [, file, lineNo, fn, param, castTo, zeroNote] = m;
  findings.push({
    file,
    line: Number(lineNo),
    fn,
    param,
    castTo,
    hasZeroCheck: zeroNote.includes("has zero-check"),
  });
}

const targets = onlyFile
  ? findings.filter((f) => f.file === onlyFile)
  : findings;

/** Human-readable field name from a parameter: _complianceRules -> "Compliance rules" */
const ACRONYMS = new Set(["VSC", "VGT", "ZK", "UTXO", "KYC", "AML", "ID"]);
function label(param) {
  const parts = param
    .replace(/^_/, "")
    .replace(/([A-Z])/g, " $1")
    .trim()
    .split(/\s+/);
  return parts
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase();
    })
    .join(" ");
}

const byFile = new Map();
for (const f of targets) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}

let inserted = 0;
const skipped = [];

for (const [file, items] of byFile) {
  const contract = path.basename(file, ".sol");
  let lines = fs.readFileSync(file, "utf8").split("\n");

  // Apply bottom-up so earlier insertions do not shift later line numbers.
  const zeroCheckLines = [];
  for (const item of items) {
    if (!item.hasZeroCheck) {
      skipped.push(item);
      continue;
    }
    // Find the zero-check for this parameter within the member's body.
    const re = new RegExp(`${item.param}\\s*!=\\s*address\\(0\\)`);
    let found = -1;
    for (
      let i = item.line - 1;
      i < Math.min(item.line + 30, lines.length);
      i++
    ) {
      if (re.test(lines[i])) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      skipped.push(item);
      continue;
    }
    // Multi-line require(...): advance to the statement's terminating semicolon.
    while (found < lines.length && !lines[found].includes(";")) found++;
    zeroCheckLines.push({ at: found, item });
  }

  zeroCheckLines.sort((a, b) => b.at - a.at);

  for (const { at, item } of zeroCheckLines) {
    const indent = (lines[at].match(/^\s*/) || [""])[0];
    const msg = `${contract}: ${label(item.param)} is not a contract`;
    const stmt = `${indent}require(${item.param}.code.length > 0, "${msg}");`;
    if (stmt.length > 120) {
      // Keep within the project's formatting width.
      lines.splice(
        at + 1,
        0,
        `${indent}require(`,
        `${indent}    ${item.param}.code.length > 0,`,
        `${indent}    "${msg}"`,
        `${indent});`,
      );
    } else {
      lines.splice(at + 1, 0, stmt);
    }
    inserted++;
    if (dryRun) console.log(`  ${file}:${at + 1}  + ${stmt.trim()}`);
  }

  if (!dryRun && zeroCheckLines.length) {
    fs.writeFileSync(file, lines.join("\n"));
    console.log(`✏️  ${file}: +${zeroCheckLines.length} guard(s)`);
  }
}

console.log(`\n${dryRun ? "Would insert" : "Inserted"} ${inserted} guard(s).`);
if (skipped.length) {
  console.log(
    `\n⚠️  ${skipped.length} finding(s) need manual handling (no zero-check to anchor to):`,
  );
  for (const s of skipped)
    console.log(`  ${s.file}:${s.line}  ${s.fn}(${s.param})`);
}
