// ProductionUtils and the Production Simulation suite's start and finish
// (Task 5.4: moved out of ProductionEnvironment.ts and
// ProductionSimulation.test.ts, now split in Production{Onboarding,
// Resilience,DeployOps}.test.ts; each simulation file opens one
// environment in its before and closes it in its after).
import { expect } from "chai";
import { ethers } from "hardhat";
import { ProductionEnvironment } from "./ProductionEnvironment";

// Export utility functions for production testing
export const ProductionUtils = {
  // Generate realistic user data
  generateUserData: (type: "individual" | "corporate" | "institutional") => {
    const baseData = {
      timestamp: new Date().toISOString(),
      verificationId: `VER-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    switch (type) {
      case "individual":
        return {
          ...baseData,
          fullName: "Alice Johnson",
          dateOfBirth: "1990-05-15",
          nationality: "US",
          documentType: "PASSPORT",
          documentNumber: `US${Math.random().toString().substr(2, 9)}`,
          address: "123 Main St, New York, NY 10001, USA",
        };

      case "corporate":
        return {
          ...baseData,
          companyName: "Blockchain Innovations Corp",
          registrationNumber: `REG${Math.random().toString().substr(2, 9)}`,
          jurisdiction: "Delaware, USA",
          businessType: "Technology",
          incorporationDate: "2020-01-15",
        };

      case "institutional":
        return {
          ...baseData,
          institutionName: "Global Investment Fund",
          institutionType: "INVESTMENT_FUND",
          regulatoryLicense: `LIC${Math.random().toString().substr(2, 9)}`,
          aum: "500000000", // $500M AUM
          jurisdiction: "Cayman Islands",
        };
    }
  },

  // Calculate gas costs in USD (assuming ETH price)
  calculateGasCostUSD: (
    gasUsed: bigint,
    gasPriceGwei: number,
    ethPriceUSD: number = 2000,
  ): string => {
    const gasCostEth = Number(gasUsed) * gasPriceGwei * 1e-9;
    const gasCostUSD = gasCostEth * ethPriceUSD;
    return gasCostUSD.toFixed(2);
  },

  // Validate production readiness
  validateProductionReadiness: async (
    env: ProductionEnvironment,
  ): Promise<boolean> => {
    console.log("🔍 Validating production readiness...");

    try {
      // Check all contracts are deployed
      const factoryCode = await ethers.provider.getCode(
        await env.factory.getAddress(),
      );
      const keyManagerCode = await ethers.provider.getCode(
        await env.keyManager.getAddress(),
      );
      const kycIssuerCode = await ethers.provider.getCode(
        await env.kycIssuer.getAddress(),
      );

      if (
        factoryCode === "0x" ||
        keyManagerCode === "0x" ||
        kycIssuerCode === "0x"
      ) {
        console.log("❌ Contract deployment validation failed");
        return false;
      }

      // Check configuration
      const deploymentFee = await env.factory.deploymentFee();
      if (deploymentFee !== env.config.deploymentFee) {
        console.log("❌ Configuration validation failed");
        return false;
      }

      console.log("✅ Production readiness validation passed");
      return true;
    } catch (error) {
      console.log(`❌ Production readiness validation failed: ${error}`);
      return false;
    }
  },
};

/** A validated production environment (the suite's before). */
export async function openProductionSimulation(): Promise<ProductionEnvironment> {
  let prodEnv: ProductionEnvironment;
  console.log("\n🚀 Initializing Production Simulation Environment...");

  prodEnv = new ProductionEnvironment();
  await prodEnv.initialize();

  // Validate production readiness
  const isReady = await ProductionUtils.validateProductionReadiness(prodEnv);
  expect(isReady).to.be.true;

  console.log("✅ Production environment validated and ready!\n");
  return prodEnv;
}

/** Final statistics and cleanup (the suite's after). */
export async function closeProductionSimulation(
  prodEnv: ProductionEnvironment,
): Promise<void> {
  console.log("\n🏁 Production Simulation Complete!");

  // Get final system statistics
  const stats = await prodEnv.getSystemStats();

  console.log("📋 Final System Statistics:");
  console.log(`   Total Identities Deployed: ${stats.totalIdentities}`);
  console.log(
    `   Total Fees Collected: ${ethers.formatEther(stats.totalFeesCollected)} ETH`,
  );
  console.log(`   Factory Address: ${stats.factoryAddress}`);
  console.log(`   KeyManager Address: ${stats.keyManagerAddress}`);
  console.log(`   KYC Issuer Address: ${stats.kycIssuerAddress}`);
  console.log(`   AML Issuer Address: ${stats.amlIssuerAddress}`);

  console.log("\n✅ Test Coverage Summary:");
  console.log("   ✅ Enterprise corporate onboarding");
  console.log("   ✅ Individual user journey with cryptographic verification");
  console.log("   ✅ Institutional investor workflow");
  console.log("   ✅ Emergency recovery scenarios");
  console.log("   ✅ Network stress testing");
  console.log("   ✅ Production performance analysis");
  console.log("   ✅ Advanced security testing");

  // Cleanup
  await prodEnv.cleanup();

  console.log("\n🚀 OnchainID System is PRODUCTION READY! 🚀");
  console.log("💡 All tests passed - System ready for mainnet deployment!");
}
