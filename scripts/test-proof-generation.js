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
      identity: BigInt(12345),
      whitelistIdentities: [BigInt(11111), BigInt(12345), BigInt(33333)],
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

    const blacklistResult = await generator.generateBlacklistProof({
      identity: BigInt(12345),
      blacklistIdentities: [BigInt(11111), BigInt(22222)],
      challengeHash: BigInt(999),
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

  // Test 3: Jurisdiction Proof
  try {
    console.log("\n3️⃣  Testing Jurisdiction Proof...");
    const startTime = Date.now();

    const jurisdictionResult = await generator.generateJurisdictionProof({
      userJurisdiction: BigInt(1),
      allowedJurisdictions: [BigInt(1), BigInt(2), BigInt(3)],
    });

    const duration = Date.now() - startTime;
    console.log(`   ✅ PASSED - Generated in ${duration}ms`);
    console.log(
      `   📊 Public signals: ${jurisdictionResult.publicSignals.length}`,
    );
    results.passed++;
    results.tests.push({ name: "Jurisdiction", status: "PASSED", duration });
  } catch (error) {
    console.log(`   ❌ FAILED - ${error.message}`);
    results.failed++;
    results.tests.push({
      name: "Jurisdiction",
      status: "FAILED",
      error: error.message,
    });
  }

  // Test 4: Accreditation Proof
  try {
    console.log("\n4️⃣  Testing Accreditation Proof...");
    const startTime = Date.now();

    const accreditationResult = await generator.generateAccreditationProof({
      accreditationLevel: BigInt(5),
      minimumLevel: BigInt(3),
    });

    const duration = Date.now() - startTime;
    console.log(`   ✅ PASSED - Generated in ${duration}ms`);
    console.log(
      `   📊 Public signals: ${accreditationResult.publicSignals.length}`,
    );
    results.passed++;
    results.tests.push({ name: "Accreditation", status: "PASSED", duration });
  } catch (error) {
    console.log(`   ❌ FAILED - ${error.message}`);
    results.failed++;
    results.tests.push({
      name: "Accreditation",
      status: "FAILED",
      error: error.message,
    });
  }

  // Test 5: Compliance Proof
  try {
    console.log("\n5️⃣  Testing Compliance Proof...");
    const startTime = Date.now();

    // Use smaller values to avoid circuit constraints
    // Circuit divides weighted sum by 100
    const complianceResult = await generator.generateComplianceProof({
      kycScore: BigInt(80),
      amlScore: BigInt(75),
      jurisdictionScore: BigInt(85),
      accreditationScore: BigInt(70),
      weightKyc: BigInt(25),
      weightAml: BigInt(25),
      weightJurisdiction: BigInt(25),
      weightAccreditation: BigInt(25),
      minimumComplianceLevel: BigInt(70), // After division: (80*25+75*25+85*25+70*25)/100 = 77.5
    });

    const duration = Date.now() - startTime;
    console.log(`   ✅ PASSED - Generated in ${duration}ms`);
    console.log(
      `   📊 Public signals: ${complianceResult.publicSignals.length}`,
    );
    results.passed++;
    results.tests.push({ name: "Compliance", status: "PASSED", duration });
  } catch (error) {
    console.log(`   ❌ FAILED - ${error.message}`);
    results.failed++;
    results.tests.push({
      name: "Compliance",
      status: "FAILED",
      error: error.message,
    });
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
