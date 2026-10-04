# ZK Circuits: Build, Check and Use

What the five circuits are, how to build and check them, what each proof
does on chain, and what it does not. For the operator and investor command
lines see [TESTNET_DEMO.md](TESTNET_DEMO.md) ("Whitelist roots and proofs
from the command line" and the privacy sections after it); for the build
itself see [ZK_CIRCUIT_BUILD_GUIDE.md](ZK_CIRCUIT_BUILD_GUIDE.md).

Status: the circuits, verifiers and consumers are implemented and tested
in CI. Nothing here has had a third-party audit.

## Build and check

The `.wasm`, `.zkey` and `.r1cs` files are gitignored build output; the
Solidity verifiers under `contracts/privacy/verifiers/` are committed.

```bash
# Requires the Rust circom 2.x compiler (the `circom` npm package is the
# deprecated 0.5.x build); see ZK_CIRCUIT_BUILD_GUIDE.md
npm run setup:zk    # compile, PLONK setup, export the five verifiers
npm run verify:zk   # check the artifacts against the committed verifiers
```

`setup:zk` uses the Hermez universal ceremony file
`powersOfTau28_hez_final_15.ptau` (2^15), checked against its published
BLAKE2b-512 hash whether downloaded or cached. PLONK needs no per-circuit
secret, and the setup is deterministic: CI runs `setup:zk` and fails if the
regenerated verifiers differ from the committed ones.

`verify:zk` checks, per circuit: the WASM is real, the zkey and vkey exist,
the vkey is PLONK with the expected public-signal count, and every
constant the committed verifier deploys (n, nPublic, k1, k2, w1, Qm, Ql,
Qr, Qo, Qc, S1, S2, S3, X2) equals the vkey's. It exits 1 on any
mismatch. It does not compare the vkey with the zkey, and it does not
check the consumer's logic; the recompile tests and the CI verifier diff
cover the first, the test suite the second.

## Circuit inventory

Numbers from `npm run verify:zk` and `snarkjs r1cs info` on the current
tree.

| Circuit | Public signals (snarkjs order) | nPublic | Constraints | PLONK domain | WASM | zkey |
|---|---|---|---|---|---|---|
| whitelist_membership | nullifier, merkleRoot, walletBinding | 3 | 11,455 | 2^14 | 1.7 MB | 29 MB |
| blacklist_membership | nullifier, whitelistRoot, blacklistRoot, walletBinding | 4 | 24,394 | 2^15 | 2.2 MB | 64 MB |
| jurisdiction_proof | nullifier, Ax, Ay, chainId, verifierContext, allowedMask, walletBinding | 7 | 9,770 | 2^15 | 3.4 MB | 80 MB |
| accreditation_proof | nullifier, Ax, Ay, chainId, verifierContext, minimumAccreditation, walletBinding | 7 | 9,773 | 2^15 | 3.4 MB | 80 MB |
| compliance_aggregation | nullifier, Ax, Ay, chainId, verifierContext, minimum, wK, wA, wJ, wAcc, walletBinding | 11 | 10,837 | 2^15 | 3.7 MB | 101 MB |

A proof takes seconds to generate (the attestation soundness tests take
about 9 s per real proof). A PLONK verification through the wrapper costs
roughly 0.4M gas.

## What each proof does on chain

- **Whitelist** (the only proof that gates transfers). The leaf is the
  investor's commitment `Poseidon(identity, secret)`; the operator (ops,
  the `listOperator`) publishes the root on `PrivacyManager`.
  `submitWhitelistProof` requires the current root, `walletBinding ==
  msg.sender`, and one wallet per nullifier `Poseidon(secret, root)` per
  root version. `ComplianceRules` reads `hasValidWhitelistProof(wallet)`
  when a token's whitelist mode is ZkOnly or Either (OracleOnly ignores
  it). Publishing a new root lapses every binding until its holder proves
  again.
- **Blacklist**: the holder of a whitelist commitment proves its identity
  is not in the sanctions tree. It gates nothing; sanctions on transfers
  are enforced by the blacklist oracle.
- **Jurisdiction, accreditation, compliance**: a trusted issuer signs the
  investor's attributes with an EdDSA Baby Jubjub key, for one chain and
  one PrivacyManager; the proof shows the signature and that the
  attributes meet PrivacyManager's policy. The jurisdiction policy is the
  set of countries `ComplianceRules` allows for VSC (one source, Task 3.8).
  The records are read by the `validatePrivate*` views, which nothing on
  the transfer path calls.

What stays private: which listed identity a whitelist proof belongs to
(the list cannot be enumerated from public identity data), and the
attested attributes. What does not: the prover's wallet, which ERC-3643
transfers name and every proof binds.

## The wrapper and testingMode

`ZKVerifierIntegrated` routes each circuit to its verifier, refuses any
signal at or above the scalar field, and caches results per verifier.
Its `testingMode` is fixed at deploy and exists for unit tests only: in
it, any non-zero signals pass. `PrivacyManager` refuses a testingMode
wrapper (constructor and `setZKVerifier`), the handover ceremony refuses
one, and the demo deploys `ZKVerifierIntegrated(false)`. There is no
supported "mock deployment".

## Soundness history

- 2026-09-23: the original Groth16 circuits were found unsound (private
  roots, a soft Merkle check, no wallet binding) and the Groth16 keys had
  no phase-2 contribution, so proofs were forgeable.
- Tasks 3.1 to 3.3: whitelist circuit rebuilt (commitment leaves, hard
  inclusion, binary path bits, wallet binding) and bound by PrivacyManager.
- Task 3.7: all five circuits on PLONK; blacklist tied to the whitelist
  commitment; jurisdiction, accreditation and compliance on issuer-signed
  attestations.
- Task 3.8: attestations bound to chain id and PrivacyManager; the
  jurisdiction set read from ComplianceRules.

The soundness tests (`test/privacy/ZKSoundness.test.js`,
`BlacklistSoundness.test.js` and the three `*AttestationSoundness` suites)
run on real proofs in CI.
