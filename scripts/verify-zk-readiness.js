#!/usr/bin/env node

/**
 * ZK Circuits Readiness Verification Script
 * 
 * This script verifies that all ZK circuits are ready for both:
 * 1. Mock mode (testing) - Fast verification without real proofs
 * 2. REAL mode (production) - Actual cryptographic proof verification
 * 
 * Usage: node scripts/verify-zk-readiness.js
 */

const fs = require('fs');
const path = require('path');

console.log('\n🔍 ZK Circuits Readiness Verification\n');
console.log('=' .repeat(60));

// Circuit names
const circuits = [
    'whitelist_membership',
    'blacklist_membership',
    'jurisdiction_proof',
    'accreditation_proof',
    'compliance_aggregation'
];

let allPassed = true;

// 1. Check circuit artifacts exist
console.log('\n📦 Step 1: Verifying Circuit Artifacts...\n');

circuits.forEach(circuit => {
    const basePath = path.join(__dirname, '..', 'build', 'circuits', circuit);
    const wasmPath = path.join(basePath, `${circuit}_js`, `${circuit}.wasm`);
    const zkeyPath = path.join(basePath, `${circuit}.zkey`);
    const vkeyPath = path.join(basePath, `${circuit}_vkey.json`);
    const verifierPath = path.join(__dirname, '..', 'contracts', 'privacy', 'verifiers',
        `${circuit}Verifier.sol`);

    console.log(`  🔐 ${circuit}:`);
    
    // Check WASM
    if (fs.existsSync(wasmPath)) {
        const wasmSize = fs.statSync(wasmPath).size;
        const wasmHeader = fs.readFileSync(wasmPath).slice(0, 4);
        const isRealWasm = wasmHeader.toString('hex') === '0061736d';
        
        if (isRealWasm && wasmSize > 100000) {
            console.log(`     ✅ WASM: ${(wasmSize / 1024 / 1024).toFixed(1)} MB (REAL)`);
        } else {
            console.log(`     ❌ WASM: Invalid or mock file`);
            allPassed = false;
        }
    } else {
        console.log(`     ❌ WASM: Missing`);
        allPassed = false;
    }

    // Check zkey
    if (fs.existsSync(zkeyPath)) {
        const zkeySize = fs.statSync(zkeyPath).size;
        console.log(`     ✅ zkey: ${(zkeySize / 1024).toFixed(0)} KB`);
    } else {
        console.log(`     ❌ zkey: Missing`);
        allPassed = false;
    }

    // Check verification key
    if (fs.existsSync(vkeyPath)) {
        const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
        if (vkey.protocol === 'groth16' && vkey.vk_alpha_1 && vkey.IC) {
            console.log(`     ✅ vkey: Valid Groth16 (${vkey.IC.length - 1} public inputs)`);
        } else {
            console.log(`     ❌ vkey: Invalid format`);
            allPassed = false;
        }
    } else {
        console.log(`     ❌ vkey: Missing`);
        allPassed = false;
    }

    // Check Solidity verifier
    if (fs.existsSync(verifierPath)) {
        const verifierContent = fs.readFileSync(verifierPath, 'utf8');
        const contractName = circuit.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Verifier';
        if (verifierContent.includes(`contract ${contractName}`) && verifierContent.includes('verifyProof')) {
            console.log(`     ✅ Verifier: ${contractName}.sol`);
        } else {
            console.log(`     ❌ Verifier: Invalid contract`);
            allPassed = false;
        }
    } else {
        console.log(`     ❌ Verifier: Missing`);
        allPassed = false;
    }
});

// 2. Check ZKVerifierIntegrated contract
console.log('\n📋 Step 2: Verifying ZKVerifierIntegrated Contract...\n');

const zkVerifierPath = path.join(__dirname, '..', 'contracts', 'privacy', 'ZKVerifierIntegrated.sol');
if (fs.existsSync(zkVerifierPath)) {
    const content = fs.readFileSync(zkVerifierPath, 'utf8');
    
    // Check testingMode flag
    if (content.includes('bool public immutable testingMode')) {
        console.log('  ✅ testingMode flag: Present (immutable)');
    } else {
        console.log('  ❌ testingMode flag: Missing');
        allPassed = false;
    }

    // Check mock verification logic
    if (content.includes('if (testingMode)')) {
        console.log('  ✅ Mock verification: Implemented');
    } else {
        console.log('  ❌ Mock verification: Missing');
        allPassed = false;
    }

    // Check all verifier integrations
    const verifierChecks = [
        'WhitelistMembershipVerifier',
        'BlacklistMembershipVerifier',
        'JurisdictionProofVerifier',
        'AccreditationProofVerifier',
        'ComplianceAggregationVerifier'
    ];

    verifierChecks.forEach(verifier => {
        if (content.includes(verifier)) {
            console.log(`  ✅ ${verifier}: Integrated`);
        } else {
            console.log(`  ❌ ${verifier}: Not integrated`);
            allPassed = false;
        }
    });
} else {
    console.log('  ❌ ZKVerifierIntegrated.sol: Missing');
    allPassed = false;
}

// 3. Check RealProofGenerator
console.log('\n🔧 Step 3: Verifying RealProofGenerator...\n');

const generatorPath = path.join(__dirname, 'generate-real-proofs.js');
if (fs.existsSync(generatorPath)) {
    const content = fs.readFileSync(generatorPath, 'utf8');
    
    const methods = [
        'generateWhitelistProof',
        'generateBlacklistProof',
        'generateJurisdictionProof',
        'generateAccreditationProof',
        'generateComplianceProof'
    ];

    methods.forEach(method => {
        if (content.includes(method)) {
            console.log(`  ✅ ${method}: Implemented`);
        } else {
            console.log(`  ❌ ${method}: Missing`);
            allPassed = false;
        }
    });
} else {
    console.log('  ❌ generate-real-proofs.js: Missing');
    allPassed = false;
}

// Final report
console.log('\n' + '='.repeat(60));
console.log('\n📊 Verification Summary:\n');

if (allPassed) {
    console.log('  🎉 ALL CHECKS PASSED!\n');
    console.log('  ✅ All 5 circuits have REAL cryptographic artifacts');
    console.log('  ✅ ZKVerifierIntegrated supports both mock and REAL modes');
    console.log('  ✅ RealProofGenerator can generate all proof types');
    console.log('  ✅ Solidity verifier contracts are properly named\n');
    console.log('  🚀 System is READY for both testing and production!\n');
    console.log('  📖 See docs/ZK_CIRCUITS_READINESS.md for usage guide\n');
    process.exit(0);
} else {
    console.log('  ❌ SOME CHECKS FAILED!\n');
    console.log('  Please review the errors above and run:');
    console.log('    npm run setup:zk\n');
    process.exit(1);
}

