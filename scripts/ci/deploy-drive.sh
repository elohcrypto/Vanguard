#!/usr/bin/env bash
#
# Production deploy drive (plan v2 Task 5.7, D48 a): the deploy CLI
# (scripts/production/DeployProduction.ts) against a local node through a
# SECOND process that holds every key (scripts/ci/remote-signer.js); the
# deploy process has none. The node runs on another mnemonic and funds
# the role wallets by hardhat_setBalance, so it cannot sign for them
# either (checked). In order:
#   1. deploy, killed (SIGKILL) once the record holds KILL_AT transactions,
#      resumed and killed again at KILL_AGAIN
#   2. resume through a faulting signer (Task 5.15: rate limits, dropped
#      connections, sends whose reply is lost): the record is replayed
#      (code hashes checked), the rest sent, handover.json written and its
#      preflight passed; the deployer's nonce equals the record's count
#      (nothing sent twice)
#   3. a tampered code hash in the record: refused, nothing sent
#   4. a re-run of the complete deploy sends nothing
#   5. voters registered (scripts/ci/deploy-voters.js)
#   6. the ceremony (scripts/handover.ts) through the faulting signer: all
#      acceptances open at once, the full phase killed after the first
#      settles, the accept phase adopts the rest; no sender sent twice,
#      settled within one vote's period and delay of chain time
#   7. it completes with exactly R-413-12's residual
#      set: 3 deployer-trusted PrivacyManager issuer keys, 3 deployer-era
#      nodes (D50), one exempt holder (the escrow fee wallet, exempted by
#      option 61; nothing mints the deployer VSC) and the banner; the
#      escrow factory moved to governance by vote; ops owns both list
#      oracles, the unbound whitelist oracle included (Task 5.14)
#
# USAGE  scripts/ci/deploy-drive.sh   (nodes on DEPLOY_NODE_PORT 8547 and
#        DEPLOY_SIGNER_PORT 8549; exit 1 on failure)

set -euo pipefail
cd "$(dirname "$0")/../.."
NODE_PORT=${DEPLOY_NODE_PORT:-8547}
SIGNER_PORT=${DEPLOY_SIGNER_PORT:-8549}
KILL_AT=${KILL_AT:-30}
KILL_AGAIN=${KILL_AGAIN:-67}
NODE_URL=http://127.0.0.1:$NODE_PORT
OUT=$(mktemp -d "${TMPDIR:-/tmp}/deploy-drive.XXXXXX")
ROLES="test test test test test test test test test test test junk"
NODE_PHRASE="candy maple cake sugar pudding cream honey rich smooth crumble sweet treat"
START=$SECONDS
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -- "-$p" 2>/dev/null || true; done
}
trap cleanup EXIT
fail() {
  echo "::error::deploy drive: $1"
  for f in "$OUT"/*.log; do echo "--- $f"; tail -30 "$f"; done
  exit 1
}
rpc() {
  curl -s -m 30 -X POST -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1"
}
up() {
  for _ in $(seq 1 60); do
    rpc "$1" eth_chainId "[]" | grep -q result && return 0
    sleep 1
  done
  fail "no node at $1"
}
rpc "$NODE_URL" eth_chainId "[]" | grep -q result && fail "port $NODE_PORT in use"
export SIGNER_TOKEN_FILE=$OUT/signer.token
# The signer answers only with its bearer token (scripts/production/
# rpcGuard.js), written to SIGNER_TOKEN_FILE once it listens.
sup() {
  for _ in $(seq 1 60); do
    [[ -s $SIGNER_TOKEN_FILE ]] && curl -s -m 30 -X POST -H "Content-Type: application/json" \
      -H "Authorization: Bearer $(cat "$SIGNER_TOKEN_FILE")" \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "http://127.0.0.1:$SIGNER_PORT" | grep -q result && return 0
    sleep 1
  done
  fail "no signer at $SIGNER_PORT"
}

MNEMONIC="$NODE_PHRASE" setsid node_modules/.bin/hardhat node --port "$NODE_PORT" \
  >"$OUT/node.log" 2>&1 &
PIDS+=($!)
up "$NODE_URL"
WALLETS=$(MNEMONIC="$ROLES" node -e 'const { HDNodeWallet, Mnemonic } = require("ethers");
  const m = Mnemonic.fromPhrase(process.env.MNEMONIC);
  for (let i = 0; i < 12; i++) console.log(HDNodeWallet.fromMnemonic(m, `m/44'"'"'/60'"'"'/0'"'"'/0/${i}`).address);')
for a in $WALLETS; do
  rpc "$NODE_URL" hardhat_setBalance "[\"$a\",\"0x21E19E0C9BAB2400000\"]" >/dev/null
done
DEPLOYER=$(echo "$WALLETS" | head -1)
rpc "$NODE_URL" eth_sendTransaction "[{\"from\":\"$DEPLOYER\",\"to\":\"$DEPLOYER\"}]" \
  | grep -q "Unknown account" || fail "the node signs for the deployer"
# signer <faults> [fault sends] [send delay ms]: (re)start the remote
# signer, faulting every n-th request (remote-signer.js; 0 = none).
SIGNER_PID=
signer() {
  if [[ -n $SIGNER_PID ]]; then
    kill -- "-$SIGNER_PID" 2>/dev/null || true
    wait "$SIGNER_PID" 2>/dev/null || true
  fi
  MNEMONIC="$ROLES" SIGNER_UPSTREAM=$NODE_URL SIGNER_FAULTS=$1 SIGNER_FAULT_SENDS=${2:-0} \
    SIGNER_SEND_DELAY_MS=${3:-0} setsid node scripts/ci/remote-signer.js "$SIGNER_PORT" \
    >>"$OUT/signer.log" 2>&1 &
  SIGNER_PID=$!
  PIDS+=($!)
  sup
}
signer 0

# The issuer's EdDSA public key (a fixed test key; the deploy gets only Ax, Ay).
node -e 'require("./scripts/zk/attest").attestorPublicKey("0x" + "11".repeat(32))
  .then((k) => console.log(JSON.stringify({ attestor: { Ax: String(k.Ax), Ay: String(k.Ay) } })))' \
  >"$OUT/deploy.json"
unset MNEMONIC PRIVATE_KEY
export SIGNER_RPC_URL=http://127.0.0.1:$SIGNER_PORT DEPLOY_CONFIG=$OUT/deploy.json \
  DEPLOY_RECORD=$OUT/31337.json HANDOVER_CONFIG=$OUT/handover.json
deploy() { npx hardhat run scripts/production/DeployProduction.ts --network remote; }
txs() { node -e 'try { console.log(require(process.argv[1]).txs.length) } catch { console.log(0) }' "$DEPLOY_RECORD"; }
nonce() { rpc "$NODE_URL" eth_getTransactionCount "[\"$DEPLOYER\",\"latest\"]" | sed -E 's/.*"result":"([^"]+)".*/\1/'; }
recorded() { node -e 'const r = require(process.argv[1]); console.log(r.txs.filter((t) => t.from.toLowerCase() === process.argv[2].toLowerCase()).length)' "$DEPLOY_RECORD" "$DEPLOYER"; }

# 1. Deploy, killed mid-way twice: at KILL_AT, then in the resumed run
#    at KILL_AGAIN, inside the escrow fee wallet's onboarding (identity
#    salt, claim signatures), so the replay crosses every flow.
killed_at() {
  setsid npx hardhat run scripts/production/DeployProduction.ts --network remote \
    >"$OUT/$2" 2>&1 &
  local d=$!
  for _ in $(seq 1 1200); do [[ $(txs) -ge $1 ]] && break; sleep 0.2; done
  kill -9 -- "-$d"
  wait "$d" 2>/dev/null || true
  [[ $(txs) -ge $1 ]] || fail "the deploy recorded $(txs) transactions, not $1"
  grep -q "Preflight passed" "$OUT/$2" && fail "the deploy finished before the kill"
  # The killed run's lock stays: a second deploy is refused until the
  # operator, sure none runs, removes it (runbook section 2).
  deploy >"$OUT/locked-$2" 2>&1 && fail "a held record was deployed on"
  grep -q "\.lock is held by pid [0-9]*: another deploy on this record" "$OUT/locked-$2" \
    || fail "no lock refusal"
  rm "$DEPLOY_RECORD.lock"
  echo "   killed with $(txs) transactions recorded; its lock refused a second run"
}
killed_at "$KILL_AT" deploy1.log
KILLED=$(txs)
killed_at "$KILL_AGAIN" deploy1b.log
grep -q "skipped (recorded" "$OUT/deploy1b.log" || fail "the first resume replayed nothing"
echo "1. killed twice ($KILLED, then $(txs) recorded)"

# 2. Resume, through a signer that faults (Task 5.15, M-3): rate limits,
#    dropped connections, and every 4th send's reply lost after sending.
KILLED=$(txs)
signer 6 4
deploy >"$OUT/deploy2.log" 2>&1 || fail "the resumed deploy failed"
signer 0
RETRIES=$(grep -c "↻" "$OUT/deploy2.log" || true)
ADOPTED=$(grep -c "adopted (not resent)" "$OUT/deploy2.log" || true)
[[ $RETRIES -ge 3 && $ADOPTED -ge 1 ]] || fail "faulted resume: $RETRIES retries, $ADOPTED adoptions"
SKIPPED=$(grep -c "skipped (recorded" "$OUT/deploy2.log" || true)
[[ $SKIPPED -ge $((KILLED - 1)) ]] || fail "resume replayed $SKIPPED of $KILLED"
grep -q "match the chain (code hashes)" "$OUT/deploy2.log" || fail "no record check"
grep -qE "^✅ Preflight passed" "$OUT/deploy2.log" || fail "no preflight pass"
[[ $(($(nonce))) -eq $(recorded) ]] \
  || fail "deployer nonce $(($(nonce))) != $(recorded) recorded: a send outside the record"
echo "2. resumed through faults ($RETRIES retries, $ADOPTED sends adopted): $SKIPPED replayed, $(grep -oE '[0-9]+ sent now' "$OUT/deploy2.log"); deployer nonce $(($(nonce))) = record"

# 3. A tampered code hash is refused before anything is sent.
cp "$DEPLOY_RECORD" "$OUT/record.bak"
node -e 'const fs = require("fs"); const f = process.argv[1]; const r = JSON.parse(fs.readFileSync(f));
  r.txs.find((t) => t.codeHash).codeHash = "0x" + "00".repeat(32); fs.writeFileSync(f, JSON.stringify(r));' "$DEPLOY_RECORD"
BEFORE=$(($(nonce)))
deploy >"$OUT/deploy3.log" 2>&1 && fail "a tampered record was accepted"
grep -q "never deploys over a recorded contract" "$OUT/deploy3.log" || fail "no code-hash refusal"
[[ $(($(nonce))) -eq $BEFORE ]] || fail "the refused run sent a transaction"
cp "$OUT/record.bak" "$DEPLOY_RECORD"
echo "3. tampered code hash refused; nonce unchanged at $BEFORE"

# 4. The complete deploy re-runs sending nothing.
deploy >"$OUT/deploy4.log" 2>&1 || fail "the re-run failed"
grep -qE "\(([0-9]+) from the record, 0 sent now;" "$OUT/deploy4.log" || fail "the re-run sent"
echo "4. re-run: $(grep -oE '[0-9]+ from the record, 0 sent now' "$OUT/deploy4.log")"

# 5. Voters on this deploy.
npx hardhat run scripts/ci/deploy-voters.js --network remote >"$OUT/voters.log" 2>&1 \
  || fail "voter registration failed"
# 6. The ceremony, its acceptances in parallel (Task 5.15, H-1, Q14 = A),
#    through the faulting signer (sends slowed): the full phase is killed
#    once its first acceptance settles; the accept phase finishes the rest,
#    adopting the open proposals (none twice: each voter sends exactly 2
#    transactions per proposal, the proposer 3).
lc() { node -e 'console.log(require(process.argv[1])[process.argv[2]])' "$HANDOVER_CONFIG" "$1"; }
addr() { echo "$WALLETS" | sed -n "$(($1 + 1))p"; }
SENDERS=("$(addr "$(lc proposer)")")
for v in $(node -e 'console.log(require(process.argv[1]).voters.join(" "))' "$HANDOVER_CONFIG"); do
  SENDERS+=("$(addr "$v")")
done
declare -A N0
for a in "${SENDERS[@]}"; do N0[$a]=$(($(rpc "$NODE_URL" eth_getTransactionCount "[\"$a\",\"latest\"]" | sed -E 's/.*"result":"([^"]+)".*/\1/'))); done
signer 40 7 300
setsid npx hardhat run scripts/handover.ts --network remote >"$OUT/ceremony1.log" 2>&1 &
C=$!
for _ in $(seq 1 3000); do grep -q "owned by governance (proposal #" "$OUT/ceremony1.log" && break; sleep 0.2; done
kill -9 -- "-$C" 2>/dev/null || true
wait "$C" 2>/dev/null || true
grep -q "Handover complete" "$OUT/ceremony1.log" && fail "the ceremony finished before the kill"
OPEN=$(grep -oE "🗳️  [0-9]+ proposal\(s\) open at once" "$OUT/ceremony1.log" | grep -oE "[0-9]+" | head -1)
DONE=$(grep -c "owned by governance (proposal #" "$OUT/ceremony1.log" || true)
[[ ${OPEN:-0} -ge 10 ]] || fail "${OPEN:-no} proposals open at once, not every acceptance"
export HANDOVER_SNAPSHOT_SHA256
HANDOVER_SNAPSHOT_SHA256=$(cut -d' ' -f1 "$HANDOVER_CONFIG.snapshot.json.sha256")
HANDOVER_PHASE=accept npx hardhat run scripts/handover.ts --network remote >"$OUT/ceremony.log" 2>&1 \
  || fail "the resumed ceremony failed"
signer 0
ADOPTED=$(grep -c "already open; adopted" "$OUT/ceremony.log" || true)
OWNED=$(grep -c "already owned by governance" "$OUT/ceremony.log" || true)
[[ $DONE -ge 1 && $OWNED -ge $DONE && $((ADOPTED + OWNED)) -eq $OPEN ]] \
  || fail "$ADOPTED adopted + $OWNED already accepted, not the $OPEN opened ($DONE settled before the kill)"
PROPOSALS=$(($(rpc "$NODE_URL" eth_call "[{\"to\":\"$(lc governance)\",\"data\":\"0xda35c664\"},\"latest\"]" | sed -E 's/.*"result":"([^"]+)".*/\1/')))
[[ $PROPOSALS -eq $OPEN ]] || fail "$PROPOSALS proposals, not the $OPEN opened"
for a in "${SENDERS[@]}"; do
  n=$(($(rpc "$NODE_URL" eth_getTransactionCount "[\"$a\",\"latest\"]" | sed -E 's/.*"result":"([^"]+)".*/\1/') - N0[$a]))
  want=$((2 * OPEN)); [[ $a == "${SENDERS[0]}" ]] && want=$((3 * OPEN))
  [[ $n -eq $want ]] || fail "$a sent $n transactions in the ceremony, not $want"
done
SPAN=$(grep -oE "settled [0-9]+ s of chain time" "$OUT/ceremony.log" | grep -oE "[0-9]+")
[[ ${SPAN:-99999999} -lt $((2 * 864000)) ]] || fail "settled over ${SPAN:-?} s of chain time, not one vote's 10 days"
FAULTED=$(cat "$OUT/ceremony1.log" "$OUT/ceremony.log" | grep -c "↻" || true)
ADOPTS=$(cat "$OUT/ceremony1.log" "$OUT/ceremony.log" | grep -c "adopted (not resent)" || true)
[[ $FAULTED -ge 3 && $ADOPTS -ge 1 ]] || fail "faulted ceremony: $FAULTED retries, $ADOPTS adoptions"
echo "6. ceremony: $OPEN acceptances open at once, killed after $OWNED settled, resumed adopting $ADOPTED; $PROPOSALS proposals, settled in $SPAN s of chain time; $FAULTED retries, $ADOPTS sends adopted, no sender sent twice"
V=$(sed -n '/Handover: verify/,$p' "$OUT/ceremony.log")
grep -q "❌" <<<"$V" && fail "a failed completion check"
count() { grep -cE "$1" <<<"$V" || true; }
[[ $(count '^\s+⚠️') -eq 7 ]] || fail "$(count '^\s+⚠️') warnings, not 7"
[[ $(count '^\s+⚠️  PrivacyManager issuer key .* was trusted by the deployer') -eq 3 ]] || fail "issuer-key warnings"
[[ $(count '^\s+⚠️  OracleManager node .* was registered by the deployer') -eq 3 ]] || fail "D50 node warnings"
[[ $(count 'escrowWalletFactory" is null') -eq 0 ]] || fail "no escrow factory deployed"
FEE=$(node -e 'console.log((require(process.argv[1]).feeWallets || ["none"])[0])' "$HANDOVER_CONFIG")
[[ $(count "^\s+⚠️  $FEE is investorLimitExempt \(set before the handover\)") -eq 1 ]] \
  || fail "no exempt-holder line for the escrow fee wallet"
[[ $(count '^⚠️  Handover complete with warnings: see above\.$') -eq 1 ]] || fail "no closing banner"
OWNER=$(node -e 'const { JsonRpcProvider, Contract } = require("ethers");
  const h = require(process.argv[1]); const p = new JsonRpcProvider(process.argv[2]);
  new Contract(h.escrowWalletFactory, ["function owner() view returns (address)"], p).owner()
    .then((o) => console.log(o.toLowerCase() === h.governance.toLowerCase() ? "governance" : o));' \
  "$HANDOVER_CONFIG" "$NODE_URL")
[[ $OWNER == governance ]] || fail "the escrow factory is owned by $OWNER, not governance"
OPS=$(echo "$WALLETS" | sed -n "$(($(node -e 'console.log(require(process.argv[1]).ops)' "$HANDOVER_CONFIG") + 1))p")
for k in whitelistOracle blacklistOracle; do
  O=$(node -e 'const { JsonRpcProvider, Contract } = require("ethers");
    new Contract(require(process.argv[1]).contracts[process.argv[2]], ["function owner() view returns (address)"],
      new JsonRpcProvider(process.argv[3])).owner().then((o) => console.log(o));' "$DEPLOY_RECORD" "$k" "$NODE_URL")
  [[ ${O,,} == "${OPS,,}" ]] || fail "$k is owned by $O, not ops $OPS"
done
[[ $(count '^\s+✅ the deployer owns no list oracle serving OracleManager') -eq 1 ]] \
  || fail "no line: the deployer owns no list oracle"
echo "7. ceremony complete: 3 issuer keys, 3 D50 nodes, exempt fee wallet, banner; escrow factory governance's; ops owns both list oracles"
echo "deploy drive PASS in $((SECONDS - START))s (logs $OUT)"
