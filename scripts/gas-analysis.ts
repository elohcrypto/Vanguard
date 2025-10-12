import { ethers } from "hardhat";

async function main() {
    console.log("⛽ Gas Analysis for CMTA UTXO Compliance POC");
    console.log("=".repeat(50));

    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    const feeData = await ethers.provider.getFeeData();

    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Gas Price: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} gwei`);
    console.log(`Max Fee: ${ethers.formatUnits(feeData.maxFeePerGas || 0n, "gwei")} gwei`);
    console.log(`Priority Fee: ${ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, "gwei")} gwei`);

    // Gas estimates for different operations
    const gasEstimates = {
        "Simple Transfer": 21000,
        "ERC20 Transfer": 65000,
        "OnchainID Creation": 500000,
        "Claim Addition": 150000,
        "ERC-3643 Transfer": 200000,
        "Oracle Consensus": 100000,
        "ZK Proof Verification": 300000,
        "UTXO Compliance Check": 80000,
    };

    console.log("\n📊 Estimated Gas Costs:");
    console.log("-".repeat(50));

    const gasPrice = feeData.gasPrice || 0n;
    const ethPrice = 2000; // Approximate ETH price in USD

    for (const [operation, gasLimit] of Object.entries(gasEstimates)) {
        const gasCost = gasPrice * BigInt(gasLimit);
        const ethCost = parseFloat(ethers.formatEther(gasCost));
        const usdCost = ethCost * ethPrice;

        console.log(`${operation.padEnd(25)} | ${gasLimit.toString().padStart(8)} gas | ${ethCost.toFixed(6)} ETH | $${usdCost.toFixed(2)}`);
    }

    // Deployment cost estimates
    console.log("\n🚀 Estimated Deployment Costs:");
    console.log("-".repeat(50));

    const deploymentEstimates = {
        "OnchainID Factory": 2000000,
        "OnchainID Contract": 1500000,
        "ERC-3643 Token": 3000000,
        "Identity Registry": 1200000,
        "Oracle Manager": 1800000,
        "UTXO Compliance": 2500000,
        "ZK Verifier": 1000000,
    };

    let totalDeploymentGas = 0;
    for (const [contract, gasLimit] of Object.entries(deploymentEstimates)) {
        const gasCost = gasPrice * BigInt(gasLimit);
        const ethCost = parseFloat(ethers.formatEther(gasCost));
        const usdCost = ethCost * ethPrice;

        totalDeploymentGas += gasLimit;
        console.log(`${contract.padEnd(25)} | ${gasLimit.toString().padStart(8)} gas | ${ethCost.toFixed(6)} ETH | $${usdCost.toFixed(2)}`);
    }

    const totalGasCost = gasPrice * BigInt(totalDeploymentGas);
    const totalEthCost = parseFloat(ethers.formatEther(totalGasCost));
    const totalUsdCost = totalEthCost * ethPrice;

    console.log("-".repeat(50));
    console.log(`${"TOTAL DEPLOYMENT".padEnd(25)} | ${totalDeploymentGas.toString().padStart(8)} gas | ${totalEthCost.toFixed(6)} ETH | $${totalUsdCost.toFixed(2)}`);

    console.log("\n💡 Gas Optimization Tips:");
    console.log("- Use batch operations where possible");
    console.log("- Optimize storage layouts");
    console.log("- Consider proxy patterns for upgradeable contracts");
    console.log("- Use events instead of storage for non-critical data");
    console.log("- Implement efficient data structures");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Gas analysis failed:", error);
        process.exit(1);
    });