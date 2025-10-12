# 🔧 ZK Circuit Build Guide

## 🚀 Quick Start

### **Single Command to Build All Circuits:**

```bash
npm run setup:zk
```

This command will:
1. ✅ Create build directories
2. ✅ Download Powers of Tau file (trusted setup)
3. ✅ Compile all 5 Circom circuits
4. ✅ Generate proving keys (.zkey files)
5. ✅ Generate verifying keys (.json files)
6. ✅ Generate Solidity verifier contracts
7. ✅ Create circuit information file

---

## 📋 What Circuits Are Built?

The system builds **5 ZK circuits** for privacy-preserving compliance:

| # | Circuit Name | Purpose | File |
|---|--------------|---------|------|
| 1 | **Whitelist Membership** | Prove you're whitelisted without revealing identity | `whitelist_membership.circom` |
| 2 | **Blacklist Non-Membership** | Prove you're NOT blacklisted privately | `blacklist_membership.circom` |
| 3 | **Jurisdiction Proof** | Prove location eligibility without revealing country | `jurisdiction_proof.circom` |
| 4 | **Accreditation Proof** | Prove wealth level without revealing exact amount | `accreditation_proof.circom` |
| 5 | **Compliance Aggregation** | Prove overall compliance without revealing scores | `compliance_aggregation.circom` |

---

## 🔄 Complete Build Process

### **Step-by-Step:**

```bash
# 1. Install dependencies (if not already done)
npm install

# 2. Build all ZK circuits
npm run setup:zk
```

### **Expected Output:**

```
🚀 Setting up ZK circuits for CMTA UTXO Compliance POC
============================================================
📁 Creating build directories...
⬇️  Downloading Powers of Tau file...
✅ Powers of Tau file downloaded

🔄 Processing whitelist_membership...
🔧 Compiling whitelist_membership circuit...
✅ whitelist_membership circuit compiled
✅ whitelist_membership witness calculator generated
🔑 Generating keys for whitelist_membership...
✅ whitelist_membership proving key generated
✅ whitelist_membership verifying key exported
📜 Generating Solidity verifier for whitelist_membership...
✅ whitelist_membership Solidity verifier generated
✅ whitelist_membership setup completed successfully

🔄 Processing blacklist_membership...
🔧 Compiling blacklist_membership circuit...
✅ blacklist_membership circuit compiled
✅ blacklist_membership witness calculator generated
🔑 Generating keys for blacklist_membership...
✅ blacklist_membership proving key generated
✅ blacklist_membership verifying key exported
📜 Generating Solidity verifier for blacklist_membership...
✅ blacklist_membership Solidity verifier generated
✅ blacklist_membership setup completed successfully

🔄 Processing jurisdiction_proof...
🔧 Compiling jurisdiction_proof circuit...
✅ jurisdiction_proof circuit compiled
✅ jurisdiction_proof witness calculator generated
🔑 Generating keys for jurisdiction_proof...
✅ jurisdiction_proof proving key generated
✅ jurisdiction_proof verifying key exported
📜 Generating Solidity verifier for jurisdiction_proof...
✅ jurisdiction_proof Solidity verifier generated
✅ jurisdiction_proof setup completed successfully

🔄 Processing accreditation_proof...
🔧 Compiling accreditation_proof circuit...
✅ accreditation_proof circuit compiled
✅ accreditation_proof witness calculator generated
🔑 Generating keys for accreditation_proof...
✅ accreditation_proof proving key generated
✅ accreditation_proof verifying key exported
📜 Generating Solidity verifier for accreditation_proof...
✅ accreditation_proof Solidity verifier generated
✅ accreditation_proof setup completed successfully

🔄 Processing compliance_aggregation...
🔧 Compiling compliance_aggregation circuit...
✅ compliance_aggregation circuit compiled
✅ compliance_aggregation witness calculator generated
🔑 Generating keys for compliance_aggregation...
✅ compliance_aggregation proving key generated
✅ compliance_aggregation verifying key exported
📜 Generating Solidity verifier for compliance_aggregation...
✅ compliance_aggregation Solidity verifier generated
✅ compliance_aggregation setup completed successfully

📊 Generating circuit information...
✅ Circuit information saved to build/circuits/circuit-info.json

🎉 ZK circuit setup completed!

📋 Summary:
   • 5 circuits processed
   • Build directory: build/circuits
   • Verifier contracts: contracts/privacy/verifiers/

💡 Note: This demo uses simplified/mock implementations.
   For production, use proper Circom compilation and trusted setup.
```

---

## 📂 Output Files

### **Directory Structure After Build:**

```
build/circuits/
├── powersOfTau28_hez_final_15.ptau          # Trusted setup file
├── circuit-info.json                         # Circuit metadata
│
├── whitelist_membership/
│   ├── whitelist_membership.r1cs             # Constraint system
│   ├── whitelist_membership.wasm             # Witness calculator
│   ├── whitelist_membership.zkey             # Proving key
│   ├── whitelist_membership_vkey.json        # Verifying key
│   └── whitelist_membership_js/              # JS witness calculator
│
├── blacklist_membership/
│   ├── blacklist_membership.r1cs
│   ├── blacklist_membership.wasm
│   ├── blacklist_membership.zkey
│   ├── blacklist_membership_vkey.json
│   └── blacklist_membership_js/
│
├── jurisdiction_proof/
│   ├── jurisdiction_proof.r1cs
│   ├── jurisdiction_proof.wasm
│   ├── jurisdiction_proof.zkey
│   ├── jurisdiction_proof_vkey.json
│   └── jurisdiction_proof_js/
│
├── accreditation_proof/
│   ├── accreditation_proof.r1cs
│   ├── accreditation_proof.wasm
│   ├── accreditation_proof.zkey
│   ├── accreditation_proof_vkey.json
│   └── accreditation_proof_js/
│
└── compliance_aggregation/
    ├── compliance_aggregation.r1cs
    ├── compliance_aggregation.wasm
    ├── compliance_aggregation.zkey
    ├── compliance_aggregation_vkey.json
    └── compliance_aggregation_js/

contracts/privacy/verifiers/
├── whitelist_membershipVerifier.sol          # Solidity verifier
├── blacklist_membershipVerifier.sol
├── jurisdiction_proofVerifier.sol
├── accreditation_proofVerifier.sol
└── compliance_aggregationVerifier.sol
```

---

## 🔍 File Explanations

### **1. Powers of Tau (.ptau)**
- **File:** `powersOfTau28_hez_final_15.ptau`
- **Purpose:** Trusted setup parameters for Groth16
- **Size:** ~50 MB
- **Source:** Hermez ceremony (trusted by Ethereum community)
- **Supports:** Circuits up to 2^15 constraints (~32,000)

### **2. R1CS (.r1cs)**
- **File:** `{circuit_name}.r1cs`
- **Purpose:** Rank-1 Constraint System (circuit constraints)
- **Format:** Binary format
- **Contains:** Mathematical constraints that define the circuit

### **3. WASM (.wasm)**
- **File:** `{circuit_name}.wasm`
- **Purpose:** WebAssembly witness calculator
- **Use:** Generates witness (private inputs) for proof generation
- **Fast:** Optimized for browser and Node.js

### **4. Proving Key (.zkey)**
- **File:** `{circuit_name}.zkey`
- **Purpose:** Key used to generate proofs
- **Size:** Varies by circuit complexity
- **Security:** Must be kept secure (but not secret)

### **5. Verifying Key (.json)**
- **File:** `{circuit_name}_vkey.json`
- **Purpose:** Key used to verify proofs
- **Format:** JSON
- **Public:** Can be shared publicly
- **Contains:** Elliptic curve points for verification

### **6. Solidity Verifier (.sol)**
- **File:** `{circuit_name}Verifier.sol`
- **Purpose:** On-chain proof verification
- **Gas Cost:** ~250,000-300,000 gas per verification
- **Optimized:** Uses precompiled contracts (ecPairing)

---

## 🛠️ Manual Build Steps

If you want to build circuits manually or one at a time:

### **1. Compile a Single Circuit:**

```bash
# Compile whitelist_membership circuit
circom circuits/whitelist_membership.circom \
  --r1cs \
  --wasm \
  --sym \
  -o build/circuits/whitelist_membership \
  -l node_modules
```

### **2. Generate Proving Key:**

```bash
# Generate proving key for whitelist_membership
snarkjs groth16 setup \
  build/circuits/whitelist_membership/whitelist_membership.r1cs \
  build/circuits/powersOfTau28_hez_final_15.ptau \
  build/circuits/whitelist_membership/whitelist_membership.zkey
```

### **3. Export Verifying Key:**

```bash
# Export verifying key
snarkjs zkey export verificationkey \
  build/circuits/whitelist_membership/whitelist_membership.zkey \
  build/circuits/whitelist_membership/whitelist_membership_vkey.json
```

### **4. Generate Solidity Verifier:**

```bash
# Generate Solidity verifier contract
snarkjs zkey export solidityverifier \
  build/circuits/whitelist_membership/whitelist_membership.zkey \
  contracts/privacy/verifiers/whitelist_membershipVerifier.sol
```

---

## 📊 Circuit Information File

After building, check `build/circuits/circuit-info.json`:

```json
{
  "circuits": {
    "whitelist_membership": {
      "id": "keccak256(\"WHITELIST_MEMBERSHIP\")",
      "name": "whitelist_membership",
      "description": "Proves membership in a whitelist without revealing identity",
      "verifyingKey": { ... },
      "buildPath": "build/circuits/whitelist_membership",
      "hasVerifier": true
    },
    "jurisdiction_proof": {
      "id": "keccak256(\"JURISDICTION_PROOF\")",
      "name": "jurisdiction_proof",
      "description": "Proves jurisdiction eligibility without revealing location",
      "verifyingKey": { ... },
      "buildPath": "build/circuits/jurisdiction_proof",
      "hasVerifier": true
    }
    // ... other circuits
  },
  "buildTimestamp": "2024-01-20T10:30:00.000Z",
  "version": "1.0.0"
}
```

---

## 🧪 Testing the Build

### **Verify Build Success:**

```bash
# Check if all files exist
ls -la build/circuits/whitelist_membership/
ls -la contracts/privacy/verifiers/

# View circuit info
cat build/circuits/circuit-info.json | jq
```

### **Test Proof Generation:**

```bash
# Generate a test proof (requires witness input)
node scripts/test-proof-generation.js
```

---

## 🚨 Troubleshooting

### **Issue 1: "circom: command not found"**

```bash
# Install circom globally
npm install -g circom

# Or use npx
npx circom --version
```

### **Issue 2: "snarkjs: command not found"**

```bash
# Install snarkjs globally
npm install -g snarkjs

# Or use npx
npx snarkjs --version
```

### **Issue 3: "wget: command not found" (macOS)**

```bash
# Install wget using Homebrew
brew install wget

# Or use curl instead
curl -o build/circuits/powersOfTau28_hez_final_15.ptau \
  https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau
```

### **Issue 4: Build fails with "Out of memory"**

```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" npm run setup:zk
```

### **Issue 5: Mock files created instead of real circuits**

This is normal for demo purposes. The script creates mock files if:
- Circom is not installed
- Powers of Tau file can't be downloaded
- Circuit compilation fails

For production, ensure all dependencies are installed.

---

## 📋 Summary

### **Quick Commands:**

| Command | Purpose |
|---------|---------|
| `npm run setup:zk` | Build all circuits |
| `npm install` | Install dependencies |
| `circom --version` | Check Circom version |
| `snarkjs --version` | Check SnarkJS version |

### **Key Files:**

| File | Purpose |
|------|---------|
| `circuits/*.circom` | Circuit source code |
| `build/circuits/` | Compiled circuits |
| `contracts/privacy/verifiers/` | Solidity verifiers |
| `scripts/setup-zk-circuits.js` | Build script |

### **Dependencies:**

- ✅ **circom** (v0.5.46+) - Circuit compiler
- ✅ **snarkjs** (v0.7.5+) - Proof generation/verification
- ✅ **circomlib** (v2.0.5+) - Circuit library
- ✅ **Node.js** (v16+) - Runtime environment

---

**Run `npm run setup:zk` to get started!** 

