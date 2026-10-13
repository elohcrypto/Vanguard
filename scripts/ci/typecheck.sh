#!/usr/bin/env bash
#
# Typecheck: tsc exits 0 and reports no NEW errors. ts-node strips
# types, so the suite never sees tsc errors; this does. Baseline 0
# (2026-10-02, was 98 then 1): Task 3.3 replaced the ZK integration
# test's dead validatePrivacyProofs call. Since Task 4.17 (CF-7) tsc's
# own non-zero exit fails too, so a crash or a config error with no
# "error TS" line cannot pass; at baseline 0 that is the same gate.
# Runs after compile: tsc reads typechain-types/, which compile writes.
#
# USAGE  scripts/ci/typecheck.sh   (exit 1 on a finding)

set -uo pipefail
cd "$(dirname "$0")/../.."
BASELINE=0
LOG=$(mktemp "${TMPDIR:-/tmp}/tsc.XXXXXX")
test -d typechain-types || { echo "::error::typechain-types/ missing; compile did not generate it"; exit 1; }
rc=0
npx tsc --noEmit --pretty false > "$LOG" 2>&1 || rc=$?
count=$(grep -c 'error TS' "$LOG" || true)
echo "tsc exit $rc, errors: $count (baseline $BASELINE)"
if [ "$rc" -ne 0 ] && [ "$count" -le "$BASELINE" ]; then
  echo "::error::tsc exited $rc."
  tail -20 "$LOG"
  exit 1
fi
if [ "$count" -gt "$BASELINE" ]; then
  echo "::error::tsc error count rose from $BASELINE to $count."
  grep 'error TS' "$LOG"
  exit 1
fi
if [ "$count" -lt "$BASELINE" ]; then
  echo "::notice::tsc error count dropped to $count — lower BASELINE in scripts/ci/typecheck.sh."
fi
exit 0
