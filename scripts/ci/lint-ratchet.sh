#!/usr/bin/env bash
#
# Lint ratchet: no solhint errors and no NEW warnings. Solhint's own
# exit code is not a gate: it exits 0 on errors, and its --max-warnings
# check is skipped when the first file reported has an error. Its stdout
# is also truncated under a pipe (process.exit before flush), so the
# report goes to a file and is counted from there. Any error fails;
# warnings fail only when they RISE above the baseline. Solhint exiting
# anything but 0 or 1 (a crash, a bad config), or reporting neither an
# error nor a warning (it did not lint), fails too: an empty report is
# not a pass.
#
# Baseline history: 976 before Task 3.2, 965 after 3.2, 944 after the
# Task 3.3 PrivacyManager rewrite, 933 after 3.7b, 917 after 3.8 dropped
# PrivacyManager's own jurisdiction registry, 889 after 4.1 dropped
# ComplianceRules' inert rule store and split the contract, 887 after
# 4.2 dropped KeyManager's owner and allowlist, 885 after 4.3 moved
# trust registration into registrar contracts, 802 then 801 during 4.4,
# 798 after 4.5 dropped OnchainID's topic store, 793 (2026-10-06) after
# 4.7 deleted an unimported payment interface and two unused mocks, 788
# (2026-10-07) after 4.8 slice 1 split eight contracts and dropped the
# IdentityRegistry investor-type pointer, 781 (2026-10-13, Task 5.10:
# measured at 7241173).
#
# USAGE  scripts/ci/lint-ratchet.sh   (exit 1 on a finding)

set -uo pipefail
cd "$(dirname "$0")/../.."
BASELINE=781
LOG=$(mktemp "${TMPDIR:-/tmp}/solhint.XXXXXX")
rc=0
npx solhint -f unix 'contracts/**/*.sol' > "$LOG" 2>&1 || rc=$?
errors=$(grep -c '\[Error/' "$LOG" || true)
warnings=$(grep -c '\[Warning/' "$LOG" || true)
echo "solhint: exit $rc, $errors errors, $warnings warnings (warning baseline $BASELINE)"
if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
  echo "::error::solhint exited $rc (a crash or a config error, not a lint result)."
  tail -20 "$LOG"
  exit 1
fi
if [ "$errors" -eq 0 ] && [ "$warnings" -eq 0 ]; then
  echo "::error::solhint reported no error and no warning: did it run?"
  tail -20 "$LOG"
  exit 1
fi
if [ "$errors" -gt 0 ]; then
  echo "::error::solhint reported $errors error(s)."
  grep '\[Error/' "$LOG"
  exit 1
fi
if [ "$warnings" -gt "$BASELINE" ]; then
  echo "::error::solhint warning count rose from $BASELINE to $warnings."
  exit 1
fi
if [ "$warnings" -lt "$BASELINE" ]; then
  echo "::notice::solhint warnings dropped to $warnings — lower BASELINE in scripts/ci/lint-ratchet.sh."
fi
exit 0
