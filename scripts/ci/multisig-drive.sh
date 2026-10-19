#!/usr/bin/env bash
#
# Multisig ops and issuer admin drive (plan v2 Task 5.13, Q11 = B): the
# production deploy and the ceremony with ops and the issuer admin as
# 2-of-2 multisig contracts (contracts/test/mocks/TestMultisig.sol, the
# test stand-in for a Safe) on a local node. Keys live only in the remote
# signer (scripts/ci/remote-signer.js); the owners act from a process of
# their own (scripts/ci/multisig-exec.js). Exit code 3 is "paused for role
# transactions", never success: every pause is asserted by its code.
#   1. deploy: pauses at custody (exit 3, one ops transaction); a re-run
#      before execution pauses again and sends nothing
#   2. the owners execute the batch; the deploy resumes to its preflight;
#      a re-run replays across the pause and sends nothing
#   3. ceremony full phase: pauses after the snapshot (exit 3, 2 ops and
#      4 issuer-admin transactions) before any vote; the accept phase and a
#      full re-run before execution send nothing (exit 3, exit 1)
#   4. the owners execute; the accept phase proves every effect, votes,
#      and completes with exactly the R-57-8 set; governance owns the plan
#      contracts, the ops multisig both list oracles (the unbound
#      whitelist oracle too, Task 5.14) and custody, the admin multisig
#      both issuers
#   5. claim signers (Task 5.15, Q17 = A): the admin multisig's batch adds
#      a KYC and a separate AML EOA key; their claims verify; the day-2
#      audit passes once handover.json lists them
#   6. the cost table from steps 1-5's blocks (Q19 = A)
#
# USAGE  scripts/ci/multisig-drive.sh   (nodes on MULTISIG_NODE_PORT 8547
#        and MULTISIG_SIGNER_PORT 8549; exit 1 on failure)

set -euo pipefail
cd "$(dirname "$0")/../.."
NODE_PORT=${MULTISIG_NODE_PORT:-8547}
SIGNER_PORT=${MULTISIG_SIGNER_PORT:-8549}
NODE_URL=http://127.0.0.1:$NODE_PORT
OUT=$(mktemp -d "${TMPDIR:-/tmp}/multisig-drive.XXXXXX")
ROLES="test test test test test test test test test test test junk"
NODE_PHRASE="candy maple cake sugar pudding cream honey rich smooth crumble sweet treat"
START=$SECONDS
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -- "-$p" 2>/dev/null || true; done
}
trap cleanup EXIT
fail() {
  echo "::error::multisig drive: $1"
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
  for (let i = 0; i < 16; i++) console.log(HDNodeWallet.fromMnemonic(m, `m/44'"'"'/60'"'"'/0'"'"'/0/${i}`).address);')
for a in $WALLETS; do
  rpc "$NODE_URL" hardhat_setBalance "[\"$a\",\"0x21E19E0C9BAB2400000\"]" >/dev/null
done
DEPLOYER=$(echo "$WALLETS" | head -1)
MNEMONIC="$ROLES" SIGNER_COUNT=16 SIGNER_UPSTREAM=$NODE_URL setsid node \
  scripts/ci/remote-signer.js "$SIGNER_PORT" >"$OUT/signer.log" 2>&1 &
PIDS+=($!)
sup
unset MNEMONIC PRIVATE_KEY
export SIGNER_RPC_URL=http://127.0.0.1:$SIGNER_PORT DEPLOY_RECORD=$OUT/31337.json \
  HANDOVER_CONFIG=$OUT/handover.json
hh() { npx hardhat run "$@" --network remote; }
# rc LOG CMD...: run CMD with its output in $OUT/LOG; print its exit code.
rc() { local l=$1; shift; set +e; "$@" >"$OUT/$l" 2>&1; echo $?; set -e; }
txs() { node -e 'try { console.log(require(process.argv[1]).txs.length) } catch { console.log(0) }' "$DEPLOY_RECORD"; }
nonce() { rpc "$NODE_URL" eth_getTransactionCount "[\"$DEPLOYER\",\"latest\"]" | sed -E 's/.*"result":"([^"]+)".*/\1/'; }
block() { rpc "$NODE_URL" eth_blockNumber "[]" | sed -E 's/.*"result":"([^"]+)".*/\1/'; }
recorded() { node -e 'const r = require(process.argv[1]); console.log(r.txs.filter((t) => t.from.toLowerCase() === process.argv[2].toLowerCase()).length)' "$DEPLOY_RECORD" "$DEPLOYER"; }
owner() { node -e 'const { JsonRpcProvider, Contract } = require("ethers");
  new Contract(process.argv[1], ["function owner() view returns (address)"], new JsonRpcProvider(process.argv[2]))
    .owner().then((o) => console.log(o.toLowerCase()));' "$1" "$NODE_URL"; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
execute() { BATCH=$1 MULTISIG_OWNERS=$2 hh scripts/ci/multisig-exec.js >"$OUT/$3" 2>&1 \
  || fail "the owners could not execute $1"; grep -q "^executed $4 calls" "$OUT/$3" || fail "$1: not $4 calls"; }

# ops: wallets 10 and 12; issuer admin: wallets 9 and 13 (2-of-2 each).
OPS=$(MULTISIG_OWNERS=10,12 hh scripts/ci/multisig-exec.js | sed -n 's/^multisig //p')
ADMIN=$(MULTISIG_OWNERS=9,13 hh scripts/ci/multisig-exec.js | sed -n 's/^multisig //p')
[[ -n $OPS && -n $ADMIN ]] || fail "multisigs not deployed"
node -e 'require("./scripts/zk/attest").attestorPublicKey("0x" + "11".repeat(32))
  .then((k) => console.log(JSON.stringify({ attestor: { Ax: String(k.Ax), Ay: String(k.Ay) },
    ops: process.argv[1], issuerAdmin: process.argv[2] })))' "$OPS" "$ADMIN" >"$OUT/deploy.json"
export DEPLOY_CONFIG=$OUT/deploy.json
echo "0. ops multisig $OPS, issuer admin multisig $ADMIN (2-of-2 TestMultisig)"

B_DEPLOY=$(($(block) + 1))
# 1. The deploy pauses at custody; a re-run before execution sends nothing.
OPS_FILE=$OUT/31337.ops-transactions.json
[[ $(rc deploy1.log hh scripts/production/DeployProduction.ts) -eq 3 ]] || fail "deploy: no pause (exit 3)"
grep -qF "⏸️  awaiting 1 ops transaction: $OPS_FILE" "$OUT/deploy1.log" || fail "no awaiting line"
grep -q "Preflight passed" "$OUT/deploy1.log" && fail "the deploy ran past the pause"
for r in "ops $OPS" "issuerAdmin $ADMIN"; do  # review LOW-5: owners read, no deployer
  grep -qF "ℹ️  $r is a 2-of-2 multisig; the deployer is no listed owner" "$OUT/deploy1.log" || fail "$r: owners not checked"
done
PAUSED=$(txs) N0=$(($(nonce)))
[[ $N0 -eq $(recorded) && $(recorded) -eq $PAUSED ]] || fail "nonce $N0, record $PAUSED: not the deployer's alone"
[[ $(rc deploy1b.log hh scripts/production/DeployProduction.ts) -eq 3 ]] || fail "re-run: no pause"
grep -q "❌ not executed: \[deploy.custody.accept\]" "$OUT/deploy1b.log" || fail "re-run: call not named"
[[ $(txs) -eq $PAUSED && $(($(nonce))) -eq $N0 ]] || fail "the paused re-run sent"
echo "1. deploy paused at custody ($PAUSED recorded, all the deployer's); a re-run paused again, sending nothing"

# 2. Execute, resume, re-run.
execute "$OPS_FILE" 10,12 exec1.log 1
[[ $(rc deploy2.log hh scripts/production/DeployProduction.ts) -eq 0 ]] || fail "the resumed deploy failed"
grep -q "✅ 1 role transaction effect(s) hold on chain" "$OUT/deploy2.log" || fail "no effect check"
grep -qE "^✅ Preflight passed" "$OUT/deploy2.log" || fail "no preflight pass"
[[ $(($(nonce))) -eq $(recorded) && $(recorded) -eq $(txs) ]] || fail "deployer nonce != record"
[[ $(rc deploy3.log hh scripts/production/DeployProduction.ts) -eq 0 ]] || fail "the re-run failed"
grep -qE "\(([0-9]+) from the record, 0 sent now;" "$OUT/deploy3.log" || fail "the re-run sent"
CUSTODY=$(node -e 'console.log(require(process.argv[1]).contracts.investorRequestManager)' "$DEPLOY_RECORD")
[[ $(owner "$CUSTODY") == $(lc "$OPS") ]] || fail "custody not owned by the ops multisig"
echo "2. executed by the owners; resumed ($(grep -oE '[0-9]+ sent now' "$OUT/deploy2.log")); re-run: $(grep -oE '[0-9]+ from the record, 0 sent now' "$OUT/deploy3.log")"

B_CEREMONY=$(($(block) + 1))
# 3. Ceremony: full phase pauses before any vote; nothing sends until executed.
hh scripts/ci/deploy-voters.js >"$OUT/voters.log" 2>&1 || fail "voter registration failed"
C_OPS=$HANDOVER_CONFIG.ops-transactions.json C_ADMIN=$HANDOVER_CONFIG.issuer-admin-transactions.json
[[ $(rc ceremony1.log hh scripts/handover.ts) -eq 3 ]] || fail "ceremony: no pause (exit 3)"
grep -qF "⏸️  awaiting 2 ops transactions: $C_OPS" "$OUT/ceremony1.log" || fail "no ops awaiting line"
grep -qF "⏸️  awaiting 4 issuerAdmin transactions: $C_ADMIN" "$OUT/ceremony1.log" || fail "no admin awaiting line"
grep -q "governance accepts by vote" "$OUT/ceremony1.log" && fail "a vote ran before the pause"
export HANDOVER_SNAPSHOT_SHA256=$(sed -n 's/.*snapshot sha256: \([0-9a-f]\{64\}\).*/\1/p' "$OUT/ceremony1.log" | head -1)
B0=$(($(block)))
[[ $(HANDOVER_PHASE=accept rc ceremony2.log hh scripts/handover.ts) -eq 3 ]] || fail "accept before execution: no exit 3"
[[ $(grep -c "❌ not executed: \[handover\." "$OUT/ceremony2.log") -eq 6 ]] || fail "accept: the 6 calls not named"
[[ $(rc ceremony3.log hh scripts/handover.ts) -eq 1 ]] || fail "a full re-run was not refused"
grep -q "a full re-run would send them again" "$OUT/ceremony3.log" || fail "no full re-run refusal"
[[ $(($(block))) -eq $B0 ]] || fail "a paused ceremony re-run sent a transaction"
echo "3. ceremony paused after the snapshot (2 ops, 4 issuer-admin calls); accept and full re-runs sent nothing"

# 4. Execute both batches; the accept phase completes.
execute "$C_OPS" 10,12 exec2.log 2
execute "$C_ADMIN" 9,13 exec3.log 4
[[ $(HANDOVER_PHASE=accept rc ceremony4.log hh scripts/handover.ts) -eq 0 ]] || fail "the accept phase failed"
grep -q "✅ 6 role transaction effect(s) hold on chain" "$OUT/ceremony4.log" || fail "no effect check"
V=$(sed -n '/Handover: verify/,$p' "$OUT/ceremony4.log")
grep -q "❌" <<<"$V" && fail "a failed completion check"
count() { grep -cE "$1" <<<"$V" || true; }
[[ $(count '^\s+⚠️') -eq 7 ]] || fail "$(count '^\s+⚠️') warnings, not 7"
[[ $(count '^\s+⚠️  PrivacyManager issuer key .* was trusted by the deployer') -eq 3 ]] || fail "issuer-key warnings"
[[ $(count '^\s+⚠️  OracleManager node .* was registered by the deployer') -eq 3 ]] || fail "D50 node warnings"
FEE=$(node -e 'console.log(require(process.argv[1]).feeWallets[0])' "$HANDOVER_CONFIG")
[[ $(count "^\s+⚠️  $FEE is investorLimitExempt \(set before the handover\)") -eq 1 ]] || fail "no exempt fee wallet line"
[[ $(count '^⚠️  Handover complete with warnings: see above\.$') -eq 1 ]] || fail "no closing banner"
[[ $(count '^\s+✅ the deployer owns no list oracle serving OracleManager') -eq 1 ]] || fail "no list-oracle line"
GOV=$(lc "$(node -e 'console.log(require(process.argv[1]).governance)' "$HANDOVER_CONFIG")")
C() { node -e 'console.log(require(process.argv[1]).contracts[process.argv[2]])' "$DEPLOY_RECORD" "$1"; }
for k in digitalToken governanceToken identityRegistry complianceRules oracleManager \
  investorTypeRegistry escrowFactory onchainIDFactory privacyManager zkVerifierIntegrated; do
  [[ $(owner "$(C $k)") == "$GOV" ]] || fail "$k is not governance's"
done
for k in whitelistOracle blacklistOracle investorRequestManager; do
  [[ $(owner "$(C $k)") == $(lc "$OPS") ]] || fail "$k is not the ops multisig's"
done
for k in kycIssuer amlIssuer; do
  [[ $(owner "$(C $k)") == $(lc "$ADMIN") ]] || fail "$k is not the admin multisig's"
done
echo "4. executed; ceremony complete: 3 issuer keys, 3 D50 nodes, exempt fee wallet, banner; governance owns 10 plan contracts, ops multisig both list oracles and custody, admin multisig both issuers"

B_SIGNERS=$(($(block) + 1))
# 5. Claim signers (Q17 = A, M-2): the admin multisig's batch adds a KYC
#    and a separate AML EOA CLAIM_SIGNER key (wallets 14, 15); exit 3 until
#    its owners execute it; then each key's claim verifies; the day-2
#    audit fails until handover.json lists them, then passes.
KYC=$(echo "$WALLETS" | sed -n 15p) AML=$(echo "$WALLETS" | sed -n 16p)
export CLAIM_SIGNERS="kyc:$KYC,aml:$AML"
CS_FILE=$HANDOVER_CONFIG.claim-signers.issuer-admin-transactions.json
[[ $(rc signers1.log hh scripts/production/claimSigners.ts) -eq 3 ]] || fail "claim signers: no pause (exit 3)"
grep -qF "⏸️  awaiting 2 issuerAdmin transactions: $CS_FILE" "$OUT/signers1.log" || fail "no claim-signer batch"
execute "$CS_FILE" 9,13 exec4.log 2
[[ $(rc signers2.log hh scripts/production/claimSigners.ts) -eq 0 ]] || fail "claim signers: the re-run failed"
grep -q "✅ 2 role transaction effect(s) hold on chain" "$OUT/signers2.log" || fail "claim signers: no effect check"
[[ $(grep -c "✅ a claim signed by 0x[0-9a-fA-F]* verifies on" "$OUT/signers2.log") -eq 2 ]] || fail "claim signers: no verified claim"
[[ $(HANDOVER_PHASE=audit rc audit1.log hh scripts/handover.ts) -eq 1 ]] || fail "the audit passed unlisted claim signers"
grep -qE "❌ .*every live key is issuerAdmin's" "$OUT/audit1.log" || fail "no unlisted-key line"
node -e 'const fs = require("fs"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f));
  c.claimSigners = process.argv.slice(2); fs.writeFileSync(f, JSON.stringify(c, null, 2));' "$HANDOVER_CONFIG" "$KYC" "$AML"
[[ $(HANDOVER_PHASE=audit rc audit2.log hh scripts/handover.ts) -eq 0 ]] || fail "the audit failed with the claim signers listed"
[[ $(grep -c "✅ claimSigners 0x[0-9a-fA-F]*: a CLAIM_SIGNER key the issuer admin added after the ceremony" "$OUT/audit2.log") -eq 2 ]] \
  || fail "the audit did not name both claim signers"
echo "5. claim signers: the admin multisig's batch (2 calls) executed; both keys' claims verify; the audit failed unlisted, passed listed"

# 6. Cost table (Q19 = A): the multisig deploy, the ceremony with its
#    Safe batches (the owners' wallets 9, 10, 12, 13 pay), the claim-signer
#    batch; at COST_GWEI (20) with 50% headroom.
echo "$WALLETS" >"$OUT/wallets.txt"
cat >"$OUT/steps.json" <<STEPS
[{"step":"deploy (multisig custody batch)","from":$B_DEPLOY,"to":$((B_CEREMONY - 1))},
 {"step":"voters + ceremony + Safe batches","from":$B_CEREMONY,"to":$((B_SIGNERS - 1))},
 {"step":"claim-signer Safe batch","from":$B_SIGNERS,"to":$(($(block)))}]
STEPS
COST_RPC_URL=$NODE_URL node scripts/production/costTable.js measure "$OUT/steps.json" "$OUT/wallets.txt" \
  "$HANDOVER_CONFIG" >"$OUT/gas-multisig.json" || fail "cost measure failed"
node scripts/production/costTable.js table --gwei "${COST_GWEI:-20}" "$OUT/gas-multisig.json" \
  | tee "$OUT/cost.txt"
grep -qE "^    wallet (9|13) +[0-9]+ gas" "$OUT/cost.txt" || fail "no issuer-admin owner row in the cost table"
echo "6. cost table: $OUT/cost.txt"
echo "multisig drive PASS in $((SECONDS - START))s (logs $OUT)"
