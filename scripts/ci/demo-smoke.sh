#!/usr/bin/env bash
#
# Demo deployment smoke test. The demo wires contracts together the way
# an operator would, a path the unit tests do not cover. It cannot run
# interactively in CI (readline over a non-TTY pipe closes before the
# first prompt), so scripts/demo-smoke.js drives the same
# ContractDeployer directly against a local node and reads the wiring
# back from chain; it exits non-zero on any mismatch and writes the
# deployment to DEMO_SMOKE_OUT for the whitelist CLI step.
#
# Starts a hardhat node on DEMO_RPC_URL's port and LEAVES IT RUNNING:
# the whitelist CLI step, the strict drive and the regression drives use
# it after this script exits (CI's demo job; its log path is
# printed). The smoke runs --network devnode, the
# hardhat.config.ts network DEMO_RPC_URL defines.
#
# USAGE  DEMO_RPC_URL=http://127.0.0.1:8545 DEMO_SMOKE_OUT=/tmp/o.json \
#          scripts/ci/demo-smoke.sh

set -euo pipefail
: "${DEMO_RPC_URL:?set DEMO_RPC_URL, e.g. http://127.0.0.1:8545}"
: "${DEMO_SMOKE_OUT:?set DEMO_SMOKE_OUT, e.g. /tmp/demo-smoke-out.json}"
cd "$(dirname "$0")/../.."
PORT="${DEMO_RPC_URL##*:}"
PORT="${PORT%%/*}"
NODE_LOG=$(mktemp "${TMPDIR:-/tmp}/hardhat-node.XXXXXX")

npx hardhat node --port "$PORT" > "$NODE_LOG" 2>&1 &
echo "hardhat node pid $! on port $PORT (log $NODE_LOG)"
up=0
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -m 1 -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$DEMO_RPC_URL"; then
    up=1
    break
  fi
  sleep 1
done
[ "$up" -eq 1 ] || { echo "::error::no node at $DEMO_RPC_URL after 30 s"; tail -20 "$NODE_LOG"; exit 1; }
npx hardhat run scripts/demo-smoke.js --network devnode
