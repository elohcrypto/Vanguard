#!/usr/bin/env bash
#
# The proof suites under coverage (Task 4.15): PrivacyManager's
# attestation and binding guards run only on real PLONK proofs, so the
# ZK_PROOFS=0 contract run sees about 53% of its branches and the real
# figure needs ZK_PROOFS=1. An instrumented run of test/privacy/ alone
# (proving dominates; about 12:00 locally). The run is a gate: a failing
# test fails it. Leaves coverage.json for scripts/ci/branch-floors.js
# (run "proofs"), which asserts PrivacyManager's branch floor. A failed
# run prints mocha's failure blocks, as scripts/ci/coverage-ratchet.sh.
#
# USAGE  scripts/ci/zk-coverage.sh   (exit 1 on a failing run)

set -uo pipefail
cd "$(dirname "$0")/../.."
LOG=coverage-zk.log
if ! ZK_PROOFS=1 npm run test:coverage -- --testfiles 'test/privacy/**/*.{js,ts}' > "$LOG" 2>&1; then
  echo "::error::the instrumented proof suites failed; see $LOG"
  node scripts/ci/mocha-log.js failures "$LOG" 200
  tail -20 "$LOG"
  exit 1
fi
grep -E '^\s+[0-9]+ (passing|failing|pending)' "$LOG" || true
exit 0
