#!/usr/bin/env bash
#
# Coverage ratchet: the instrumented suite passes and line coverage does
# not DROP below BASELINE; a climb of 2+ points prints a notice.
#
# Baseline 95 (Task 4.15, Q11 b): measured at 96.48% lines locally at
# the 4.15 tree on 2026-10-12 (earlier baselines 63.73% -> 65 -> 84 ->
# 86 -> 88 -> 90, 90.7% at c0e73fc, 95.33% at aa65de8 with three
# failures hidden). The run itself is a gate: a failing test fails it
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
# Leaves coverage.json for scripts/ci/branch-floors.js (run "contracts").
#
# USAGE  scripts/ci/coverage-ratchet.sh   (exit 1 on a finding)

set -uo pipefail
cd "$(dirname "$0")/../.."
BASELINE=95
LOG=coverage.log
if ! ZK_PROOFS=0 npm run test:coverage > "$LOG" 2>&1; then
  echo "::error::the instrumented test run failed; see $LOG"
  grep -E '^\s+[0-9]+ (passing|failing|pending)|^\s+[0-9]+\) ' "$LOG" | head -40 || true
  tail -20 "$LOG"
  exit 1
fi
# Informational: mocha's "N passing (10m)" carries a suffix, and a run
# with no pending or failing line is the normal case.
grep -E '^\s+[0-9]+ (passing|failing|pending)' "$LOG" || true
lines=$(grep -E '^All files' "$LOG" | awk -F'|' '{gsub(/ /,"",$5); print $5}')
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
