#!/usr/bin/env node

/**
 * ZK Circuits Readiness Verification Script
 *
 * Checks that the artifacts of every circuit match the committed Solidity
 * verifier: protocol and nPublic per circuit (PLONK required for all five,
 * with their expected public-signal counts), and every constant the PLONK
 * verifier deploys (n, nPublic, k1, k2, w1, Qm, Ql, Qr, Qo, Qc, S1, S2,
 * S3, X2) equal to the verification key's (review 3.9 B-M5: a foreign
 * verifier with other constants fails here). Only those constants are
 * compared, not the verifier body: one with copied constants and an
 * edited body passes here; CI's diff after setup:zk and the ceremony's
 * code-hash pins catch that. A Groth16 key or verifier with
 * gamma == delta (no phase-2 contribution, so forgeable) is reported as
 * UNSOUND. It does not compare the vkey with the zkey or re-run setup:zk;
 * CI does that (the verifier diff after setup:zk and the recompile tests).
 *
 * Exit 0: all present and matching. Exit 2: present, at least one circuit
 * unsound. Exit 1: artifacts missing, invalid or not matching.
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
// the attestations carry [nullifier, Ax, Ay, chainId, verifierContext,
// policy..., walletBinding] (Task 3.8 M1): jurisdiction policy [allowedMask],
// accreditation [minimumAccreditation], compliance [minimum, wK, wA, wJ, wAcc].
const EXPECTED_NPUBLIC = {
  whitelist_membership: 3,
  blacklist_membership: 4,
  jurisdiction_proof: 8,
  accreditation_proof: 8,
  compliance_aggregation: 12,
};

// Circuits whose setup does not make proofs sound, with the reason.
const unsound = [];

/**
 * Names of the PLONK verifier constants in `src` (snarkjs template) that
 * differ from `vkey`, or are missing. G1 points are [x, y, 1] in the vkey;
 * X_2 is [[x1, x2], [y1, y2], ...]; n is 2^power.
 */
function plonkConstantMismatches(src, vkey) {
  const want = {
    n: 2n ** BigInt(vkey.power),
    nPublic: vkey.nPublic,
    k1: vkey.k1,
    k2: vkey.k2,
    w1: vkey.w,
    X2x1: vkey.X_2[0][0],
    X2x2: vkey.X_2[0][1],
    X2y1: vkey.X_2[1][0],
    X2y2: vkey.X_2[1][1],
  };
  for (const p of ["Qm", "Ql", "Qr", "Qo", "Qc", "S1", "S2", "S3"]) {
    want[`${p}x`] = vkey[p][0];
    want[`${p}y`] = vkey[p][1];
  }
  const bad = [];
  for (const [name, value] of Object.entries(want)) {
    const m = src.match(
      new RegExp(`\\buint\\d+\\s+constant\\s+${name}\\s*=\\s*(\\d+)\\s*;`),
    );
    if (!m || BigInt(m[1]) !== BigInt(value)) bad.push(name);
  }
  return bad;
}

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
  let vkey = null;
  if (fs.existsSync(vkeyPath)) {
    vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
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

  // Check the committed Solidity verifier: name, ABI shape, for PLONK every
  // constant against the vkey, and for Groth16 the same gamma == delta test
  // on the constants that actually deploy.
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
    } else if (expected === "plonk" && vkey && vkey.protocol === "plonk") {
      const bad = plonkConstantMismatches(src, vkey);
      if (bad.length) {
        console.log(
          `     ❌ Verifier: ${contractName}.sol constants differ from the vkey: ${bad.join(", ")}`,
        );
        allPassed = false;
      } else {
        console.log(
          `     ✅ Verifier: ${contractName}.sol (plonk), every constant matches the vkey`,
        );
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
// The deployed contract's source set: ZKVerifierIntegrated.sol plus every
// base it inherits that lives beside it in contracts/privacy/ (Task 4.8
// moved the five verifier instances and the immutable testingMode into the
// base ZKVerifierAdmin). Bases come from the `is` lists, so the generated
// verifiers, which are only imported, never count as the wrapper's source.
function inheritedSources(file, name, seen = new Set()) {
  if (seen.has(name) || !fs.existsSync(file)) return "";
  seen.add(name);
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(new RegExp(`contract\\s+${name}\\s+is\\s+([^{]+)\\{`));
  let out = src;
  if (m) {
    for (const base of m[1].split(",").map((b) => b.trim().split(/[\s(]/)[0])) {
      out +=
        "\n" +
        inheritedSources(
          path.join(path.dirname(file), `${base}.sol`),
          base,
          seen,
        );
    }
  }
  return out;
}

if (fs.existsSync(zkVerifierPath)) {
  const content = inheritedSources(zkVerifierPath, "ZKVerifierIntegrated");

  // testingMode (tests only) must be fixed at deploy: PrivacyManager and
  // the handover ceremony refuse a wrapper deployed with it on.
  if (content.includes("bool public immutable testingMode")) {
    console.log("  ✅ testingMode flag: immutable");
  } else {
    console.log("  ❌ testingMode flag: not immutable");
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
  console.log(
    "  ✅ The circuit artifacts match the committed verifiers (PLONK, nPublic, constants)",
  );
  console.log(
    "  ✅ ZKVerifierIntegrated routes all five verifiers; testingMode is immutable",
  );
  console.log("  ✅ RealProofGenerator has a generator for every proof type\n");
  console.log(
    "  This checks artifacts and verifiers only; the consumer's checks",
  );
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
