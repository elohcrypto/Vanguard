# Technical Deep Dive: zero-knowledge circuits

The technical deep dive is three files: [transfer path](DEEP_DIVE_TRANSFER.md) (token, compliance, oracles), [identity, recovery and governance](DEEP_DIVE_IDENTITY.md) and [zero-knowledge circuits](DEEP_DIVE_ZK.md).

---

## 🎭 Zero-Knowledge Circuit Analysis

### 1. Whitelist Membership Circuit

`circuits/whitelist_membership.circom` (PLONK, Tasks 3.1 and 3.3).
Statement: the commitment `Poseidon(identity, secret)` is a leaf of the
whitelist tree under the public root, for this wallet.

**Circuit Logic (every check a hard constraint, no validity output):**

```circom
template WhitelistMembership(levels) {
    // Private inputs
    signal input identity;              // the investor's OnchainID address
    signal input secret;                // chosen by the investor; the prover
                                        // script (scripts/zk/prove-whitelist.js)
                                        // refuses one below 2^128, the
                                        // circuit does not constrain its size
    signal input pathElements[levels];
    signal input pathIndices[levels];   // constrained binary in MerkleInclusion

    // Public inputs
    signal input merkleRoot;
    signal input walletBinding;         // must equal msg.sender on chain

    // Public output
    signal output nullifier;

    // Leaf = the commitment the investor handed the operator (D30 a)
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== identity;
    leafHasher.inputs[1] <== secret;

    // Hard inclusion: a non-member has no witness
    component inclusion = MerkleInclusion(levels);
    inclusion.leaf <== leafHasher.out;
    inclusion.root <== merkleRoot;
    // ... pathElements / pathIndices wired in a loop

    // One nullifier per commitment per root (D29 a)
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== merkleRoot;
    nullifier <== nullifierHasher.out;

    // Keeps walletBinding in the constraint system
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

component main {public [merkleRoot, walletBinding]} = WhitelistMembership(20);
```

Public signals, in snarkjs order: `[nullifier, merkleRoot, walletBinding]`
(nPublic 3). Depth 20, so up to 2^20 commitments. Proved and verified
with PLONK on the universal Hermez ptau (`powersOfTau28_hez_final_15`,
2^15, BLAKE2b-checked by `npm run setup:zk`); the committed verifier is
`contracts/privacy/verifiers/whitelist_membershipVerifier.sol`.

**What PrivacyManager adds** (`submitWhitelistProof`): the root must be
the one currently published by the list operator, `walletBinding` must
equal `msg.sender`, each signal must be below the scalar field (the
wrapper checks), and a nullifier binds one wallet per root version.
Publishing a new root lapses every binding until its holder proves again.

**Security Properties (what holds):**

- ✅ **Soundness:** a wallet cannot bind without a commitment in the
  current root and its secret (hard inclusion, binary path bits).
- ✅ **Confidential list:** the leaves are commitments, so the list cannot
  be enumerated from public identity data, and a proof does not say which
  listed identity produced it.
- ❌ **Not prover anonymity:** the wallet is public (ERC-3643 transfers
  name it, and the proof binds it); the chain shows which wallets hold a
  live binding.
- ✅ **Replay:** a copied proof fails for any other wallet
  (`WalletBindingMismatch`); a second wallet for the same nullifier under
  one root is refused (`NullifierBoundToOtherWallet`).
- ⚠️ **Bearer slot:** whoever holds the secret can bind one wallet per
  root; recovering a lost wallet needs a new root from ops.

### 2. Blacklist Non-Membership Circuit

`circuits/blacklist_membership.circom` (PLONK since Task 3.7). Statement:
the wallet's holder owns a commitment in the current whitelist root whose
identity is not in the sanctions tree; nothing on chain gates on it (D2).

**Circuit Logic (every check a hard constraint, no validity output):**

```circom
template BlacklistNonMembership(levels, smtLevels) {
    // Private: identity, secret, whitelist path, sanctions-tree witness
    // (siblings[smtLevels], oldKey, oldValue, isOld0)
    // Public:  whitelistRoot, blacklistRoot, walletBinding
    // Output:  nullifier

    // 1. Poseidon(identity, secret) is a leaf under whitelistRoot
    //    (MerkleInclusion: binary path bits, computed root === whitelistRoot)
    // 2. identity is NOT a key of the sanctions sparse Merkle tree:
    //    circomlib SMTVerifier with enabled = 1, fnc = 1 (non-inclusion),
    //    root = blacklistRoot, key = identity
    // 3. nullifier = Poseidon(secret, blacklistRoot)
    // 4. walletBinding kept in the constraint system (walletBindingSq)
}
component main {public [whitelistRoot, blacklistRoot, walletBinding]} =
    BlacklistNonMembership(20, 20);
```

Public signals: `[nullifier, whitelistRoot, blacklistRoot, walletBinding]`
(24,394 R1CS constraints, PLONK power 15 on the universal ptau). The
operator's sanctions tree is built with `utils/smt-builder.js` from the
listed identities; the prover gets the non-membership witness from it and
refuses a listed identity before proving.

**Properties:**

- ✅ Proves **non-membership** of an onboarded identity, not of an arbitrary value: the identity is tied to a whitelisted commitment
- ✅ A listed identity has no witness (`oldKey == key` and root mismatch both fail)
- ✅ The wrapper refuses any signal at or above the field order (no aliased signals)
- ℹ️ A privacy demonstration only: the blacklist gate is the BlacklistOracle (D2)

### 3-5. Attestation circuits: jurisdiction, accreditation, compliance aggregation

A trusted issuer signs the investor's attributes off chain with an EdDSA
Baby Jubjub key (D31 a, `scripts/zk/attest.js`); the circuits verify the
signature against the issuer's public key (Ax, Ay), the chain id, the
PrivacyManager (`verifierContext`), the signed expiry `validUntil` and the
public policy, bind the wallet and emit a nullifier. Shared templates live in
`circuits/attestation.circom`:

```circom
// M = Poseidon(domain, chainId, verifierContext, validUntil, identity, attributes..., salt);
// domain 1, 2, 3 per circuit, so an attestation signed for one circuit fails in
// another; validUntil < 2^64; R8 checked on the curve (BabyCheck).
component sig = EdDSAPoseidonVerifier();
sig.enabled <== 1;                 // constant: the check cannot be switched off
sig.Ax <== Ax; sig.Ay <== Ay;      // public: PrivacyManager must trust them
sig.R8x <== R8x; sig.R8y <== R8y; sig.S <== S; sig.M <== message.out;
// nullifier = Poseidon(salt, policyHash): one wallet per attestation per policy
```

| Circuit                  | Attested (private)                                       | Policy (public)                                                                       | Public signals                                                                                        |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `jurisdiction_proof`     | PrivacyManager's bit for the investor's ISO country code | `allowedMask` = OR of the bits of the registered codes ComplianceRules allows for VSC | `[nullifier, Ax, Ay, chainId, verifierContext, validUntil, allowedMask, walletBinding]`               |
| `accreditation_proof`    | the accreditation amount (< 2^64)                        | `minimumAccreditation`                                                                | `[nullifier, Ax, Ay, chainId, verifierContext, validUntil, minimumAccreditation, walletBinding]`      |
| `compliance_aggregation` | four scores 0..100 in one attestation                    | minimum and four weights summing to 100                                               | `[nullifier, Ax, Ay, chainId, verifierContext, validUntil, minimum, wK, wA, wJ, wAcc, walletBinding]` |

Every check is a hard constraint: the mask has exactly one bit and it is set
in `allowedMask` (both range-checked to 64 bits); `amount >= minimum`; the
weighted sum `>= minimum * 100` (no aggregate is output, so nothing beyond
"meets the policy" is disclosed). nPublic 8 / 8 / 12. PLONK on the universal
ptau: 25,100 / 25,044 / 27,085 gates (power 15).

PrivacyManager's `submitAttestationProof(circuitId, proof, signals)` refuses
the blacklist circuit (`NonGatingBlacklistProof`), a wrong signal count, an
unset policy, another chain (`WrongChainId`), another PrivacyManager
(`WrongVerifierContext`) and an expired attestation (`AttestationExpired`);
it requires the issuer key to be trusted for the circuit
(`setTrustedAttestor`), the policy signals to equal the current policy,
`walletBinding == msg.sender`
and the nullifier to be free under the policy (or the caller's), verifies
through the wrapper, and records `{policyHash, attestor, nullifier,
expiresAt}` (with the policy and attestor epochs), where `expiresAt =
min(now + proofValidityPeriod, validUntil)`. A record counts while its
policy is current, its issuer key is still trusted and it has not expired;
`validatePrivate*` add the user's preference flags (state-changing calls
that emit an event; no transfer path calls them).

**Properties:**

- ✅ A forged or altered attestation has no witness (EdDSA under the public key)
- ✅ An untrusted issuer key or a stale policy is refused on chain
- ✅ One wallet per attestation per policy; a policy change re-admits
- ✅ The wrapper refuses any signal at or above the field order

---
