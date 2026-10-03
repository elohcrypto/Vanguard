#!/usr/bin/env node

/**
 * ZK Circuits Readiness Verification Script
 *
 * Checks the artifacts of every circuit and whether its setup is sound:
 * protocol and nPublic per circuit, PLONK required for all five circuits with
 * their expected public-signal counts, and any Groth16 key or verifier with
 * gamma == delta (no phase-2 contribution, so forgeable) reported as UNSOUND.
 *
 * Exit 0: all present and sound. Exit 2: present, at least one circuit
 * unsound (never "ready for production"). Exit 1: artifacts missing/invalid.
 *
 * Usage: node scripts/verify-zk-readiness.js
 */

const fs = require("fs");
const path = require("path");

console.log("\n🔍 ZK Circuits Readiness Verification\n");
console.log("=".repeat(60));

// Circuit names and the protocol each must use come from the setup script,
// so the two cannot drift. PLONK runs on the universal ptau (hash-checked by
// setup:zk); a Groth16 key needs a per-circuit phase-2 contribution, and
// without one gamma == delta and anyone can forge a proof.
const { CIRCUITS: circuits, protocolOf } = require("./setup-zk-circuits");

// Public-signal count each sound circuit must expose (outputs first, then
// public inputs): whitelist [nullifier, merkleRoot, walletBinding],
// blacklist [nullifier, whitelistRoot, blacklistRoot, walletBinding],
// jurisdiction [nullifier, Ax, Ay, allowedMask, walletBinding],
// accreditation [nullifier, Ax, Ay, minimumAccreditation, walletBinding],
// compliance [nullifier, Ax, Ay, minimum, wK, wA, wJ, wAcc, walletBinding].
const EXPECTED_NPUBLIC = {
  whitelist_membership: 3,
  blacklist_membership: 4,
  jurisdiction_proof: 5,
  accreditation_proof: 5,
  compliance_aggregation: 9,
};

// Circuits whose setup does not make proofs sound, with the reason.
const unsound = [];

let allPassed = true;

// 1. Check circuit artifacts exist
console.log("\n📦 Step 1: Verifying Circuit Artifacts...\n");

circuits.forEach((circuit) => {
  const basePath = path.join(__dirname, "..", "build", "circuits", circuit);
  const wasmPath = path.join(basePath, `${circuit}_js`, `${circuit}.wasm`);
  const zkeyPath = path.join(basePath, `${circuit}.zkey`);
  const vkeyPath = path.join(basePath, `${circuit}_vkey.json`);
  const verifierPath = path.join(
    __dirname,
    "..",
    "contracts",
    "privacy",
    "verifiers",
    `${circuit}Verifier.sol`,
  );

  console.log(`  🔐 ${circuit}:`);

  // Check WASM
  if (fs.existsSync(wasmPath)) {
    const wasmSize = fs.statSync(wasmPath).size;
    const wasmHeader = fs.readFileSync(wasmPath).slice(0, 4);
    const isRealWasm = wasmHeader.toString("hex") === "0061736d";

    if (isRealWasm && wasmSize > 100000) {
      console.log(
        `     ✅ WASM: ${(wasmSize / 1024 / 1024).toFixed(1)} MB (REAL)`,
      );
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

  // Check verification key: protocol, nPublic, setup soundness
  const expected = protocolOf(circuit);
  let nPublic = null;
  if (fs.existsSync(vkeyPath)) {
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
    nPublic = vkey.nPublic;
    const shapeOk =
      vkey.protocol === "groth16"
        ? Boolean(vkey.vk_alpha_1 && vkey.IC)
        : vkey.protocol === "plonk"
          ? Boolean(vkey.Qm && vkey.S1 && vkey.X_2)
          : false;
    console.log(`     protocol: ${vkey.protocol}, nPublic: ${vkey.nPublic}`);
    if (!shapeOk) {
      console.log(`     ❌ vkey: Invalid format`);
      allPassed = false;
    } else if (vkey.protocol !== expected) {
      console.log(
        `     ❌ vkey: protocol ${vkey.protocol}, expected ${expected}`,
      );
      allPassed = false;
    } else if (circuit in EXPECTED_NPUBLIC && vkey.protocol !== "plonk") {
      console.log(`     ❌ vkey: ${circuit} must be PLONK`);
      allPassed = false;
    } else if (
      circuit in EXPECTED_NPUBLIC &&
      vkey.nPublic !== EXPECTED_NPUBLIC[circuit]
    ) {
      console.log(
        `     ❌ vkey: nPublic ${vkey.nPublic}, expected ${EXPECTED_NPUBLIC[circuit]}`,
      );
      allPassed = false;
    } else if (
      vkey.protocol === "groth16" &&
      JSON.stringify(vkey.vk_gamma_2) === JSON.stringify(vkey.vk_delta_2)
    ) {
      console.log(
        `     ⛔ vkey: UNSOUND: no phase-2 contribution (gamma == delta), proofs are forgeable`,
      );
      unsound.push(`${circuit} (groth16, gamma == delta)`);
    } else if (vkey.protocol === "plonk") {
      console.log(
        `     ✅ vkey: PLONK, universal setup (no per-circuit secret)`,
      );
    } else {
      console.log(`     ✅ vkey: Groth16 with a phase-2 contribution`);
    }
  } else {
    console.log(`     ❌ vkey: Missing`);
    allPassed = false;
  }

  // Check the committed Solidity verifier: name, ABI shape, and for Groth16
  // the same gamma == delta test on the constants that actually deploy.
  if (fs.existsSync(verifierPath)) {
    const src = fs.readFileSync(verifierPath, "utf8");
    const contractName =
      circuit
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("") + "Verifier";
    const abiShape =
      expected === "plonk"
        ? `verifyProof(uint256[24] calldata _proof, uint256[${nPublic}] calldata _pubSignals)`
        : `uint[${nPublic}] calldata _pubSignals)`;
    const constant = (n) =>
      (src.match(new RegExp(`uint256 constant ${n}\\s*=\\s*(\\d+)`)) || [])[1];
    const g2 = (p) => ["x1", "x2", "y1", "y2"].map((k) => constant(p + k));
    if (!src.includes(`contract ${contractName}`) || !src.includes(abiShape)) {
      console.log(
        `     ❌ Verifier: ${contractName}.sol does not match ${abiShape}`,
      );
      allPassed = false;
    } else if (expected === "groth16" && g2("gamma").includes(undefined)) {
      console.log(
        `     ❌ Verifier: ${contractName}.sol has no gamma/delta constants`,
      );
      allPassed = false;
    } else if (
      expected === "groth16" &&
      g2("gamma").join() === g2("delta").join()
    ) {
      console.log(
        `     ⛔ Verifier: ${contractName}.sol UNSOUND (gamma == delta)`,
      );
      if (!unsound.some((u) => u.startsWith(circuit))) {
        unsound.push(`${circuit} (groth16 verifier, gamma == delta)`);
      }
    } else {
      console.log(`     ✅ Verifier: ${contractName}.sol (${expected})`);
    }
  } else {
    console.log(`     ❌ Verifier: Missing`);
    allPassed = false;
  }
});

// 2. Check ZKVerifierIntegrated contract
console.log("\n📋 Step 2: Verifying ZKVerifierIntegrated Contract...\n");

const zkVerifierPath = path.join(
  __dirname,
  "..",
  "contracts",
  "privacy",
  "ZKVerifierIntegrated.sol",
);
if (fs.existsSync(zkVerifierPath)) {
  const content = fs.readFileSync(zkVerifierPath, "utf8");

  // Check testingMode flag
  if (content.includes("bool public immutable testingMode")) {
    console.log("  ✅ testingMode flag: Present (immutable)");
  } else {
    console.log("  ❌ testingMode flag: Missing");
    allPassed = false;
  }

  // Check mock verification logic
  if (content.includes("if (testingMode)")) {
    console.log("  ✅ Mock verification: Implemented");
  } else {
    console.log("  ❌ Mock verification: Missing");
    allPassed = false;
  }

  // Check all verifier integrations
  const verifierChecks = [
    "WhitelistMembershipVerifier",
    "BlacklistMembershipVerifier",
    "JurisdictionProofVerifier",
    "AccreditationProofVerifier",
    "ComplianceAggregationVerifier",
  ];

  verifierChecks.forEach((verifier) => {
    if (content.includes(verifier)) {
      console.log(`  ✅ ${verifier}: Integrated`);
    } else {
      console.log(`  ❌ ${verifier}: Not integrated`);
      allPassed = false;
    }
  });
} else {
  console.log("  ❌ ZKVerifierIntegrated.sol: Missing");
  allPassed = false;
}

// 3. Check RealProofGenerator
console.log("\n🔧 Step 3: Verifying RealProofGenerator...\n");

const generatorPath = path.join(__dirname, "generate-real-proofs.js");
if (fs.existsSync(generatorPath)) {
  const content = fs.readFileSync(generatorPath, "utf8");

  const methods = [
    "generateWhitelistProof",
    "generateBlacklistProof",
    "generateJurisdictionProof",
    "generateAccreditationProof",
    "generateComplianceProof",
  ];

  methods.forEach((method) => {
    if (content.includes(method)) {
      console.log(`  ✅ ${method}: Implemented`);
    } else {
      console.log(`  ❌ ${method}: Missing`);
      allPassed = false;
    }
  });
} else {
  console.log("  ❌ generate-real-proofs.js: Missing");
  allPassed = false;
}

// Final report
console.log("\n" + "=".repeat(60));
console.log("\n📊 Verification Summary:\n");

if (allPassed && unsound.length === 0) {
  console.log("  🎉 ALL CHECKS PASSED!\n");
  console.log("  ✅ All circuits have real artifacts and a sound setup");
  console.log("  ✅ ZKVerifierIntegrated supports both mock and real modes");
  console.log("  ✅ RealProofGenerator can generate all proof types\n");
  console.log("  This checks artifacts and setups only; the consumer's checks");
  console.log(
    "  (root and policy compare, trusted issuer keys, wallet binding,",
  );
  console.log(
    "  nullifier maps) live in PrivacyManager and are covered by the",
  );
  console.log("  tests.\n");
  process.exit(0);
} else if (allPassed) {
  console.log("  ⛔ NOT READY for production: unsound setup\n");
  unsound.forEach((u) => console.log(`     • ${u}`));
  console.log(
    "\n  Artifacts are present, so the demo and tests run, but a forged proof",
  );
  console.log(
    "  verifies for every circuit above. Move it to PLONK (D28 c).\n",
  );
  process.exit(2);
} else {
  console.log("  ❌ SOME CHECKS FAILED!\n");
  if (unsound.length) {
    console.log("  Also unsound:");
    unsound.forEach((u) => console.log(`     • ${u}`));
  }
  console.log("  Please review the errors above and run:");
  console.log("    npm run setup:zk\n");
  process.exit(1);
}
