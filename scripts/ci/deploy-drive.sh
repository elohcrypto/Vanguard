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
#   5. voters onboarded by scripts/production/onboardVoters.ts through
#      scripts/production/signer.js (no clock jump in the CLI; a re-run
#      sends nothing); the drive moves the dev clock
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
#   9. the cost table from steps 1-8's blocks (Task 5.15, Q19 = A)
#   8. the post-ceremony votes (Task 5.15, Q15 = A, Q20 = B): round 1
#      production nodes in and the attestor key re-approved, round 2 the
#      deployer-era nodes out; the day-2 audit shows none
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
# rpcGuard.js), written to SIGNER_TOKEN_FILE once it listens. Task 5.17
# (deep review L-7): curl reads it from a 0600 header file, never argv
# (ps shows a process's arguments to every user).
sup() {
  for _ in $(seq 1 60); do
    [[ -s $SIGNER_TOKEN_FILE ]] \
      && (umask 077 && printf 'Authorization: Bearer %s\n' "$(<"$SIGNER_TOKEN_FILE")" >"$OUT/signer.header") \
      && curl -s -m 30 -X POST -H "Content-Type: application/json" -H @"$OUT/signer.header" \
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

# Blocks around each step, for the cost table (step 9).
blk() { echo $(($(rpc "$NODE_URL" eth_blockNumber "[]" | sed -E 's/.*"result":"([^"]+)".*/\1/'))); }
B_DEPLOY=$(($(blk) + 1))
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
  [[ $(txs) -ge $1 && $(txs) -le $(($1 + 1)) ]] || fail "the deploy recorded $(txs) transactions, not $1"
  grep -q "Preflight passed" "$OUT/$2" && fail "the deploy finished before the kill"
  # The killed run's lock stays: a second deploy is refused until the
  # operator, sure none runs, removes it (runbook section 2).
  deploy >"$OUT/locked-$2" 2>&1 && fail "a held record was deployed on"
  grep -q "\.lock is held by pid [0-9]*: another deploy on this record" "$OUT/locked-$2" \
    || fail "no lock refusal"
  rm "$DEPLOY_RECORD.lock"
  echo "   killed with $(txs) transactions recorded; its lock refused a second run"
}
# Each send is slowed (400 ms at the signer) while the 0.2 s poll waits,
# so the kill lands at exactly the count asked, never past it (CI run
# 39205664146 raced to 72 of 74 and left the faulted resume 2 sends).
[[ $KILL_AT -lt $KILL_AGAIN && $KILL_AGAIN -le 73 ]] || fail "KILL_AT < KILL_AGAIN <= 73"
signer 0 0 400
killed_at "$KILL_AT" deploy1.log
KILLED=$(txs)
killed_at "$KILL_AGAIN" deploy1b.log
grep -q "skipped (recorded" "$OUT/deploy1b.log" || fail "the first resume replayed nothing"
echo "1. killed twice ($KILLED, then $(txs) recorded)"

# 2. Resume, through a signer that faults (Task 5.15, M-3): rate limits,
#    dropped connections, and EVERY send's reply lost after sending, so
#    each send the resume makes (at least one: the kill is at <= 73 of 74)
#    must be adopted from the chain, never sent twice.
KILLED=$(txs)
signer 6 1
deploy >"$OUT/deploy2.log" 2>&1 || fail "the resumed deploy failed"
signer 0
RETRIES=$(grep -c "↻" "$OUT/deploy2.log" || true)
ADOPTED=$(grep -c "adopted (not resent)" "$OUT/deploy2.log" || true)
SENT=$(grep -oE '[0-9]+ sent now' "$OUT/deploy2.log" | grep -oE '^[0-9]+')
[[ $RETRIES -ge 3 && ${SENT:-0} -ge 1 && $ADOPTED -eq ${SENT:-0} ]] \
  || fail "faulted resume: $RETRIES retries, $ADOPTED adoptions for ${SENT:-?} sends"
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

B_VOTERS=$(($(blk) + 1))
# 5. Voters on this deploy (H-2, Q16 = A): the production onboarding CLI
#    through the production signer (scripts/production/signer.js, its
#    keystores made here, 31337 by SIGNER_TEST=1). The CLI moves no clock;
#    the drive jumps the dev node past the time it printed. A re-run sends
#    nothing.
KS=$OUT/keystores
mkdir -m 700 "$KS"
(umask 077; printf '%s\n' "drive-only keystore password" >"$OUT/password")
MNEMONIC="$ROLES" node -e 'const { HDNodeWallet, Mnemonic, encryptKeystoreJson } = require("ethers");
  const fs = require("fs"); const m = Mnemonic.fromPhrase(process.env.MNEMONIC);
  (async () => { for (let i = 0; i < 12; i++) {
    const w = HDNodeWallet.fromMnemonic(m, `m/44'"'"'/60'"'"'/0'"'"'/0/${i}`);
    const j = await encryptKeystoreJson(w, "drive-only keystore password", { scrypt: { N: 1024 } });
    fs.writeFileSync(`${process.argv[1]}/${String(i).padStart(2, "0")}.json`, j, { mode: 0o600 });
  } })();' "$KS"
kill -- "-$SIGNER_PID" 2>/dev/null || true
wait "$SIGNER_PID" 2>/dev/null || true
SIGNER_TEST=1 SIGNER_KEYSTORE_DIR=$KS SIGNER_PASSWORD_FILE=$OUT/password SIGNER_UPSTREAM=$NODE_URL \
  setsid node scripts/production/signer.js "$SIGNER_PORT" >"$OUT/prod-signer.log" 2>&1 &
SIGNER_PID=$!
PIDS+=($!)
sup
grep -q "12 key(s), chain 31337" "$OUT/prod-signer.log" || fail "the production signer did not load 12 keys"
onboard() { npx hardhat run scripts/production/onboardVoters.ts --network remote >"$OUT/$1" 2>&1 \
  || fail "voter onboarding failed ($1)"; }
onboard voters.log
WAIT=$(grep -oE "[0-9]+ s to wait" "$OUT/voters.log" | grep -oE "^[0-9]+" || true)
[[ -n $WAIT ]] || fail "no eligibility time printed"
B0=$(($(rpc "$NODE_URL" eth_blockNumber "[]" | sed -E 's/.*"result":"([^"]+)".*/\1/')))
onboard voters2.log
[[ $(grep -c "(already onboarded)" "$OUT/voters2.log") -eq 3 ]] || fail "the re-run onboarded again"
[[ $(($(rpc "$NODE_URL" eth_blockNumber "[]" | sed -E 's/.*"result":"([^"]+)".*/\1/'))) -eq $B0 ]] \
  || fail "the onboarding re-run sent a transaction"
rpc "$NODE_URL" evm_increaseTime "[$((WAIT + 1))]" >/dev/null
rpc "$NODE_URL" evm_mine "[]" >/dev/null
echo "5. voters onboarded through the production signer (no clock jump; eligible in $WAIT s); a re-run sent nothing; the drive moved the dev clock"
signer 0
B_CEREMONY=$(($(blk) + 1))
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
# Task 5.17 (deep review, CI LOWs): the poll checks the ceremony is still
# alive (kill -0), so one that dies before its first acceptance fails now
# with its own exit code, not after the 600 s poll; so does a poll that
# runs out (the line looked for is printed before an exit, so it is
# re-read once the process is gone).
settled() { grep -q "owned by governance (proposal #" "$OUT/ceremony1.log"; }
for _ in $(seq 1 3000); do
  settled && break
  if ! kill -0 "$C" 2>/dev/null; then
    rc=0
    wait "$C" || rc=$?
    settled || fail "the ceremony exited (code $rc) before its first acceptance settled"
    break
  fi
  sleep 0.2
done
settled || { kill -9 -- "-$C" 2>/dev/null || true; fail "no acceptance settled in 600 s"; }
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

B_POST=$(($(blk) + 1))
# 8. Post-ceremony votes (Q15 = A, Q20 = B; two rounds): round 1
#    registers three production nodes (role-phrase wallets 12-14, keys
#    unused here) and re-approves the deployer-trusted issuer key for its
#    three circuits; round 2, once all three are registered, removes the
#    three deployer-era nodes; the day-2 audit then has no deployer-era
#    node or attestor line, only the exempt fee wallet's warning.
NEW=$(MNEMONIC="$ROLES" node -e 'const { HDNodeWallet, Mnemonic } = require("ethers");
  const m = Mnemonic.fromPhrase(process.env.MNEMONIC);
  console.log([12, 13, 14].map((i, k) => HDNodeWallet.fromMnemonic(m, `m/44'"'"'/60'"'"'/0'"'"'/0/${i}`).address + ":NODE_" + (k + 1)).join(","));')
NEW_NODES=$NEW npx hardhat run scripts/production/postCeremonyVotes.ts --network remote >"$OUT/post.log" 2>&1 \
  || fail "the post-ceremony votes failed"
grep -q "🗳️  round 1: 6 proposal(s), registrations and re-approvals" "$OUT/post.log" || fail "no round 1 of 6"
grep -q "🗳️  round 2: 3 removal(s), every production node registered" "$OUT/post.log" || fail "no round 2 of 3"
[[ $(sed -n '/round 2: /,$p' "$OUT/post.log" | grep -c "✅ register production node") -eq 0 ]] \
  || fail "a registration settled in round 2"
[[ $(grep -c "✅ register production node" "$OUT/post.log") -eq 3 ]] || fail "registrations"
[[ $(grep -c "✅ re-approve issuer key" "$OUT/post.log") -eq 3 ]] || fail "re-approvals"
[[ $(grep -c "✅ remove deployer-era node" "$OUT/post.log") -eq 3 ]] || fail "removals"
NODES=$(grep -oE 'set handover.json "oracleNodes" to \[.*\]' "$OUT/post.log" | sed -E 's/.* to //')
node -e 'const fs = require("fs"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f));
  c.oracleNodes = JSON.parse(process.argv[2]); fs.writeFileSync(f, JSON.stringify(c, null, 2));' "$HANDOVER_CONFIG" "$NODES"
HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network remote >"$OUT/audit.log" 2>&1 \
  || fail "the day-2 audit failed after the post-ceremony votes"
A=$(sed -n '/Handover audit/,$p' "$OUT/audit.log")
grep -q "❌" <<<"$A" && fail "a failed audit line"
[[ $(grep -c "registered by the deployer" <<<"$A") -eq 0 ]] || fail "a deployer-era node line remains"
[[ $(grep -c "was trusted by the deployer" <<<"$A") -eq 0 ]] || fail "a deployer-trusted attestor line remains"
[[ $(grep -cE '^\s+⚠️' <<<"$A") -eq 1 && $(grep -cE "^\s+⚠️  $FEE is investorLimitExempt" <<<"$A") -eq 1 ]] \
  || fail "the audit's warnings are not just the exempt fee wallet"
echo "8. post-ceremony votes: round 1 (3 registrations, 3 re-approvals), then round 2 (3 removals); audit: no deployer-era node or attestor line, one warning (the exempt fee wallet)"

# 9. Cost table (Q19 = A): each step's gas by sender, at COST_GWEI (20)
#    with 50% headroom, the deploy counted twice (the throwaway deploy).
B_END=$(blk)
echo "$WALLETS" >"$OUT/wallets.txt"
cat >"$OUT/steps.json" <<STEPS
[{"step":"deploy","from":$B_DEPLOY,"to":$((B_VOTERS - 1))},
 {"step":"voter onboarding","from":$B_VOTERS,"to":$((B_CEREMONY - 1))},
 {"step":"ceremony (parallel acceptance)","from":$B_CEREMONY,"to":$((B_POST - 1))},
 {"step":"post-ceremony votes","from":$B_POST,"to":$B_END}]
STEPS
COST_RPC_URL=$NODE_URL node scripts/production/costTable.js measure "$OUT/steps.json" "$OUT/wallets.txt" \
  "$HANDOVER_CONFIG" >"$OUT/gas-deploy.json" || fail "cost measure failed"
node scripts/production/costTable.js table --gwei "${COST_GWEI:-20}" "$OUT/gas-deploy.json" \
  | tee "$OUT/cost.txt"
grep -qE "^    deployer +[0-9]+ gas" "$OUT/cost.txt" || fail "no deployer row in the cost table"
echo "9. cost table: $OUT/cost.txt (gas in $OUT/gas-deploy.json)"
echo "deploy drive PASS in $((SECONDS - START))s (logs $OUT)"
