#!/usr/bin/env bash
#
# Coverage ratchet: the instrumented suite passes and line coverage does
# not DROP below BASELINE; a climb of 2+ points prints a notice.
#
# Baseline 97 (Task 5.3): 97.43% lines measured at a9f18fb and in CI
# (run 38432941280), 97.61% at 1317330 with the 5.3 guard tests, rounded
# down.
# Earlier: 95 at the 4.15 tree (96.48%, 2026-10-12, Q11 b); 63.73% ->
# 65 -> 84 -> 86 -> 88 -> 90, 90.7% at c0e73fc, 95.33% at aa65de8 with
# three failures hidden. The run itself is a gate: a failing test fails it
# (no `|| true`; three permanent failures and, since 4.13, a corrupted
# run hid behind one).
#
# The plugin compiles instrumented bytecode into artifacts/; nothing else
# may compile in this tree while it runs, so CI gives it a job of its own
# and test/production/HandoverCliNode (child hardhat processes) skips
# itself under coverage. DEPLOY_GAS_LIMIT (set by the npm script) lifts
# the hard-coded deploy caps instrumented initcode exceeds.
#
# ZK_PROOFS=0 (set here) skips the PLONK-proving suites
# (test/helpers/zkProofs.js), all but ZKSystemIntegration, which proves
# under ZK=0 too: the test job proves everything, this run measures
# contract lines, and scripts/ci/zk-coverage.sh measures the proof
# suites. Memory: every executed step is traced, so one call's trace
# grows with its gas; the 5,000-key recovery and the 40-wallet
# governance batch overflowed the 4 GB heap (run 38199623932) and run
# small under coverage. Measured locally after that: 7.6 GB peak RSS
# (EDR native memory included), 15:26 wall, default heap.
#
# A failed run prints mocha's failure blocks (message and stack, capped)
# rather than only titles; CI uploads the full log on failure. Every run
# also passes the near-timeout guard (scripts/ci/mocha-log.js
# durations): a test over 75% of its own mocha timeout fails, over 50%
# warns, and the slowest 10 are printed.
#
# Leaves coverage.json for scripts/ci/branch-floors.js (run "contracts").
#
# Task 5.15 (L-6): CI runs it in shards (scripts/ci/test-shards.js), each a
# job of its own with the run's gates, then merges them
# (scripts/ci/coverage-merge.js sums every hit count) and applies the line
# baseline and the branch floors to the merge. Measured at 76ab084
# against an unsharded run of the same tree: 1861 passing and 170 pending
# in both, lines 97.61 in both, every contract floor's figure equal;
# overall branches 91.88 merged for 91.85, one arm (GovernanceProposals.sol
# :141, `target != expected`) hit in both shards and 0 times unsharded.
#
# USAGE  scripts/ci/coverage-ratchet.sh   (the whole suite; exit 1 on a finding)
#        scripts/ci/coverage-ratchet.sh --shard <i> <n>
#          shard i of n: tests pass and the near-timeout guard; no line
#          check (its own figure is printed)
#        scripts/ci/coverage-ratchet.sh --merged <n> <shard coverage.json>...
#          merges the n shards into coverage.json, then the line check
#        scripts/ci/coverage-ratchet.sh --from <log> <timings>
#          checks a saved run's log and timings without running it

set -uo pipefail
cd "$(dirname "$0")/../.."
BASELINE=97
LOG=coverage.log
TIMINGS=coverage-timings.log
SHARD=
MODE=${1:-}
run=0
case "$MODE" in
  --from)
    LOG=${2:?--from <log> <timings>}
    TIMINGS=${3:?--from <log> <timings>}
    grep -qE '^\s+[0-9]+ failing' "$LOG" && run=1
    ;;
  --merged)
    shift
    LOG=coverage-merge.log
    node scripts/ci/coverage-merge.js coverage.json "$@" > "$LOG" 2>&1 || run=1
    cat "$LOG"
    ;;
  *)
    if [ "${1:-}" = "--shard" ]; then
      SHARD="${2:?--shard <i> <n>}/${3:?--shard <i> <n>}"
      export TEST_SHARD=$SHARD TEST_SHARD_RUN=coverage # hardhat.config.ts
    fi
    rm -f "$TIMINGS"
    ZK_PROOFS=0 MOCHA_TIMINGS="$PWD/$TIMINGS" npm run test:coverage > "$LOG" 2>&1 || run=$?
    ;;
esac
if [ "$MODE" != "--merged" ]; then
  # Informational: mocha's "N passing (10m)" carries a suffix, and a run
  # with no pending or failing line is the normal case.
  grep -E '^\s+[0-9]+ (passing|failing|pending)' "$LOG" || true
  # A run (or a replayed log) passes only if mocha summarised it: a crash,
  # or a mocha that stalled and let hardhat exit 0, leaves no "N passing".
  if ! grep -qE '^\s+[0-9]+ passing' "$LOG"; then
    echo "::error::no mocha summary in $LOG: the run stopped before mocha finished"
    run=1
  fi
  slow=0
  node scripts/ci/mocha-log.js durations "$TIMINGS" || slow=1
  if [ "$run" -ne 0 ]; then
    echo "::error::the instrumented test run failed; see $LOG"
    node scripts/ci/mocha-log.js failures "$LOG" 200
    tail -20 "$LOG"
    exit 1
  fi
  [ "$slow" -eq 0 ] || { echo "::error::the near-timeout guard failed (above)"; exit 1; }
elif [ "$run" -ne 0 ]; then
  echo "::error::the shard merge failed (above)"
  exit 1
fi
lines=$(grep -E '^All files' "$LOG" | awk -F'|' '{gsub(/ /,"",$5); print $5}')
if [ -n "$SHARD" ]; then
  echo "shard $SHARD line coverage: ${lines:-<none>}% (the baseline applies to the merge)"
  exit 0
fi
echo "line coverage: ${lines:-<none>}% (baseline $BASELINE)"
if [ -z "$lines" ]; then
  echo "::error::coverage summary line not found; see $LOG"
  tail -20 "$LOG"
  exit 1
fi
if [ "$(printf '%s\n' "$lines" "$BASELINE" | sort -g | head -1)" != "$BASELINE" ]; then
  echo "::error::line coverage ${lines}% dropped below baseline ${BASELINE}%."
  exit 1
fi
if [ "$(printf '%s\n' "$lines" "$((BASELINE + 2))" | sort -g | head -1)" = "$((BASELINE + 2))" ]; then
  echo "::notice::line coverage ${lines}% is 2+ points above baseline — raise BASELINE in scripts/ci/coverage-ratchet.sh."
fi
exit 0
