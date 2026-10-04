const { RealProofGenerator } = require("./generate-real-proofs");

async function main() {
  console.log("\n🧪 Testing Real Proof Generation for All 5 Circuits\n");

  const generator = new RealProofGenerator();
  await generator.initialize();

  const results = {
    passed: 0,
    failed: 0,
    tests: [],
  };

  // Test 1: Whitelist Proof
  try {
    console.log("1️⃣  Testing Whitelist Proof...");
    const startTime = Date.now();

    const whitelistResult = await generator.generateWhitelistProof({
      identity: 12345n,
      // Demo secret; a real investor keeps a random one off-chain.
      secret: 202n,
      members: [
        { identity: 11111n, secret: 101n },
        { identity: 12345n, secret: 202n },
        { identity: 33333n, secret: 303n },
      ],
      // Placeholder wallet; a real caller binds the submitting address.
      walletBinding: "0x000000000000000000000000000000000000dEaD",
    });

    const duration = Date.now() - startTime;
    console.log(`   ✅ PASSED - Generated in ${duration}ms`);
    console.log(
      `   📊 Public signals: ${whitelistResult.publicSignals.length}`,
    );
    results.passed++;
    results.tests.push({ name: "Whitelist", status: "PASSED", duration });
  } catch (error) {
    console.log(`   ❌ FAILED - ${error.message}`);
    results.failed++;
    results.tests.push({
      name: "Whitelist",
      status: "FAILED",
      error: error.message,
    });
  }

  // Test 2: Blacklist Proof
  try {
    console.log("\n2️⃣  Testing Blacklist Proof...");
    const startTime = Date.now();

    // A whitelisted commitment whose identity is not on the sanctions list.
    const blacklistResult = await generator.generateBlacklistProof({
      identity: 12345n,
      secret: 202n,
      members: [
        { identity: 11111n, secret: 101n },
        { identity: 12345n, secret: 202n },
      ],
      blacklistIdentities: [BigInt(11111), BigInt(22222)],
      walletBinding: "0x000000000000000000000000000000000000dEaD",
    });

    const duration = Date.now() - startTime;
    console.log(`   ✅ PASSED - Generated in ${duration}ms`);
    console.log(
      `   📊 Public signals: ${blacklistResult.publicSignals.length}`,
    );
    results.passed++;
    results.tests.push({ name: "Blacklist", status: "PASSED", duration });
  } catch (error) {
    console.log(`   ❌ FAILED - ${error.message}`);
    results.failed++;
    results.tests.push({
      name: "Blacklist",
      status: "FAILED",
      error: error.message,
    });
  }

  // Tests 3-5: the attestation circuits (Task 3.7b, D31 a). A throwaway
  // issuer key signs; the proofs carry the issuer's (Ax, Ay) and the policy.
  const { signAttestation, newAttestorKey } = require("./zk/attest");
  const key = newAttestorKey();
  const sig = (a) => ({
    identity: a.identity,
    salt: a.salt,
    R8x: a.R8x,
    R8y: a.R8y,
    S: a.S,
    Ax: a.Ax,
    Ay: a.Ay,
    chainId: a.chainId,
    verifierContext: BigInt(a.privacyManager),
    validUntil: a.validUntil,
    walletBinding: "0x000000000000000000000000000000000000dEaD",
  });
  const attestationCases = [
    [
      "Jurisdiction",
      async () => {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "jurisdiction",
          identity: 12345n,
          mask: 1,
        });
        return generator.generateJurisdictionProof({
          ...sig(a),
          mask: 1n,
          allowedMask: 15n, // four registered codes, all allowed
        });
      },
    ],
    [
      "Accreditation",
      async () => {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "accreditation",
          identity: 12345n,
          amount: 250000,
        });
        return generator.generateAccreditationProof({
          ...sig(a),
          amount: 250000n,
          minimumAccreditation: 100000n,
        });
      },
    ],
    [
      "Compliance",
      async () => {
        const a = await signAttestation({
          key,
          chainId: 31337,
          privacyManager: "0x" + "11".repeat(20),
          validUntil,
          circuit: "compliance",
          identity: 12345n,
          scores: [80, 75, 85, 70],
        });
        // Weighted (80+75+85+70)*25 = 7750 >= 70 * 100.
        return generator.generateComplianceProof({
          ...sig(a),
          scores: a.attributes,
          minimum: 70n,
          weights: [25n, 25n, 25n, 25n],
        });
      },
    ],
  ];
  for (const [k, [name, prove]] of attestationCases.entries()) {
    try {
      console.log(`\n${k + 3}️⃣  Testing ${name} Proof...`);
      const startTime = Date.now();
      const r = await prove();
      const duration = Date.now() - startTime;
      console.log(`   ✅ PASSED - Generated in ${duration}ms`);
      console.log(`   📊 Public signals: ${r.publicSignals.length}`);
      results.passed++;
      results.tests.push({ name, status: "PASSED", duration });
    } catch (error) {
      console.log(`   ❌ FAILED - ${error.message}`);
      results.failed++;
      results.tests.push({ name, status: "FAILED", error: error.message });
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`✅ Passed: ${results.passed}/5`);
  console.log(`❌ Failed: ${results.failed}/5`);
  console.log("\nDetailed Results:");
  results.tests.forEach((test, i) => {
    const icon = test.status === "PASSED" ? "✅" : "❌";
    const info = test.status === "PASSED" ? `${test.duration}ms` : test.error;
    console.log(`  ${i + 1}. ${icon} ${test.name}: ${info}`);
  });
  console.log("=".repeat(60));

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
