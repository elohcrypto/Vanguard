import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("🔍 Validating CMTA UTXO Compliance POC Setup");
  console.log("=".repeat(50));

  let allChecks = true;

  // Check 1: Directory structure
  console.log("\n📁 Checking directory structure...");
  const requiredDirs = [
    "contracts/onchain_id",
    "contracts/erc3643",
    "contracts/oracle",
    "contracts/compliance",
    "contracts/privacy",
    "contracts/test",
    "contracts/migrations",
    "test",
    "scripts",
  ];

  for (const dir of requiredDirs) {
    if (fs.existsSync(dir)) {
      console.log(`   ✅ ${dir}`);
    } else {
      console.log(`   ❌ ${dir} - MISSING`);
      allChecks = false;
    }
  }

  // Check 2: Configuration files
  console.log("\n⚙️  Checking configuration files...");
  const requiredFiles = [
    "package.json",
    "hardhat.config.ts",
    "tsconfig.json",
    "foundry.toml",
    ".env.example",
    ".solhint.json",
    ".prettierrc",
    ".gitignore",
  ];

  for (const file of requiredFiles) {
    if (fs.existsSync(file)) {
      console.log(`   ✅ ${file}`);
    } else {
      console.log(`   ❌ ${file} - MISSING`);
      allChecks = false;
    }
  }

  // Check 3: Node modules
  console.log("\n📦 Checking dependencies...");
  if (fs.existsSync("node_modules")) {
    console.log("   ✅ node_modules installed");

    // Check key dependencies
    const keyDeps = ["hardhat", "@openzeppelin/contracts", "ethers", "chai"];

    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const dep of keyDeps) {
      if (allDeps[dep]) {
        console.log(`   ✅ ${dep} (${allDeps[dep]})`);
      } else {
        console.log(`   ❌ ${dep} - MISSING`);
        allChecks = false;
      }
    }
  } else {
    console.log("   ❌ node_modules - Run 'npm install'");
    allChecks = false;
  }

  // Check 4: Network connectivity
  console.log("\n🌐 Checking network connectivity...");
  try {
    const network = await ethers.provider.getNetwork();
    console.log(
      `   ✅ Connected to ${network.name} (Chain ID: ${network.chainId})`,
    );

    const [deployer] = await ethers.getSigners();
    const balance = await deployer.provider.getBalance(deployer.address);
    console.log(`   ✅ Deployer address: ${deployer.address}`);
    console.log(`   ✅ Deployer balance: ${ethers.formatEther(balance)} ETH`);
  } catch (error) {
    console.log(`   ❌ Network connection failed: ${error}`);
    allChecks = false;
  }

  // Check 5: Compilation
  console.log("\n🔨 Checking compilation...");
  try {
    const hre = require("hardhat");
    await hre.run("compile");
    console.log("   ✅ Contracts compile successfully");
  } catch (error) {
    console.log(`   ❌ Compilation failed: ${error}`);
    allChecks = false;
  }

  // Check 6: Testing framework
  console.log("\n🧪 Checking testing framework...");
  try {
    // Check if test files exist
    if (fs.existsSync("test/Setup.test.ts")) {
      console.log("   ✅ Test files present");
    } else {
      console.log("   ❌ Test files missing");
      allChecks = false;
    }

    // Check if we can run a simple test
    console.log("   ℹ️  Run 'npm test' to verify testing framework");
  } catch (error) {
    console.log(`   ❌ Testing framework check failed: ${error}`);
    allChecks = false;
  }

  // Final result
  console.log("\n" + "=".repeat(50));
  if (allChecks) {
    console.log("🎉 Setup validation PASSED!");
    console.log("✅ Your CMTA UTXO Compliance POC environment is ready!");
    console.log("\n📋 Next steps:");
    console.log("   1. Run 'npm test' to verify everything works");
    console.log("   2. Start implementing Task 2: OnchainID contracts");
    console.log("   3. Follow the implementation plan in tasks.md");
  } else {
    console.log("❌ Setup validation FAILED!");
    console.log("🔧 Please fix the issues above before proceeding");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Setup validation failed:", error);
    process.exit(1);
  });
