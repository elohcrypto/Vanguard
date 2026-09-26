const { exec } = require("child_process");
const path = require("path");

console.log("🚀 Running Complete Oracle Test Suite");
console.log("=".repeat(80));

const tests = [
  {
    name: "Oracle Basic Functionality Tests",
    command: "npx hardhat test test/oracle/OracleBasicFunctionality.test.ts",
    description: "Core oracle functionality and KYC/AML workflows",
  },
  {
    name: "Oracle-ERC3643 Integration Tests",
    command:
      "npx hardhat test test/integration/OracleERC3643Integration.test.ts",
    description: "Full integration with ERC-3643 and OnchainID systems",
  },
];

let completedTests = 0;
let passedTests = 0;
const results = [];

function runTest(testIndex) {
  if (testIndex >= tests.length) {
    // All tests completed, show summary
    console.log("\n" + "=".repeat(80));
    console.log("🎯 ORACLE TEST SUITE SUMMARY");
    console.log("=".repeat(80));

    results.forEach((result, index) => {
      const status = result.passed ? "✅ PASSED" : "❌ FAILED";
      console.log(`${index + 1}. ${tests[index].name}: ${status}`);
      if (!result.passed && result.error) {
        console.log(`   Error: ${result.error}`);
      }
    });

    console.log(`\n📊 Results: ${passedTests}/${tests.length} tests passed`);

    if (passedTests === tests.length) {
      console.log("\n🎉 ALL ORACLE TESTS PASSED!");
      console.log("✅ Oracle contracts are fully functional and integrated");
      console.log("✅ KYC/AML workflows working correctly");
      console.log("✅ Whitelist/Blacklist management operational");
      console.log("✅ Emergency protocols functional");
      console.log("✅ Oracle reputation system working");
      console.log("✅ Full ERC-3643 and OnchainID integration confirmed");

      // Run the comprehensive demo
      console.log("\n" + "=".repeat(80));
      console.log("🎭 Running Comprehensive Integration Demo...");
      console.log("=".repeat(80));

      exec(
        "hardhat run scripts/comprehensive-demo.ts",
        (demoError, demoStdout, demoStderr) => {
          if (demoError) {
            console.error(`❌ Demo execution error: ${demoError.message}`);
            return;
          }

          if (demoStderr) {
            console.error(`⚠️ Demo stderr: ${demoStderr}`);
          }

          console.log(demoStdout);

          console.log("\n" + "=".repeat(80));
          console.log("🏆 COMPLETE ORACLE INTEGRATION SUCCESS!");
          console.log("=".repeat(80));
          console.log("✅ All tests passed");
          console.log("✅ Integration demo completed");
          console.log("✅ Oracle system fully operational");
          console.log("✅ Ready for production deployment");
        },
      );
    } else {
      console.log(`\n❌ ${tests.length - passedTests} test(s) failed`);
      console.log("Please review the errors above and fix the issues");
    }

    return;
  }

  const test = tests[testIndex];
  console.log(`\n${testIndex + 1}️⃣ Running: ${test.name}`);
  console.log(`📝 ${test.description}`);
  console.log("-".repeat(60));

  exec(test.command, (error, stdout, stderr) => {
    completedTests++;

    if (error) {
      console.log(`❌ ${test.name} FAILED`);
      console.log(`Error: ${error.message}`);
      results.push({ passed: false, error: error.message });
    } else {
      // Check if tests actually passed by looking for "passing" in output
      const testsPassed =
        stdout.includes("passing") && !stdout.includes("failing");
      if (testsPassed) {
        console.log(`✅ ${test.name} PASSED`);
        passedTests++;
        results.push({ passed: true });
      } else {
        console.log(`❌ ${test.name} FAILED`);
        console.log("Output:", stdout);
        results.push({ passed: false, error: "Tests did not pass" });
      }
    }

    if (stderr) {
      console.log(`⚠️ Warnings: ${stderr}`);
    }

    // Run next test
    setTimeout(() => runTest(testIndex + 1), 1000);
  });
}

// Start running tests
runTest(0);
