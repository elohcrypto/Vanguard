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

### ⚠️ Compliance Aggregation - CRITICAL CONSTRAINT

**The weighted sum MUST be divisible by 100!**

```javascript
// Calculate: (kyc*wKyc + aml*wAml + jur*wJur + acc*wAcc) % 100 === 0

// ✅ VALID Examples:
{ kyc: 80, aml: 76, jur: 84, acc: 60, weights: [25,25,25,25] } // Sum: 7500
{ kyc: 88, aml: 88, jur: 88, acc: 88, weights: [30,30,20,20] } // Sum: 8800
{ kyc: 90, aml: 90, jur: 90, acc: 90, weights: [25,25,25,25] } // Sum: 9000

// ❌ INVALID Examples:
{ kyc: 80, aml: 75, jur: 85, acc: 70, weights: [25,25,25,25] } // Sum: 7750 (not divisible)
{ kyc: 90, aml: 85, jur: 95, acc: 80, weights: [30,30,20,20] } // Sum: 8750 (not divisible)
```

**Quick Validation:**
```javascript
const sum = (kyc * wKyc) + (aml * wAml) + (jur * wJur) + (acc * wAcc);
if (sum % 100 !== 0) {
    throw new Error(`Invalid input: sum ${sum} not divisible by 100`);
}
```

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
const proof = await generator.generateComplianceProof({
    kycScore: BigInt(80),
    amlScore: BigInt(76),
    jurisdictionScore: BigInt(84),
    accreditationScore: BigInt(60),
    weightKyc: BigInt(25),
    weightAml: BigInt(25),
    weightJurisdiction: BigInt(25),
    weightAccreditation: BigInt(25),
    minimumComplianceLevel: BigInt(70)
});
// Returns: { proof: {a, b, c}, publicSignals: [1, 75] }
// Time: ~65 ms
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
| blacklist_membership | ~50s | 63k | 11,339 |
| jurisdiction_proof | ~86ms | 130k | 1,339 |
| accreditation_proof | ~82ms | 64k | 2,839 |
| compliance_aggregation | ~65ms | 130k | 2,339 |

---

## 🐛 Troubleshooting

### "Assert Failed" Error in Compliance Circuit
**Cause:** Weighted sum not divisible by 100  
**Fix:** Adjust scores so `(kyc*wKyc + aml*wAml + jur*wJur + acc*wAcc) % 100 === 0`

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
- [ ] Verify compliance inputs are divisible by 100
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

