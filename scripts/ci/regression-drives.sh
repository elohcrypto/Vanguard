#!/usr/bin/env bash
#
# Regression drives of the interactive demo (Task 4.17; the sixth since
# Task 5.10, the seventh since 5.12): strict drives through
# scripts/demo-drive.sh, each with
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
#   rotate     5.12 (D50, R-56-2): after the ceremony 83f audits (wallets
#              1-3 "registered by the deployer"), option 76 -> 2 -> 7
#              registers three demo wallets by vote, then 76 -> 2 -> 3
#              removes wallets 1-3 by vote (6, 5, 4, 3 nodes: never
#              TooFewNodes or SingleNodeQuorum); 33a is answered by the new
#              nodes only, and 83f again shows no deployer-era node line
#              (the voted nodes are skipped as governance-registered)
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

# bcount <start> <n> <needle>: needle lines in the nth block that opens
# with a line matching start and ends at the next menu prompt.
bcount() {
  # The start regex goes through ENVIRON: -v would eat its backslashes.
  tr -d '\r' < "$LOG" | S="$1" awk -v n="$2" '
    $0 ~ ENVIRON["S"] { k++; b = (k == n) } /Select an option: / { b = 0 } b' \
    | grep -cE -- "$3" || true
}

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
# Anchored on the ✅ line: the completion check prints the same label
# behind ❌ when it fails.
need "$(count '^\s+✅ VanguardGovernance owns EscrowWalletFactory\s*$')" 1 \
  "factory vote"
need "$(count '^\s+✅ VanguardGovernance owns DynamicListManager\s*$')" 1 \
  "list manager vote"
need "$(count '^\s+✅ EscrowWalletFactory owned by governance, deployer holds no role\s*$')" 1 \
  "factory verified"
need "$(count '^\s+✅ DynamicListManager owned by governance\s*$')" 1 \
  "list manager verified"
ceremony
verdict escrowdlm

# rotate: the ceremony uses proposals #1-#10, so the three registrations
# are #11-#13 and the three removals #14-#16 (created before any removal
# runs, so node indices 0-2 are wallets 1-3). Voters 5-7; the proposer
# (wallet 4) executes. Measured 6:24 locally.
votes() { for p in "$@"; do for w in 5 6 7; do echo "77:$p:$w:y:"; done; done; }
mapfile -t REG_VOTES < <(votes 11 12 13)
mapfile -t RM_VOTES < <(votes 14 15 16)
drive rotate 1 21 51 31 74 "${CEREMONY_VOTERS[@]}" 22 32 83c:y 83d 83e 83f \
  76:2:7:NODE_4:: 76:2:7:NODE_5:: 76:2:7:NODE_6:: "${REG_VOTES[@]}" 79:y \
  78:11:y 78:12:y 78:13:y "76:2:3:0:D50 rotation" "76:2:3:1:D50 rotation" \
  "76:2:3:2:D50 rotation" "${RM_VOTES[@]}" 79:y 78:14:y 78:15:y 78:16:y \
  33a 83f 39 0
ceremony
AUDIT='HANDOVER STEP 4: DAY-2 AUDIT'
DEPLOYER_NODE='^\s+⚠️  OracleManager node 0x[0-9a-fA-F]{40} \(\w+\) was registered by the deployer'
PASSED='^⚠️  Audit passed with warnings: see above\.$'
need "$(bcount "$AUDIT" 1 "$DEPLOYER_NODE")" 3 "audit before: deployer-era node lines"
need "$(bcount "$AUDIT" 1 "$PASSED")" 1 "audit before: passed"
need "$(count '^\s+Call: OracleManager\.registerOracle\(0x[0-9a-fA-F]{40}, NODE_[456], ')" 3 \
  "registerOracle proposals"
need "$(count '^\s+Call: OracleManager\.removeOracle\(0x(70997970C51812dc3A010C7d01b50e0d17dc79C8|3C44CdDdB6a900fa2b585dd299e03d12FA4293BC|90F79bf6EB2c4f870365E785982E1f101E93b906), D50 rotation\)')" 3 \
  "removeOracle proposals for wallets 1-3"
need "$(count '^\s+Executing from 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 \(the proposer\)')" 6 \
  "executed by the proposer"
need "$(count '^✅ PROPOSAL EXECUTED')" 6 "executions"
ROUND='WHITELIST BY CONSENSUS \(OPTION 33a\)'
need "$(bcount "$ROUND" 1 '^\s+🗳️  0x[0-9a-fA-F]{6}…[0-9a-fA-F]{4} answered YES')" 2 "33a answers"
need "$(bcount "$ROUND" 1 '^\s+✅ 0x[0-9a-fA-F]{40} by the verdict: listed at tier 4')" 1 \
  "33a verdict applied"
old=$(bcount "$ROUND" 1 '0x(709979|3C44Cd|90F79b)')
[[ "${old:-0}" -eq 0 ]] || REASONS+=("33a: $old line(s) name a wallet 1-3 node")
after=$(bcount "$AUDIT" 2 'registered by the deployer')
[[ "${after:-0}" -eq 0 ]] || REASONS+=("audit after: $after deployer-era node line(s)")
need "$(bcount "$AUDIT" 2 '^\s+✅ every registered OracleManager node is acknowledged in oracleNodes \(3 registered, 6 acknowledged\)')" 1 \
  "audit after: three voted nodes"
need "$(bcount "$AUDIT" 2 "$PASSED")" 1 "audit after: passed"
need "$(bcount 'ORACLE SYSTEM DASHBOARD' 1 '^   Total Oracles: 3$')" 1 \
  "option 39 after the rotation"
need "$(bcount 'ORACLE SYSTEM DASHBOARD' 1 '^NODE_[456] \(wallet (8|12|13)\):$')" 3 \
  "option 39 lists the voted nodes"
quorum=$(count 'TooFewNodes|SingleNodeQuorum')
[[ "${quorum:-0}" -eq 0 ]] || REASONS+=("$quorum TooFewNodes/SingleNodeQuorum line(s)")
verdict rotate

exit $failed
