#!/usr/bin/env bash
#
# Build the five circuits and prove they are the real ones (every CI job
# that proves or deploys runs this; ~30 s, cheaper than shipping the
# ~400 MB of zkeys between jobs). `plonk setup` is deterministic, so
# every job builds the same keys and the committed verifiers match.
#
#   1. circom is the Rust 2.x compiler (~/.cargo/bin/circom).
#   2. setup:zk builds build/circuits/. CIRCOM_BIN pins the real
#      compiler ($HOME, not runner-specific), so no other circom on
#      PATH (the npm 0.5.x shim, a dependency until Task 5.11) is used.
#      The Powers of Tau file (37.8 MB, from this repo's releases because
#      every public mirror 403s) is verified by BLAKE2b-512 whether cached
#      or fresh.
#   3. Regression guard for the silent-mock bug: setup:zk once wrote
#      placeholder files and overwrote the committed verifiers while
#      exiting 0. Every wasm must be WebAssembly and the verifiers under
#      contracts/privacy/verifiers/ must be unchanged.
#   4. verify:zk (R-3R-9): every circuit is sound PLONK since Task 3.7b,
#      so the readiness check exits 0 and gates (exit 2 = unsound setup).
#
# USAGE  scripts/ci/zk-circuits.sh   (exit 1 on any failure)

set -euo pipefail
cd "$(dirname "$0")/../.."
CIRCOM="$HOME/.cargo/bin/circom"

echo "::group::circom is 2.x"
"$CIRCOM" --version
"$CIRCOM" --version | grep -qE '\b2\.[0-9]+\.[0-9]+' \
  || { echo "::error::circom is not 2.x"; exit 1; }
echo "::endgroup::"

echo "::group::setup:zk"
CIRCOM_BIN="$CIRCOM" npm run setup:zk
echo "::endgroup::"

fail=0
shopt -s nullglob
wasms=(build/circuits/*/*_js/*.wasm)
[ "${#wasms[@]}" -eq 5 ] \
  || { echo "::error::expected 5 circuit wasm files, found ${#wasms[@]}"; fail=1; }
for wasm in "${wasms[@]}"; do
  magic=$(xxd -p -l4 "$wasm")
  if [ "$magic" != "0061736d" ]; then
    echo "::error::$wasm is not WebAssembly (magic $magic; 'mock' is 6d6f636b)"
    fail=1
  fi
done
if ! git diff --quiet contracts/privacy/verifiers/; then
  echo "::error::setup:zk modified committed verifier contracts"
  git diff --stat contracts/privacy/verifiers/
  fail=1
fi
[ "$fail" -eq 0 ] || exit 1
echo "ZK artifacts are real WebAssembly; committed verifiers unchanged"

npm run verify:zk
