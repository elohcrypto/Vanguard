#!/usr/bin/env bash
#
# Whitelist root + proof CLI (plan v2 Task 3.5): the operator and
# investor CLIs (scripts/zk/) against the smoke's node, still running,
# after its handover. Three verified wallets onboard (identity =
# OnchainID address, own secret), ops (wallet 10, the listOperator)
# builds and publishes the root, wallet 2 proves and binds. VSC is in
# whitelist mode Either with no oracle, so ComplianceRules.canReceive
# (wallet 2), called as VSC, follows the binding: false before, true
# after. No secret may appear in the prover's output. Hardhat's
# default keys.
#
# USAGE  DEMO_RPC_URL=... DEMO_SMOKE_OUT=... scripts/ci/whitelist-cli.sh
#        (after scripts/ci/demo-smoke.sh; exit 1 on a finding)

set -euo pipefail
: "${DEMO_RPC_URL:?set DEMO_RPC_URL}"
: "${DEMO_SMOKE_OUT:?set DEMO_SMOKE_OUT}"
cd "$(dirname "$0")/../.."
OUT=$DEMO_SMOKE_OUT
RPC=$DEMO_RPC_URL
D=$(mktemp -d)
key() { node -e 'const { ethers } = require("ethers"); console.log(ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, ethers.getIndexedAccountPath(+process.argv[1])).privateKey)' "$1"; }
user() { jq -r ".users[] | select(.index == $1) | .$2" "$OUT"; }
PM=$(jq -r .privacyManager "$OUT")
RULES=$(jq -r .complianceRules "$OUT")
VSC=$(jq -r .token "$OUT")
echo '[]' > "$D/entries.json"
for i in 1 2 3; do
  (umask 077; echo "0x$(openssl rand -hex 31)" > "$D/secret-$i")
  c=$(node scripts/zk/prove-whitelist.js --commitment --identity "$(user $i onchainID)" --secret-file "$D/secret-$i")
  jq --arg id "$(user $i onchainID)" --arg c "$c" '. + [{identity: $id, commitment: $c}]' "$D/entries.json" > "$D/e" && mv "$D/e" "$D/entries.json"
done
ZK_RPC_URL=$RPC WHITELIST_OPS_KEY=$(key 10) node scripts/zk/build-whitelist-root.js \
  --in "$D/entries.json" --out "$D/root.json" --publish --privacy-manager "$PM"
USER=$(user 2 wallet)
gate() { node -e '
  const { ethers } = require("ethers");
  const [rpc, pm, rules, vsc, who] = process.argv.slice(1);
  const p = new ethers.JsonRpcProvider(rpc);
  const i = new ethers.Interface(["function hasValidWhitelistProof(address) view returns (bool)", "function canReceive(address) view returns (bool)"]);
  const call = async (to, f, from) => i.decodeFunctionResult(f, await p.call({ to, from, data: i.encodeFunctionData(f, [who]) }))[0];
  (async () => console.log(`${await call(pm, "hasValidWhitelistProof")} ${await call(rules, "canReceive", vsc)}`))()
    .catch((e) => { console.error(e.message); process.exit(1); });' "$RPC" "$PM" "$RULES" "$VSC" "$USER"; }
before=$(gate); echo "before: hasValidWhitelistProof canReceive = $before"
ZK_RPC_URL=$RPC WHITELIST_SECRET=$(cat "$D/secret-2") WHITELIST_WALLET_KEY=$(key 2) node scripts/zk/prove-whitelist.js \
  --root "$D/root.json" --identity "$(user 2 onchainID)" --wallet "$USER" --out "$D/proof.json" \
  --submit --privacy-manager "$PM" > "$D/stdout" 2> "$D/stderr"
cat "$D/stderr"
after=$(gate); echo "after:  hasValidWhitelistProof canReceive = $after"
for i in 1 2 3; do
  hex=$(sed 's/^0x//' "$D/secret-$i")
  dec=$(node -e 'console.log(BigInt(process.argv[1]).toString())' "0x$hex")
  for f in "$D/stdout" "$D/stderr"; do
    if grep -qiF -e "$hex" -e "$dec" "$f"; then echo "::error::the prover printed secret $i"; exit 1; fi
  done
done
if [ "$before" != "false false" ] || [ "$after" != "true true" ]; then
  echo "::error::expected 'false false' before and 'true true' after the binding"
  exit 1
fi
echo "whitelist CLI: binding flips hasValidWhitelistProof and canReceive"
