#!/usr/bin/env node
/**
 * Finds setters that cast an address parameter to a contract interface without
 * checking that the address has code.
 *
 * Why this matters: `IFoo(addr)` performs no validation. If `addr` has no code,
 * the assignment succeeds and the failure surfaces later, inside whatever calls
 * the dependency, as a revert with no reason string — far from the cause.
 * Solidity's high-level call does insert an extcodesize check, so this fails
 * closed (a bricked subsystem) rather than open, but the diagnosis is painful.
 *
 * Usage:
 *   node scripts/audit-setter-guards.js          # list findings, exit 1 if any
 *   node scripts/audit-setter-guards.js --count  # print the count only
 *
 * Caveat: this is a regex scan of source, not semantic analysis. It can miss
 * unusual shapes. Treat a clean run as "no findings of this shape", not proof.
 */

const fs = require("fs");
const { execSync } = require("child_process");

const SKIP = ["/test/", "/interfaces/", "/mocks/"];

function findUnguardedSetters() {
  const files = execSync('git ls-files "contracts/**/*.sol"', {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((f) => f && !SKIP.some((s) => f.includes(s)));

  const findings = [];

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");

    for (let i = 0; i < lines.length; i++) {
      // Constructors have no `function` keyword and their parameter list often
      // spans several lines — they were invisible to an earlier version of this
      // scan, which hid a real defect in Token's constructor. Match both shapes.
      const fnSig = lines[i].match(/function\s+(\w+)\s*\(([^)]*)\)/);
      const ctorSig = /^\s*constructor\s*\(/.test(lines[i]);
      if (!fnSig && !ctorSig) continue;

      const fnName = fnSig ? fnSig[1] : "constructor";
      // For multi-line signatures, scan forward to the closing paren.
      const params = fnSig
        ? fnSig[2]
        : lines
            .slice(i, Math.min(i + 12, lines.length))
            .join("\n")
            .split(")")[0];

      const addressParams = [...params.matchAll(/address\s+(_?\w+)/g)].map(
        (m) => m[1],
      );
      if (addressParams.length === 0) continue;

      const body = lines.slice(i, Math.min(i + 30, lines.length)).join("\n");

      for (const param of addressParams) {
        // Is the parameter cast to a contract/interface type and stored?
        const cast = new RegExp(
          `=\\s*(I[A-Z]\\w+|[A-Z]\\w+)\\(\\s*${param}\\s*\\)`,
        ).exec(body);
        if (!cast) continue;

        const hasCodeCheck = new RegExp(`\\b${param}\\.code\\.length`).test(
          body,
        );
        if (hasCodeCheck) continue;

        findings.push({
          file,
          line: i + 1,
          fn: fnName,
          param,
          castTo: cast[1],
          hasZeroCheck: new RegExp(`${param}\\s*!=\\s*address\\(0\\)`).test(
            body,
          ),
        });
      }
    }
  }

  return findings;
}

const findings = findUnguardedSetters();

if (process.argv.includes("--count")) {
  console.log(findings.length);
  process.exit(0);
}

if (findings.length === 0) {
  console.log("✅ No unguarded contract-casting setters found.");
  process.exit(0);
}

console.log(
  `❌ ${findings.length} setter(s) cast an address to a contract without a code check:\n`,
);
for (const f of findings) {
  const zero = f.hasZeroCheck ? "has zero-check" : "NO zero-check";
  console.log(
    `  ${f.file}:${f.line}  ${f.fn}(${f.param}) -> ${f.castTo}  [${zero}]`,
  );
}
console.log(
  `\nAdd: require(${"<param>"}.code.length > 0, "<Contract>: <field> is not a contract");`,
);
process.exit(1);
