#!/usr/bin/env node
"use strict";
// Phase 4 exit row (plan v2 Task 4.15, D49): no hand-written file at or
// above 500 lines. Hand-written means every git-tracked file under
// contracts/ (minus the generated verifiers), demo/, scripts/, test/ and
// docs/. The files that were already at or above 500 when the gate was
// written are allowlisted with their line count then, shrink-only: an
// allowlisted file may not grow, and once it drops under 500 its entry
// must go (the gate says so). Tests and docs on the list are split in
// Phase 5. Exits 1 on any finding; `node scripts/ci/line-count-ratchet.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");

const LIMIT = 500;
const ROOTS = ["contracts/", "demo/", "scripts/", "test/", "docs/"];
const EXEMPT = [/^contracts\/privacy\/verifiers\//];
// Allowlist, measured at aa65de8 (2026-10-12, the start of Task 4.15).
const ALLOW = {
  "test/EnhancedEscrow.test.js": 1575,
  "docs/TESTNET_DEMO.md": 1184,
  "test/KeyManager.test.ts": 1087,
  "test/integration/OracleIntegration.test.ts": 884,
  "test/ClaimIssuer.test.ts": 880,
  "test/FairVotingSystem.test.ts": 846,
  "test/governance/HardeningRound2.test.ts": 833,
  "docs/TECHNICAL_DEEP_DIVE.md": 831,
  "test/production/ProductionSimulation.test.ts": 826,
  "test/investor/InvestorOnboarding.test.ts": 758,
  "test/integration/OracleERC3643Integration.test.ts": 742,
  "test/GovernanceComplianceIntegration.test.ts": 714,
  "test/OnchainID.test.ts": 697,
  "test/oracle/OracleManager.test.ts": 626,
  "test/GovernanceToken.test.ts": 623,
  "test/production/ProductionEnvironment.ts": 573,
  "test/OnchainID.coverage.test.ts": 546,
  "test/OnchainIDFactory.test.ts": 537,
  "test/GovernanceTokenKYCRestriction.test.ts": 510,
  "test/governance/QuorumIntegrity.test.ts": 509,
};

function lineCount(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const tracked = execFileSync("git", ["ls-files", "-z", ...ROOTS], {
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f && !EXEMPT.some((re) => re.test(f)));

const findings = [];
const seen = new Set();
for (const file of tracked) {
  const n = lineCount(file);
  const cap = ALLOW[file];
  if (cap !== undefined) {
    seen.add(file);
    if (n > cap) {
      findings.push(`${file}: ${n} lines, grew past its allowlisted ${cap}`);
    } else if (n < LIMIT) {
      findings.push(
        `${file}: ${n} lines, now under ${LIMIT}: remove it from ALLOW`,
      );
    }
  } else if (n >= LIMIT) {
    findings.push(`${file}: ${n} lines (limit ${LIMIT}, not allowlisted)`);
  }
}
for (const file of Object.keys(ALLOW)) {
  if (!seen.has(file)) findings.push(`${file}: allowlisted but not tracked`);
}

const scanned = tracked.length;
if (findings.length) {
  for (const f of findings) console.error(`::error::line-count ratchet: ${f}`);
  console.error(`${findings.length} finding(s) over ${scanned} files`);
  process.exit(1);
}
console.log(
  `line-count ratchet: ${scanned} files under ${ROOTS.join(" ")}, ` +
    `${Object.keys(ALLOW).length} allowlisted (shrink-only), none at or above ${LIMIT}`,
);
