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
      // Match the OPENING of a function or constructor only. Constructors have
      // no `function` keyword, and either shape may spread its parameter list
      // over several lines.
      //
      // An earlier version anchored on /function\s+(\w+)\s*\(([^)]*)\)/, which
      // requires the closing paren on the SAME line. Every multi-line function
      // signature therefore failed to match and was skipped outright — the
      // scan reported clean on code it had never examined. Constructors had
      // already been given a forward scan; functions had not, despite a
      // comment claiming both were handled.
      const fnOpen = lines[i].match(/function\s+(\w+)\s*\(/);
      const ctorOpen = /^\s*constructor\s*\(/.test(lines[i]);
      if (!fnOpen && !ctorOpen) continue;

      const fnName = fnOpen ? fnOpen[1] : "constructor";

      // Collect the parameter list by scanning forward to the closing paren,
      // for BOTH shapes. Start from the opening paren so a `)` earlier on the
      // same line (e.g. a modifier call) cannot truncate it.
      const openIdx = lines[i].indexOf("(");
      const sigText = [
        lines[i].slice(openIdx),
        ...lines.slice(i + 1, Math.min(i + 12, lines.length)),
      ].join("\n");
      const closeIdx = sigText.indexOf(")");
      const params = closeIdx === -1 ? sigText : sigText.slice(0, closeIdx);

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

        // A `try` on the cast variable already handles a non-contract target:
        // the call reverts, control reaches `catch`, and the function returns a
        // defined result instead of bubbling an empty revert. The defect this
        // audit exists to catch — a silent late failure with no reason string —
        // cannot occur, so a code check would add nothing.
        //
        // ComplianceValidator.validateClaims is the case that forced this: it
        // is `view`, stores nothing, returns (false, 0) for address(0), and
        // wraps the call in try/catch. Requiring code there would reject a bad
        // address with a revert where the contract deliberately answers
        // "claims are invalid".
        const castVar = new RegExp(
          `(\\w+)\\s*=\\s*(?:I[A-Z]\\w+|[A-Z]\\w+)\\(\\s*${param}\\s*\\)`,
        ).exec(body);
        if (castVar && new RegExp(`try\\s+${castVar[1]}\\.`).test(body)) {
          continue;
        }

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
