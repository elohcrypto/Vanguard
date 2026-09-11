import { ethers, run } from "hardhat";
import { Contract, ContractFactory } from "ethers";

export interface DeploymentResult {
  contract: Contract;
  address: string;
  transactionHash: string;
  gasUsed: bigint;
}

export class DeploymentHelper {
  static async deployContract(
    contractName: string,
    constructorArgs: any[] = [],
    options: { gasLimit?: number; gasPrice?: bigint } = {},
  ): Promise<DeploymentResult> {
    console.log(`📦 Deploying ${contractName}...`);

    const ContractFactory: ContractFactory =
      await ethers.getContractFactory(contractName);

    const deploymentOptions: any = {};
    if (options.gasLimit) deploymentOptions.gasLimit = options.gasLimit;
    if (options.gasPrice) deploymentOptions.gasPrice = options.gasPrice;

    const contract = await ContractFactory.deploy(
      ...constructorArgs,
      deploymentOptions,
    );
    const deploymentTx = contract.deploymentTransaction();

    if (!deploymentTx) {
      throw new Error(
        `Failed to get deployment transaction for ${contractName}`,
      );
    }

    const receipt = await deploymentTx.wait();
    if (!receipt) {
      throw new Error(`Failed to get deployment receipt for ${contractName}`);
    }

    console.log(
      `✅ ${contractName} deployed to: ${await contract.getAddress()}`,
    );
    console.log(`   Transaction hash: ${receipt.hash}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

    return {
      contract,
      address: await contract.getAddress(),
      transactionHash: receipt.hash,
      gasUsed: receipt.gasUsed,
    };
  }

  static async verifyContract(
    address: string,
    constructorArgs: any[] = [],
  ): Promise<void> {
    console.log(`🔍 Verifying contract at ${address}...`);

    try {
      await run("verify:verify", {
        address,
        constructorArguments: constructorArgs,
      });
      console.log(`✅ Contract verified successfully`);
    } catch (error: any) {
      if (error.message.includes("Already Verified")) {
        console.log(`ℹ️  Contract already verified`);
      } else {
        console.error(`❌ Verification failed:`, error.message);
        throw error;
      }
    }
  }

  static async saveDeploymentInfo(
    networkName: string,
    deployments: Record<string, DeploymentResult>,
  ): Promise<void> {
    const fs = require("fs");
    const path = require("path");

    const deploymentsDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const deploymentInfo = {
      network: networkName,
      timestamp: new Date().toISOString(),
      contracts: Object.fromEntries(
        Object.entries(deployments).map(([name, result]) => [
          name,
          {
            address: result.address,
            transactionHash: result.transactionHash,
            gasUsed: result.gasUsed.toString(),
          },
        ]),
      ),
    };

    const filePath = path.join(deploymentsDir, `${networkName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));

    console.log(`💾 Deployment info saved to: ${filePath}`);
  }

  static async getNetworkInfo(): Promise<{
    name: string;
    chainId: number;
    gasPrice: bigint;
  }> {
    const network = await ethers.provider.getNetwork();
    const gasPrice = await ethers.provider.getFeeData();

    return {
      name: network.name,
      chainId: Number(network.chainId),
      gasPrice: gasPrice.gasPrice || 0n,
    };
  }

  /**
   * Reject a compliance contract that does not enforce transfer rules.
   *
   * ComplianceRegistry is a permissive test double: its canTransfer always
   * returns true, so a Token bound to it performs no compliance checking at
   * all. It satisfies ICompliance, so nothing in the type system stops it
   * being wired into a real deployment.
   *
   * Call this before binding compliance to a Token on any live network.
   * Contracts that expose isProductionCompliance() must return true; a
   * contract that omits the function is allowed through (older enforcing
   * implementations predate this marker), but a contract that returns false
   * is refused.
   *
   * @param complianceAddress address of the ICompliance implementation
   * @throws if the contract explicitly identifies as non-production
   */
  static async assertProductionCompliance(
    complianceAddress: string,
  ): Promise<void> {
    const probe = await ethers.getContractAt(
      ["function isProductionCompliance() view returns (bool)"],
      complianceAddress,
    );

    let isProduction: boolean;
    try {
      isProduction = await probe.isProductionCompliance();
    } catch {
      // Function absent. Every enforcing implementation in this repo carries
      // the marker, so a contract without it is either a foreign contract or a
      // test double. Neither should be bound without a human looking at it.
      // An earlier version warned and returned here; that made the guard a
      // formality, since anything unmarked passed.
      throw new Error(
        `Refusing to bind compliance at ${complianceAddress}: it does not ` +
          `implement isProductionCompliance(). Every enforcing compliance in ` +
          `this repo does (ComplianceRules). If this is a new implementation, ` +
          `add the marker; if it is a test double, do not bind it.`,
      );
    }

    if (!isProduction) {
      throw new Error(
        `Refusing to bind compliance at ${complianceAddress}: it reports ` +
          `isProductionCompliance() == false (a permissive test double whose ` +
          `canTransfer always returns true).\n` +
          `  Bind an enforcing implementation instead: ComplianceRules, ` +
          `ComplianceValidator, or InvestorTypeCompliance.`,
      );
    }

    console.log(
      `✅ Compliance at ${complianceAddress} reports production-ready`,
    );
  }
}
