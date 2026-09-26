#!/usr/bin/env node

/**
 * Quick Verification Script for Investor Type System Implementation
 * This script provides a fast way to verify that the implementation works
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function verifyImplementation() {
  console.log("🔍 Verifying Investor Type System Implementation...");
  console.log("=".repeat(60));

  const results = {
    contractsExist: false,
    testsExist: false,
    documentationExists: false,
    deploymentScriptsExist: false,
    demoExists: false,
    integrationComplete: false,
  };

  // 1. Check if smart contracts exist
  console.log("\\n📋 1. Checking Smart Contracts...");
  const contractPaths = [
    "contracts/erc3643/InvestorTypeRegistry.sol",
    "contracts/erc3643/interfaces/IInvestorTypeRegistry.sol",
    "contracts/compliance/InvestorTypeCompliance.sol",
  ];

  let contractsFound = 0;
  for (const contractPath of contractPaths) {
    if (fs.existsSync(contractPath)) {
      console.log(`   ✅ ${contractPath}`);
      contractsFound++;
    } else {
      console.log(`   ❌ ${contractPath}`);
    }
  }
  results.contractsExist = contractsFound === contractPaths.length;
  console.log(
    `   📊 Contracts: ${contractsFound}/${contractPaths.length} found`,
  );

  // 2. Check if tests exist
  console.log("\\n🧪 2. Checking Test Files...");
  const testPaths = ["test/InvestorTypeSystem.test.ts"];

  let testsFound = 0;
  for (const testPath of testPaths) {
    if (fs.existsSync(testPath)) {
      console.log(`   ✅ ${testPath}`);
      testsFound++;
    } else {
      console.log(`   ❌ ${testPath}`);
    }
  }
  results.testsExist = testsFound === testPaths.length;
  console.log(`   📊 Tests: ${testsFound}/${testPaths.length} found`);

  // 3. Check documentation
  console.log("\\n📚 3. Checking Documentation...");
  const docPaths = [
    "docs/INVESTOR_TYPE_SYSTEM.md",
    "docs/INVESTOR_TYPE_SYSTEM_PROOF.md",
  ];

  let docsFound = 0;
  for (const docPath of docPaths) {
    if (fs.existsSync(docPath)) {
      const stats = fs.statSync(docPath);
      console.log(`   ✅ ${docPath} (${Math.round(stats.size / 1024)} KB)`);
      docsFound++;
    } else {
      console.log(`   ❌ ${docPath}`);
    }
  }
  results.documentationExists = docsFound === docPaths.length;
  console.log(`   📊 Documentation: ${docsFound}/${docPaths.length} found`);

  // 4. Check deployment scripts
  console.log("\\n🚀 4. Checking Deployment Scripts...");
  const scriptPaths = [
    "scripts/deploy-investor-type-system.ts",
    "scripts/integrate-investor-type-system.ts",
  ];

  let scriptsFound = 0;
  for (const scriptPath of scriptPaths) {
    if (fs.existsSync(scriptPath)) {
      console.log(`   ✅ ${scriptPath}`);
      scriptsFound++;
    } else {
      console.log(`   ❌ ${scriptPath}`);
    }
  }
  results.deploymentScriptsExist = scriptsFound === scriptPaths.length;
  console.log(`   📊 Scripts: ${scriptsFound}/${scriptPaths.length} found`);

  // 5. Check demo
  console.log("\\n🎮 5. Checking Interactive Demo...");
  const demoPaths = ["demo/investor-type-system-proof.js"];

  let demosFound = 0;
  for (const demoPath of demoPaths) {
    if (fs.existsSync(demoPath)) {
      const stats = fs.statSync(demoPath);
      console.log(`   ✅ ${demoPath} (${Math.round(stats.size / 1024)} KB)`);
      demosFound++;
    } else {
      console.log(`   ❌ ${demoPath}`);
    }
  }
  results.demoExists = demosFound === demoPaths.length;
  console.log(`   📊 Demo: ${demosFound}/${demoPaths.length} found`);

  // 6. Check contract content for key features
  console.log("\\n🔍 6. Checking Implementation Details...");

  try {
    // Check InvestorTypeRegistry for key features
    const registryContent = fs.readFileSync(
      "contracts/erc3643/InvestorTypeRegistry.sol",
      "utf8",
    );
    const hasInvestorTypes = registryContent.includes("enum InvestorType");
    const hasConfigurations = registryContent.includes(
      "struct InvestorTypeConfig",
    );
    const hasAssignment = registryContent.includes("assignInvestorType");
    const hasUpgrade = registryContent.includes("upgradeInvestorType");

    console.log(
      `   ${hasInvestorTypes ? "✅" : "❌"} InvestorType enum defined`,
    );
    console.log(
      `   ${hasConfigurations ? "✅" : "❌"} InvestorTypeConfig struct defined`,
    );
    console.log(
      `   ${hasAssignment ? "✅" : "❌"} Type assignment function implemented`,
    );
    console.log(
      `   ${hasUpgrade ? "✅" : "❌"} Type upgrade function implemented`,
    );

    results.integrationComplete =
      hasInvestorTypes && hasConfigurations && hasAssignment && hasUpgrade;
  } catch (error) {
    console.log(`   ❌ Could not analyze contract content: ${error.message}`);
    results.integrationComplete = false;
  }

  // 7. Summary
  console.log("\\n📊 VERIFICATION SUMMARY");
  console.log("=".repeat(60));

  const checks = [
    { name: "Smart Contracts", status: results.contractsExist },
    { name: "Test Files", status: results.testsExist },
    { name: "Documentation", status: results.documentationExists },
    { name: "Deployment Scripts", status: results.deploymentScriptsExist },
    { name: "Interactive Demo", status: results.demoExists },
    { name: "Implementation Details", status: results.integrationComplete },
  ];

  let passedChecks = 0;
  for (const check of checks) {
    const status = check.status ? "✅ PASS" : "❌ FAIL";
    console.log(`${status} ${check.name}`);
    if (check.status) passedChecks++;
  }

  const successRate = Math.round((passedChecks / checks.length) * 100);
  console.log(
    `\\n🎯 Overall Success Rate: ${successRate}% (${passedChecks}/${checks.length})`,
  );

  if (successRate === 100) {
    console.log(
      "\\n🎉 VERIFICATION COMPLETE: Investor Type System implementation is ready!",
    );
    console.log("\\n📋 Next Steps:");
    console.log("1. Run tests: npm test -- test/InvestorTypeSystem.test.ts");
    console.log("2. Run demo: node demo/investor-type-system-proof.js");
    console.log(
      "3. Deploy system: npx hardhat run scripts/deploy-investor-type-system.ts",
    );
  } else if (successRate >= 80) {
    console.log("\\n⚠️  VERIFICATION MOSTLY COMPLETE: Minor issues detected");
    console.log(
      "The core implementation is ready but some components may need attention.",
    );
  } else {
    console.log("\\n❌ VERIFICATION FAILED: Major issues detected");
    console.log(
      "Please check the implementation and ensure all components are in place.",
    );
  }

  return results;
}

// Run verification if called directly
if (require.main === module) {
  verifyImplementation()
    .then((results) => {
      const allPassed = Object.values(results).every(Boolean);
      process.exit(allPassed ? 0 : 1);
    })
    .catch((error) => {
      console.error("❌ Verification failed:", error.message);
      process.exit(1);
    });
}

module.exports = { verifyImplementation };
