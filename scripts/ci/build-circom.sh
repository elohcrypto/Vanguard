#!/usr/bin/env bash
#
# Build the Rust circom compiler at $CIRCOM_VERSION into ~/.cargo/bin
# (CI's compile job, on a circom cache miss). The circuits declare
# `pragma circom 2.0.0`; only the Rust compiler builds them. The
# `circom` npm package is the deprecated 0.5.x JS build.
#
# USAGE  CIRCOM_VERSION=v2.2.3 scripts/ci/build-circom.sh

set -euo pipefail
: "${CIRCOM_VERSION:?set CIRCOM_VERSION, e.g. v2.2.3}"
SRC="$(mktemp -d)/circom"
git clone --depth 1 --branch "$CIRCOM_VERSION" https://github.com/iden3/circom.git "$SRC"
cargo build --release --manifest-path "$SRC/Cargo.toml"
mkdir -p ~/.cargo/bin
cp "$SRC/target/release/circom" ~/.cargo/bin/circom
