const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

/**
 * @title ZK Circuit Setup Script
 * @dev Compiles Circom circuits and generates proving/verifying keys
 */

const CIRCUITS_DIR = path.join(__dirname, "../circuits");
const BUILD_DIR = path.join(__dirname, "../build/circuits");
const PTAU_FILE = path.join(BUILD_DIR, "powersOfTau28_hez_final_15.ptau");

// Hermez ceremony output for circuits up to 2^15 constraints. Every public
// mirror of it (Hermez S3, the GCS zkevm bucket, the PSE bucket) now returns
// 403 or 404, so it is hosted on this repo's releases. A trusted-setup file
// must never be taken on faith from any URL, ours included: the download is
// verified against the BLAKE2b-512 published in the snarkjs README
// (https://github.com/iden3/snarkjs#7-prepare-phase-2) before it is used,
// and a pre-existing local file is verified the same way.
const PTAU_URL =
  "https://github.com/elohcrypto/Vanguard/releases/download/ptau-hez-final-15/powersOfTau28_hez_final_15.ptau";
const PTAU_BLAKE2B =
  "982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a1" +
  "7b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e";

function blake2b512(file) {
  const h = crypto.createHash("blake2b512");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

const CIRCUITS = [
  "whitelist_membership",
  "blacklist_membership",
  "jurisdiction_proof",
  "accreditation_proof",
  "compliance_aggregation",
];

async function ensureDirectories() {
  console.log("📁 Creating build directories...");

  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  for (const circuit of CIRCUITS) {
    const circuitBuildDir = path.join(BUILD_DIR, circuit);
    if (!fs.existsSync(circuitBuildDir)) {
      fs.mkdirSync(circuitBuildDir, { recursive: true });
    }
  }
}

async function downloadPtau() {
  console.log("⬇️  Powers of Tau file...");

  if (fs.existsSync(PTAU_FILE)) {
    // A stale or truncated file here (e.g. a CI cache entry from a bad
    // download, or a different-power file copied in by hand) would make
    // every zkey silently wrong. Verify it like a fresh download.
    if (blake2b512(PTAU_FILE) === PTAU_BLAKE2B) {
      console.log("✅ Powers of Tau file present, hash verified");
      return;
    }
    console.log("⚠️  Existing Powers of Tau file has the wrong hash; replacing it");
    fs.unlinkSync(PTAU_FILE);
  }

  try {
    await execAsync(`curl -fL -o ${PTAU_FILE} ${PTAU_URL}`);
  } catch (error) {
    // Remove any partial download so a later run does not treat it as valid.
    if (fs.existsSync(PTAU_FILE)) fs.unlinkSync(PTAU_FILE);
    throw new Error(
      `Could not download the Powers of Tau file from ${PTAU_URL}\n` +
        `  ${error.message}\n` +
        `  A trusted setup file is required; there is no safe substitute.\n` +
        `  Download it manually to: ${PTAU_FILE}\n` +
        `  and check: b2sum must print ${PTAU_BLAKE2B}`,
    );
  }

  const got = blake2b512(PTAU_FILE);
  if (got !== PTAU_BLAKE2B) {
    fs.unlinkSync(PTAU_FILE);
    throw new Error(
      `Downloaded Powers of Tau file failed verification.\n` +
        `  expected BLAKE2b-512 ${PTAU_BLAKE2B}\n` +
        `  got                  ${got}\n` +
        `  The file was deleted. Do not proceed with an unverified trusted setup.`,
    );
  }
  console.log("✅ Powers of Tau file downloaded, hash verified");
}

/**
 * Resolve a circom 2.x binary.
 *
 * The circuits declare `pragma circom 2.0.0`, which only the Rust compiler
 * understands. The `circom` npm dependency is the deprecated 0.5.x JS
 * implementation and installs a shim at node_modules/.bin/circom. Because
 * `npm run` prepends node_modules/.bin to PATH, a bare `circom` resolves to
 * that 0.5.x shim under npm and to the Rust binary from a plain shell — the
 * same command then succeeds or fails depending on how it was launched.
 *
 * So: resolve a candidate, then verify its reported major version is 2.
 */
let cachedCircomBin = null;
async function resolveCircomBin() {
  if (cachedCircomBin) return cachedCircomBin;

  const candidates = process.env.CIRCOM_BIN
    ? [process.env.CIRCOM_BIN]
    : [
        path.join(process.env.HOME || "", ".cargo/bin/circom"),
        "/usr/local/bin/circom",
        "circom",
      ];

  const tried = [];
  for (const bin of candidates) {
    try {
      const { stdout } = await execAsync(`${bin} --version`);
      const version = stdout.trim();
      if (/\b2\.\d+\.\d+/.test(version)) {
        cachedCircomBin = bin;
        console.log(`🔎 Using circom: ${bin} (${version})`);
        return bin;
      }
      tried.push(`${bin} -> ${version} (not 2.x)`);
    } catch {
      tried.push(`${bin} -> not found`);
    }
  }

  throw new Error(
    `No circom 2.x compiler found. Tried:\n` +
      tried.map((t) => `    ${t}`).join("\n") +
      `\n  The circuits require Rust circom 2.x; the bundled npm circom 0.5.x cannot compile them.\n` +
      `  Install: https://docs.circom.io/getting-started/installation/\n` +
      `  Or set CIRCOM_BIN to the binary's path.`,
  );
}

async function compileCircuit(circuitName) {
  console.log(`🔧 Compiling ${circuitName} circuit...`);

  const circuitPath = path.join(CIRCUITS_DIR, `${circuitName}.circom`);
  const buildPath = path.join(BUILD_DIR, circuitName);

  const circomBin = await resolveCircomBin();
  const includeDir = path.join(__dirname, "../node_modules");

  try {
    await execAsync(
      `${circomBin} ${circuitPath} --r1cs --wasm --sym -o ${buildPath} -l ${includeDir}`,
    );
  } catch (error) {
    throw new Error(
      `Failed to compile ${circuitName}\n` +
        `  ${(error.stderr || error.message).trim()}\n` +
        `  circom binary: ${circomBin}`,
    );
  }

  // circom reports success via exit code, but verify the artifacts it must
  // have produced actually exist before downstream stages depend on them.
  const wasmPath = path.join(
    buildPath,
    `${circuitName}_js`,
    `${circuitName}.wasm`,
  );
  const r1csPath = path.join(buildPath, `${circuitName}.r1cs`);
  for (const [label, p] of [
    ["witness calculator (.wasm)", wasmPath],
    ["constraint system (.r1cs)", r1csPath],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `${circuitName}: circom exited 0 but did not produce the ${label} at ${p}`,
      );
    }
  }

  console.log(`✅ ${circuitName} circuit compiled`);
  return true;
}

async function generateKeys(circuitName) {
  console.log(`🔑 Generating keys for ${circuitName}...`);

  const buildPath = path.join(BUILD_DIR, circuitName);
  const r1csPath = path.join(buildPath, `${circuitName}.r1cs`);
  const zkeyPath = path.join(buildPath, `${circuitName}.zkey`);
  const vkeyPath = path.join(buildPath, `${circuitName}_vkey.json`);

  try {
    // Generate proving key
    await execAsync(
      `npx snarkjs groth16 setup ${r1csPath} ${PTAU_FILE} ${zkeyPath}`,
    );
    console.log(`✅ ${circuitName} proving key generated`);

    // Export verifying key
    await execAsync(
      `npx snarkjs zkey export verificationkey ${zkeyPath} ${vkeyPath}`,
    );
    console.log(`✅ ${circuitName} verifying key exported`);

    return true;
  } catch (error) {
    throw new Error(
      `Failed to generate keys for ${circuitName}\n` +
        `  ${(error.stderr || error.message).trim()}\n` +
        `  Proving/verifying keys cannot be faked — a mock key accepts invalid proofs.`,
    );
  }
}

async function generateSolidityVerifier(circuitName) {
  console.log(`📜 Generating Solidity verifier for ${circuitName}...`);

  const buildPath = path.join(BUILD_DIR, circuitName);
  const zkeyPath = path.join(buildPath, `${circuitName}.zkey`);
  const verifierPath = path.join(
    __dirname,
    "../contracts/privacy/verifiers",
    `${circuitName}Verifier.sol`,
  );

  // Ensure verifiers directory exists
  const verifiersDir = path.dirname(verifierPath);
  if (!fs.existsSync(verifiersDir)) {
    fs.mkdirSync(verifiersDir, { recursive: true });
  }

  try {
    // Generate Solidity verifier
    await execAsync(
      `npx snarkjs zkey export solidityverifier ${zkeyPath} ${verifierPath}`,
    );

    // Rename the contract to avoid naming conflicts
    // snarkjs generates all verifiers with the same name "Groth16Verifier"
    let verifierContent = fs.readFileSync(verifierPath, "utf8");
    const contractName =
      circuitName
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("") + "Verifier";

    verifierContent = verifierContent.replace(
      /contract Groth16Verifier/g,
      `contract ${contractName}`,
    );

    fs.writeFileSync(verifierPath, verifierContent);
    console.log(
      `✅ ${circuitName} Solidity verifier generated (${contractName})`,
    );
    return true;
  } catch (error) {
    // Never write a placeholder here: this path targets contracts/privacy/verifiers/,
    // which holds the committed on-chain verifiers. A stub written here would
    // silently replace a real verifier with one that accepts invalid proofs.
    throw new Error(
      `Failed to generate Solidity verifier for ${circuitName}\n` +
        `  ${(error.stderr || error.message).trim()}\n` +
        `  Left ${verifierPath} untouched.`,
    );
  }
}

async function generateCircuitInfo() {
  console.log("📊 Generating circuit information...");

  const circuitInfo = {
    circuits: {},
    buildTimestamp: new Date().toISOString(),
    version: "1.0.0",
  };

  for (const circuitName of CIRCUITS) {
    const buildPath = path.join(BUILD_DIR, circuitName);
    const vkeyPath = path.join(buildPath, `${circuitName}_vkey.json`);

    let vkey = null;
    if (fs.existsSync(vkeyPath)) {
      try {
        vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
      } catch (error) {
        console.log(`⚠️  Could not parse verifying key for ${circuitName}`);
      }
    }

    circuitInfo.circuits[circuitName] = {
      id: `keccak256("${circuitName.toUpperCase().replace("_", "_")}")`,
      name: circuitName,
      description: getCircuitDescription(circuitName),
      verifyingKey: vkey,
      buildPath: buildPath,
      hasVerifier: fs.existsSync(
        path.join(
          __dirname,
          "../contracts/privacy/verifiers",
          `${circuitName}Verifier.sol`,
        ),
      ),
    };
  }

  const infoPath = path.join(BUILD_DIR, "circuit-info.json");
  fs.writeFileSync(infoPath, JSON.stringify(circuitInfo, null, 2));
  console.log(`✅ Circuit information saved to ${infoPath}`);
}

function getCircuitDescription(circuitName) {
  const descriptions = {
    whitelist_membership:
      "Proves membership in a whitelist without revealing identity",
    jurisdiction_proof:
      "Proves jurisdiction eligibility without revealing location",
    accreditation_proof:
      "Proves accreditation level meets requirements without revealing exact level",
    compliance_aggregation:
      "Proves overall compliance score meets requirements without revealing individual scores",
  };

  return descriptions[circuitName] || "ZK proof circuit";
}

async function main() {
  console.log("🚀 Setting up ZK circuits for CMTA UTXO Compliance POC");
  console.log("=".repeat(60));

  try {
    // Setup
    await ensureDirectories();
    await downloadPtau();

    // Process each circuit. Any failure aborts the run: a partial setup that
    // reports success is worse than no setup at all.
    for (const circuitName of CIRCUITS) {
      console.log(`\n🔄 Processing ${circuitName}...`);

      await compileCircuit(circuitName);
      await generateKeys(circuitName);
      await generateSolidityVerifier(circuitName);

      console.log(`✅ ${circuitName} setup completed successfully`);
    }

    // Generate circuit info
    await generateCircuitInfo();

    console.log("\n🎉 ZK circuit setup completed!");
    console.log("\n📋 Summary:");
    console.log(
      `   • ${CIRCUITS.length} circuits compiled with real artifacts`,
    );
    console.log(`   • Build directory: ${BUILD_DIR}`);
    console.log(`   • Verifier contracts: contracts/privacy/verifiers/`);
  } catch (error) {
    console.error(`\n❌ ZK circuit setup FAILED\n\n${error.message}\n`);
    console.error(
      "No mock or placeholder files were written. Fix the cause and re-run.",
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CIRCUITS,
  BUILD_DIR,
  compileCircuit,
  generateKeys,
  generateSolidityVerifier,
};
