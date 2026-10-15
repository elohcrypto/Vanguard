#!/usr/bin/env bash
#
# Production deploy drive (plan v2 Task 5.7, D48 a): the deploy CLI
# (scripts/production/DeployProduction.ts) against a local node through a
# SECOND process that holds every key (scripts/ci/remote-signer.js); the
# deploy process has none. The node runs on another mnemonic and funds
# the role wallets by hardhat_setBalance, so it cannot sign for them
# either (checked). In order:
#   1. deploy, killed (SIGKILL) once the record holds KILL_AT transactions
#   2. resume: the record is replayed (code hashes checked), the rest sent,
#      handover.json written and its preflight passed; the deployer's
#      nonce equals the record's count (nothing sent twice)
#   3. a tampered code hash in the record: refused, nothing sent
#   4. a re-run of the complete deploy sends nothing
#   5. voters registered (scripts/ci/deploy-voters.js), then the ceremony
#      (scripts/handover.ts) completes with exactly the residual set:
#      3 deployer-trusted PrivacyManager issuer keys, 3 deployer-era nodes
#      (D50), the null escrow factory (R-413-12), and the banner
#
# USAGE  scripts/ci/deploy-drive.sh   (nodes on DEPLOY_NODE_PORT 8547 and
#        DEPLOY_SIGNER_PORT 8549; exit 1 on failure)

set -euo pipefail
cd "$(dirname "$0")/../.."
NODE_PORT=${DEPLOY_NODE_PORT:-8547}
SIGNER_PORT=${DEPLOY_SIGNER_PORT:-8549}
KILL_AT=${KILL_AT:-30}
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
MNEMONIC="$ROLES" SIGNER_UPSTREAM=$NODE_URL setsid node scripts/ci/remote-signer.js \
  "$SIGNER_PORT" >"$OUT/signer.log" 2>&1 &
PIDS+=($!)
up "http://127.0.0.1:$SIGNER_PORT"

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

# 1. Deploy, killed mid-way.
setsid npx hardhat run scripts/production/DeployProduction.ts --network remote \
  >"$OUT/deploy1.log" 2>&1 &
D=$!
for _ in $(seq 1 1200); do [[ $(txs) -ge $KILL_AT ]] && break; sleep 0.2; done
kill -9 -- "-$D"
wait "$D" 2>/dev/null || true
KILLED=$(txs)
[[ $KILLED -ge $KILL_AT ]] || fail "the deploy recorded $KILLED transactions, not $KILL_AT"
grep -q "Preflight passed" "$OUT/deploy1.log" && fail "the deploy finished before the kill"
echo "1. killed with $KILLED transactions recorded"

# 2. Resume.
deploy >"$OUT/deploy2.log" 2>&1 || fail "the resumed deploy failed"
SKIPPED=$(grep -c "skipped (recorded" "$OUT/deploy2.log" || true)
[[ $SKIPPED -ge $((KILLED - 1)) ]] || fail "resume replayed $SKIPPED of $KILLED"
grep -q "match the chain (code hashes)" "$OUT/deploy2.log" || fail "no record check"
grep -qE "^✅ Preflight passed" "$OUT/deploy2.log" || fail "no preflight pass"
[[ $(($(nonce))) -eq $(recorded) ]] \
  || fail "deployer nonce $(($(nonce))) != $(recorded) recorded: a send outside the record"
echo "2. resumed: $SKIPPED replayed, $(grep -oE '[0-9]+ sent now' "$OUT/deploy2.log"); deployer nonce $(($(nonce))) = record"

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

# 5. Voters, then the ceremony on this deploy.
npx hardhat run scripts/ci/deploy-voters.js --network remote >"$OUT/voters.log" 2>&1 \
  || fail "voter registration failed"
npx hardhat run scripts/handover.ts --network remote >"$OUT/ceremony.log" 2>&1 \
  || fail "the ceremony failed"
V=$(sed -n '/Handover: verify/,$p' "$OUT/ceremony.log")
grep -q "❌" <<<"$V" && fail "a failed completion check"
count() { grep -cE "$1" <<<"$V" || true; }
[[ $(count '^\s+⚠️') -eq 7 ]] || fail "$(count '^\s+⚠️') warnings, not 7"
[[ $(count '^\s+⚠️  PrivacyManager issuer key .* was trusted by the deployer') -eq 3 ]] || fail "issuer-key warnings"
[[ $(count '^\s+⚠️  OracleManager node .* was registered by the deployer') -eq 3 ]] || fail "D50 node warnings"
[[ $(count '^\s+⚠️  config "escrowWalletFactory" is null') -eq 1 ]] || fail "escrow null warning"
[[ $(count '^⚠️  Handover complete with warnings: see above\.$') -eq 1 ]] || fail "no closing banner"
echo "5. ceremony complete: 3 issuer keys, 3 D50 nodes, null escrow factory, banner"
echo "deploy drive PASS in $((SECONDS - START))s (logs $OUT)"
