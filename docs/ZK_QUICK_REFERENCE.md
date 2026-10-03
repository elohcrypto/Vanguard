# ZK Circuits Quick Reference

## 🎯 TL;DR

**Mock Mode (Testing):** Deploy with `new ZKVerifierIntegrated(true)` - Instant verification, no real proofs needed  
**REAL Mode (Production):** Deploy with `new ZKVerifierIntegrated(false)` - Cryptographic verification, requires real proofs

---

## 🚀 Quick Start

### Testing (Mock Mode)
```bash
# Run all tests with mock verification
npm test

# Deploy contract for testing
npx hardhat run scripts/deploy.js --network localhost
# Uses testingMode=true by default
```

> ⚠️ Mock mode covers on-chain *verification*, but 4 test suites generate **real
> proofs** with snarkjs and need the circuit artifacts on disk. Without
> `npm run setup:zk` first, `npm test` reports **23 failures** (all `ENOENT`).
> With it: **0 failures**. (Pass counts change as tests are added; the failure
> count is the stable signal.)

### Production (REAL Mode)
```bash
# Generate real circuit artifacts (one-time setup)
# Requires Rust circom 2.x — see docs/ZK_CIRCUIT_BUILD_GUIDE.md
npm run setup:zk

# Test real proof generation
npx hardhat test test/privacy/RealZKProofs.test.js

# Deploy for production
# Edit deploy script to use: new ZKVerifierIntegrated(false)
npx hardhat run scripts/deploy.js --network mainnet
```

---

## 📋 Circuit Constraints

### Attestation circuits (jurisdiction, accreditation, compliance)
Since Task 3.7b the three circuits prove an issuer's EdDSA signature over
the attributes and PrivacyManager's policy; there is no division and no
divisibility rule. Inputs that miss the policy have no witness: the mask
bit must be in `allowedMask`, `amount >= minimumAccreditation` (both below
2^64), each score at most 100, the weights summing to 100 and
`kyc*wK + aml*wA + jur*wJ + acc*wAcc >= minimum * 100`.

---

## 🔧 Common Operations

### Generate Whitelist Proof
```javascript
const { RealProofGenerator } = require('./scripts/generate-real-proofs.js');
const generator = new RealProofGenerator();

const proof = await generator.generateWhitelistProof({
    userLeaf: BigInt("0x123..."),
    merkleRoot: BigInt("0x456..."),
    pathElements: [BigInt("0x789..."), ...], // 20 elements
    pathIndices: [0, 1, 0, ...]  // 20 elements (0 or 1)
});
// Returns: { proof: {a, b, c}, publicSignals: [1] }
// Time: ~50 seconds
```

### Generate Compliance Proof
```javascript
// Attestation proofs (Task 3.7b): an issuer signs, the investor proves
const { signAttestation } = require('./scripts/zk/attest.js');
const att = await signAttestation({
    key: process.env.ATTESTOR_KEY, circuit: 'compliance',
    identity: onchainID, scores: [80, 75, 85, 70],
});
const complianceProof = await generator.generateComplianceProof({
    identity: att.identity, scores: att.attributes, salt: att.salt,
    R8x: att.R8x, R8y: att.R8y, S: att.S, Ax: att.Ax, Ay: att.Ay,
    minimum: 70n, weights: [25n, 25n, 25n, 25n], walletBinding: wallet,
});
// publicSignals: [nullifier, Ax, Ay, 70, 25, 25, 25, 25, wallet]
// scripts/zk/prove-attestation.js reads the policy and the issuer trust
// from PrivacyManager and wraps this for investors.
// Time: ~9 s
```

### Verify Proof On-Chain
```javascript
const zkVerifier = await ethers.getContractAt("ZKVerifierIntegrated", address);

const result = await zkVerifier.verifyWhitelistMembership(
    proof.a,
    proof.b,
    proof.c,
    proof.publicSignals
);
// Returns: true if valid, false if invalid
// Gas: ~147k for whitelist, ~63k for simple proofs
```

---

## 🎭 Mode Comparison

| Feature | Mock Mode | REAL Mode |
|---------|-----------|-----------|
| **Deployment** | `new ZKVerifierIntegrated(true)` | `new ZKVerifierIntegrated(false)` |
| **Proof Required** | No (any values work) | Yes (cryptographically valid) |
| **Verification Time** | Instant | ~200k gas |
| **Security** | ❌ None | ✅ Cryptographic |
| **Use Case** | Testing, CI/CD | Production, Mainnet |
| **Cost** | ~21k gas | ~63-147k gas |

---

## 📊 Performance

| Circuit | Proof Gen Time | Verification Gas | Constraints |
|---------|----------------|------------------|-------------|
| whitelist_membership | ~50s | 147k | 11,339 |
| blacklist_membership (PLONK) | ~9s | ~390-420k via the wrapper | 24,394 |
| jurisdiction_proof (PLONK) | ~9s | ~424k via the wrapper, ~550k via submitAttestationProof | 9,539 |
| accreditation_proof (PLONK) | ~9s | ~409k via the wrapper | 9,542 |
| compliance_aggregation (PLONK) | ~9s | ~412k via the wrapper | 10,687 |

---

## 🐛 Troubleshooting

### "Assert Failed" Error in an Attestation Circuit
**Cause:** A forged or altered attestation (EdDSAPoseidonVerifier), or attributes that miss the policy  
**Fix:** Use the issuer's attestation unchanged; `scripts/zk/prove-attestation.js` names the unmet policy before proving

### "ENOENT: no such file or directory" for WASM
**Cause:** Circuits not compiled  
**Fix:** Run `npm run setup:zk`

### Mock Proof Returns False in Production
**Cause:** Contract deployed with `testingMode=false`  
**Fix:** Generate real proofs using `RealProofGenerator`

### Verifier Contract Not Found
**Cause:** Contract names changed after compilation  
**Fix:** Run `npm run setup:zk` to regenerate with correct names

---

## ✅ Verification Checklist

Before deploying to production:

- [ ] Run `node scripts/verify-zk-readiness.js` - All checks pass
- [ ] Run `npm test` - All 710 tests pass
- [ ] Test real proof generation for each circuit type
- [ ] Trust each issuer's (Ax, Ay) and set the policies on PrivacyManager
- [ ] Deploy with `testingMode=false`
- [ ] Test on-chain verification with real proofs
- [ ] Monitor gas costs and adjust limits if needed

---

## 📚 Additional Resources

- **Full Documentation:** `docs/ZK_CIRCUITS_READINESS.md`
- **Verification Script:** `scripts/verify-zk-readiness.js`
- **Proof Generator:** `scripts/generate-real-proofs.js`
- **Test Examples:** `test/privacy/RealZKProofs.test.js`

---

**Status:** 🟢 All circuits ready for mock and REAL usage!

