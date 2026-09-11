import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
    const networkName = network.name;
    const deploymentsPath = path.join(__dirname, "..", "deployments", `${networkName}.json`);

    if (!fs.existsSync(deploymentsPath)) {
        console.error(`❌ No deployment file found for network: ${networkName}`);
        console.error(`   Expected file: ${deploymentsPath}`);
        process.exit(1);
    }

    const deploymentData = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    console.log(`🔍 Verifying contracts on ${networkName}...`);

    for (const [contractName, contractInfo] of Object.entries(deploymentData.contracts)) {
        const info = contractInfo as { address: string };
        console.log(`\n📋 Verifying ${contractName} at ${info.address}...`);

        try {
            await run("verify:verify", {
                address: info.address,
                constructorArguments: [], // Add constructor args if needed
            });
            console.log(`✅ ${contractName} verified successfully`);
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log(`ℹ️  ${contractName} already verified`);
            } else {
                console.error(`❌ ${contractName} verification failed:`, error.message);
            }
        }
    }

    console.log(`\n🎉 Contract verification process completed!`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Verification script failed:", error);
        process.exit(1);
    });