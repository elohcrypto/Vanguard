#!/usr/bin/env bash
#
# Regression drives of the interactive demo (Task 4.17; the sixth since
# Task 5.10): six strict drives through scripts/demo-drive.sh, each with
# the needles that pin what it exists to show. One PASS/FAIL line per
# drive; exits 1 when any drive fails.
#
#   onchainid  4.8 OnchainID claim options (2-11): a revoked claim reads
#              "claim revoked (not valid on chain)"
#   token      4.8 token options (23-30): a cooldown that "jumped"
#   1a         4.16 option 1a (oracles deployed with everything), then
#              the ceremony
#   q9         4.16 Q9 fill-then-bind: the ceremony, the VSC whitelist
#              oracle read, an approval refused below the tier
#              (TierBelowNewType, printed as "Approval refused (chain
#              rule, Q7 c)") and approved after option 33 raises it
#   glyph      4.16 glyph list: no error glyph but the menu's own Exit
#              line, and the VSC whitelist oracle read
#   escrowdlm  5.10: the ceremony with an EscrowWalletFactory (61) and a
#              DynamicListManager (84) deployed, so the handover moves
#              both to governance by vote and the verifier reads each
#              back as governance-owned (the deployer keeps no factory
#              role)
#
# Every ceremony drive (one carrying 83e) must print the success line
# (`^\s+(✅|⚠️)\s+Handover complete`) and no "Handover incomplete".
#
# FRESH CHAIN: each drive starts from genesis. The node is reset with
# hardhat_reset over JSON-RPC rather than restarted, so the script drives
# whatever node DEMO_RPC_URL names (CI: the smoke step's node) and needs
# no port or process of its own. The reset wipes that node's state: run
# this last on it.
#
# USAGE  DEMO_RPC_URL=http://127.0.0.1:8545 scripts/ci/regression-drives.sh
# Exit codes: 0 all PASS | 1 a drive FAILed | 3 no node / bad usage

set -uo pipefail

: "${DEMO_RPC_URL:?set DEMO_RPC_URL, e.g. http://127.0.0.1:8545}"
export DEMO_RPC_URL
cd "$(dirname "$0")/../.." || exit 3
DRIVE=./scripts/demo-drive.sh
OUT="$(mktemp -d)"
TIMEOUT=1500

rpc() {
  curl -s -m 30 -X POST -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":[],\"id\":1}" \
    "$DEMO_RPC_URL"
}
rpc eth_chainId | grep -q '"result"' \
  || { echo "error: no JSON-RPC node at $DEMO_RPC_URL" >&2; exit 3; }

failed=0
LOG=""
REASONS=()

# need <count> <min> <label>: the needle count must reach min.
need() {
  [[ "${1:-0}" -ge "$2" ]] || REASONS+=("$3: $1 (want >= $2)")
}

# drive <name> <choices...>: reset, drive strictly, set LOG to the demo.log.
drive() {
  local name=$1
  shift
  REASONS=()
  LOG=""
  if ! rpc hardhat_reset | grep -q '"result":true'; then
    REASONS+=("hardhat_reset refused")
    return
  fi
  local out="$OUT/$name.out"
  "$DRIVE" --strict --timeout "$TIMEOUT" "$@" > "$out" 2>&1
  local rc=$?
  LOG=$(grep -o '/tmp/tmp\.[A-Za-z0-9]*/demo.log' "$out" | tail -1)
  [[ $rc -eq 0 ]] || REASONS+=("demo-drive exit $rc")
  [[ -n "$LOG" && -f "$LOG" ]] || { REASONS+=("no demo.log in $out"); LOG=/dev/null; }
}

count() { grep -cE -- "$1" "$LOG" 2>/dev/null || true; }

ceremony() {
  need "$(count '^\s+(✅|⚠️)\s+Handover complete')" 1 "Handover complete"
  local bad
  bad=$(count 'Handover incomplete')
  [[ "${bad:-0}" -eq 0 ]] || REASONS+=("Handover incomplete: $bad line(s)")
}

verdict() {
  if [[ ${#REASONS[@]} -eq 0 ]]; then
    echo "PASS $1"
  else
    echo "FAIL $1 ($(IFS=';'; echo "${REASONS[*]}")) log $LOG out $OUT/$1.out"
    failed=1
  fi
}

CEREMONY_VOTERS=(24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave
  75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y)

drive onchainid 1 21 51 3:1:5 3:1:6 4:0 6:0:1:840 6:1:1:840 8 6:0:4 \
  7:0:4 7:0:1 9:0:1 10:0 11:0 6:0:5 6:0:4 6:0:3:1 6:1:2 7:0:2 7:0:3:3 \
  7:0:4 8 5:0:0 2:0:0 0
need "$(count 'claim revoked \(not valid on chain\)')" 1 "revoked-claim line"
verdict onchainid

drive token 1 21 51 22 25:1:3 25:5 25:4 24:1:Alice 24:1:Bob 24:1:Carol \
  24:2:Mallory:sanctions 24:3 23:1:Ivan 23:2:1:1 23:3:1 23:4:1 23:5:1 \
  23:6:1 23:2:1:2 23:3:1 23:4:1 23:5:1 23:6:1 23:7 23:9 23:9a 25:2 \
  25:3:0:100 26:1:0:0:100 26:2 26:3 27:1:0:0:50 27:2 27:3 27.5:0:1:10 \
  28:1 28:2 28:3 29 30 23:8:1 0
need "$(count 'jumped')" 1 "jumped line"
verdict token

drive 1a 1a "${CEREMONY_VOTERS[@]}" 22 32 83c:y 83d 83e 0
need "$(count 'DEPLOYING ORACLE MANAGEMENT SYSTEM')" 1 "1a oracle deploy"
need "$(count 'oracles registered')" 1 "oracles registered line"
ceremony
verdict 1a

drive q9 1 21 51 31 74 "${CEREMONY_VOTERS[@]}" 22 25:1:1 23:1:Eve \
  23:2:1:1 23:3:1 25:3:0:3000 23:4:1 23:5:1 32 83c:y 83d 83e 38a:y 17 \
  23:6:1 33:2:1:2:0:kyc-depth 23:6:1 17 20d 38 0
need "$(count 'Approval refused \(chain rule, Q7 c\)')" 1 "TierBelowNewType refusal"
need "$(count 'INVESTOR REQUEST APPROVED')" 1 "approval after the raise"
need "$(count 'whitelistOracle\(VSC\)')" 1 "whitelistOracle(VSC) line"
ceremony
verdict q9

drive glyph 1 21 51 31 74 22 15: 16 17 18 20 20b: 20c 20d 29 39 52 56 \
  59 60 80 9:0:1 10:0 41b 48 38 0
need "$(count 'whitelistOracle\(VSC\)')" 1 "whitelistOracle(VSC) line"
glyphs=$(count '❌')
menu=$(count '0\.  ❌ Exit')
[[ "${glyphs:-0}" -eq "${menu:-0}" ]] \
  || REASONS+=("$((glyphs - menu)) error glyph(s) besides the menu's Exit")
verdict glyph

drive escrowdlm 1 21 51 31 74 61 84 "${CEREMONY_VOTERS[@]}" 22 32 83c:y \
  83d 83e 0
need "$(count 'VanguardGovernance owns EscrowWalletFactory')" 1 "factory vote"
need "$(count 'VanguardGovernance owns DynamicListManager')" 1 "list manager vote"
need "$(count 'EscrowWalletFactory owned by governance, deployer holds no role')" 1 \
  "factory verified"
need "$(count 'DynamicListManager owned by governance')" 1 "list manager verified"
ceremony
verdict escrowdlm

exit $failed
