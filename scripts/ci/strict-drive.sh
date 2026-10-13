#!/usr/bin/env bash
#
# Strict demo drive (Task 4.15, Q11 c): one drive of the interactive
# demo through the complete ceremony on the smoke's node, still running.
# Option 1 deploys; 21/51/31/74 wire the ERC-3643, privacy, oracle and
# governance layers; 24 and 75a onboard four verified VGT holders; 22
# and 32; 83c passes the handover vote, 83d and 83e complete it.
# --strict fails on a demo error line, a failed ceremony check, or the
# demo's own non-zero exit; the log must carry the success line and no
# "Handover incomplete". Measured 1:22 locally.
#
# USAGE  DEMO_RPC_URL=... scripts/ci/strict-drive.sh   (exit 1 on failure)

set -euo pipefail
: "${DEMO_RPC_URL:?set DEMO_RPC_URL}"
cd "$(dirname "$0")/../.."
LOG=$(mktemp "${TMPDIR:-/tmp}/demo-drive.XXXXXX")
./scripts/demo-drive.sh --strict --timeout 1500 --log "$LOG" \
  1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave \
  75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 0
if ! grep -qE '^\s+(✅|⚠️)\s+Handover complete' "$LOG" \
  || grep -q "Handover incomplete" "$LOG"; then
  echo "::error::the drive did not complete the handover"
  tail -40 "$LOG"
  exit 1
fi
echo "strict drive: handover complete (log $LOG)"
