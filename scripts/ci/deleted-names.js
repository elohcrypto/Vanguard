#!/usr/bin/env node
"use strict";
// Phase 4 exit row (plan v2 Task 4.15): `git grep` for the names Phase 3
// and 4 deleted returns nothing outside git history. FILES are deleted
// files (matched by basename anywhere in the tree); SYMBOLS are deleted
// identifiers (matched as whole words). The plan and review notes under
// .omc/ name them on purpose and are excluded, as is this gate. Exits 1
// on any hit; `node scripts/ci/deleted-names.js`. Add a name here in the
// commit that deletes it.
const { execFileSync } = require("child_process");

const FILES = [
  // Task 4.7 (88d9454): 17 orphan scripts, an interface, two mocks, a doc.
  "run-all-oracle-tests.js",
  "run-oracle-integration-test.js",
  "verify-investor-type-implementation.js",
  "reset-and-demo.js",
  "run-rejection-demo.js",
  "reset-everything.js",
  "start-hardhat-node.js",
  "test-all-demos.js",
  "reset-and-run-demo.js",
  "apply-setter-guards.js",
  "cleanup-outdated-scripts.sh",
  "rename-digital-yuan-to-digital-token.sh",
  "validate-setup.ts",
  "deploy-investor-onboarding.ts",
  "get-demo-values.js",
  "verify-circuit-builds.js",
  "verify-contracts.ts",
  "IMultiSigEscrowWallet.sol",
  "MockComplianceRules.sol",
  "MockComplianceRegistry.sol",
  "PAYMENT_PROTOCOL_DESIGN.md",
  "SECURITY_UPGRADE.md",
  // Task 5.5: docs split by topic (docs/TESTNET_*.md, docs/DEEP_DIVE_*.md).
  "TESTNET_DEMO.md",
  "TECHNICAL_DEEP_DIVE.md",
  // Task 5.5: a guide to a banking demo the code never had (four named
  // banks, a locked reserve, options 13-19 as token options).
  "VANGUARD_RWA_TOKEN_ECOSYSTEM_GUIDE.md",
  // Task 5.5: a pre-Phase-1 plan summary ("security audit passed",
  // links to Requirements.md, Tasks.md and Design.md that never existed).
  "WORKFLOW_IMPLEMENTATION_SUMMARY.md",
  // Task 5.5: the Task 5.4 split-parity gate, retired once the line-count
  // allowlist was empty (its header said so).
  "test-parity.js",
  "test-parity-baseline.json",
  // Task 4.16: two interfaces no contract imported, a demo helper no flow
  // required (review B L-1).
  "IMultiSigWallet.sol",
  "IInvestorRequestManager.sol",
  "ValidationHelpers.js",
];
const SYMBOLS = [
  // Task 4.1 (1a198ee): ComplianceRules' inert rule store.
  "MAX_COMPLIANCE_LEVELS",
  "MAX_INVESTOR_TYPES",
  "getJurisdictionByCode",
  "verifyUTXOCompliance",
  // Task 4.5 (0b750d5): OnchainID's duplicate claim walk.
  "_hasTrustedClaim",
  // Task 4.7 (88d9454): DemoState slots never set or read, a dead demo.
  "paymentProtocol",
  "paymentEscrow",
  "refundManager",
  "demonstrateTransferRestrictions",
  // Task 4.16: a DemoState method nothing called (review B L-1); the smoke's
  // direct OnchainID deploy, replaced by the factory path (Onboard.js).
  "hasContract",
  "deployPinned",
  // Task 5.5: the parity gate's environment hook (hardhat.config.ts).
  "TEST_PARITY_OUT",
];

const EXCLUDE = [
  ":!.omc",
  ":!scripts/ci/deleted-names.js",
  ":!package-lock.json",
];

function hits(args) {
  try {
    return execFileSync("git", ["grep", "-l", ...args, "--", ".", ...EXCLUDE], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // no match
    throw e;
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const findings = [];
for (const f of FILES) {
  // The file itself, under any directory.
  for (const t of tracked) {
    if (t.endsWith("/" + f) || t === f) findings.push(`${f} tracked as ${t}`);
  }
  for (const where of hits(["-F", "-e", f])) findings.push(`${f} in ${where}`);
}
for (const s of SYMBOLS) {
  for (const where of hits(["-w", "-F", "-e", s]))
    findings.push(`${s} in ${where}`);
}

if (findings.length) {
  for (const f of findings) console.error(`::error::deleted name back: ${f}`);
  process.exit(1);
}
console.log(
  `deleted-names gate: ${FILES.length} files and ${SYMBOLS.length} symbols absent`,
);
