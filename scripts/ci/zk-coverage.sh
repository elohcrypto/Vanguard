#!/usr/bin/env bash
#
# The proof suites under coverage (Task 4.15): PrivacyManager's
# attestation and binding guards run only on real PLONK proofs, so the
# ZK_PROOFS=0 contract run sees about 53% of its branches and the real
# figure needs ZK_PROOFS=1. An instrumented run of test/privacy/ alone
# (proving dominates; about 12:00 locally). The run is a gate: a failing
# test fails it. Leaves coverage.json for scripts/ci/branch-floors.js
# (run "proofs"), which asserts PrivacyManager's branch floor. Failure
# blocks and the near-timeout guard as in scripts/ci/coverage-ratchet.sh.
#
# USAGE  scripts/ci/zk-coverage.sh   (exit 1 on a failing or slow run)
#        scripts/ci/zk-coverage.sh --from <log> <timings>

set -uo pipefail
cd "$(dirname "$0")/../.."
LOG=coverage-zk.log
TIMINGS=coverage-zk-timings.log
if [ "${1:-}" = "--from" ]; then
  LOG=${2:?--from <log> <timings>}
  TIMINGS=${3:?--from <log> <timings>}
  run=0
  # A replayed log passes only if mocha summarised it with no failure:
  # a crash log with no "N passing" line is a failed run.
  grep -qE '^\s+[0-9]+ failing' "$LOG" && run=1
  grep -qE '^\s+[0-9]+ passing' "$LOG" || run=1
else
  rm -f "$TIMINGS"
  run=0
  ZK_PROOFS=1 MOCHA_TIMINGS="$PWD/$TIMINGS" npm run test:coverage -- \
    --testfiles 'test/privacy/**/*.{js,ts}' > "$LOG" 2>&1 || run=$?
fi
grep -E '^\s+[0-9]+ (passing|failing|pending)' "$LOG" || true
slow=0
node scripts/ci/mocha-log.js durations "$TIMINGS" || slow=1
if [ "$run" -ne 0 ]; then
  echo "::error::the instrumented proof suites failed; see $LOG"
  node scripts/ci/mocha-log.js failures "$LOG" 200
  tail -20 "$LOG"
  exit 1
fi
[ "$slow" -eq 0 ] || { echo "::error::the near-timeout guard failed (above)"; exit 1; }
exit 0
