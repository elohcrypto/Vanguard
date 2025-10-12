import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { expect } from "chai";

export class TestHelpers {
    /**
     * Generate a deterministic key from a string
     */
    static generateKey(input: string): string {
        return ethers.keccak256(ethers.solidityPacked(["string"], [input]));
    }

    /**
     * Generate a key from an address
     */
    static generateAddressKey(address: string): string {
        return ethers.keccak256(ethers.solidityPacked(["address"], [address]));
    }

    /**
     * Fast forward time in the blockchain
     */
    static async fastForwardTime(seconds: number): Promise<void> {
        await ethers.provider.send("evm_increaseTime", [seconds]);
        await ethers.provider.send("evm_mine", []);
    }

    /**
     * Get the current block timestamp
     */
    static async getCurrentTimestamp(): Promise<number> {
        const block = await ethers.provider.getBlock("latest");
        return block!.timestamp;
    }

    /**
     * Fund an account with ETH
     */
    static async fundAccount(account: SignerWithAddress, amount: string): Promise<void> {
        const [funder] = await ethers.getSigners();
        await funder.sendTransaction({
            to: account.address,
            value: ethers.parseEther(amount)
        });
    }

    /**
     * Create a mock claim data
     */
    static createClaimData(content: string): string {
        return ethers.solidityPacked(["string"], [content]);
    }

    /**
     * Create a mock signature
     */
    static createMockSignature(data: string): string {
        return ethers.solidityPacked(["string"], [`mock-signature-${data}`]);
    }

    /**
     * Generate multiple unique keys
     */
    static generateKeys(count: number, prefix: string = "key"): string[] {
        const keys: string[] = [];
        for (let i = 0; i < count; i++) {
            keys.push(this.generateKey(`${prefix}-${i}`));
        }
        return keys;
    }

    /**
     * Generate multiple unique salts
     */
    static generateSalts(count: number, prefix: string = "salt"): string[] {
        const salts: string[] = [];
        for (let i = 0; i < count; i++) {
            salts.push(this.generateKey(`${prefix}-${i}`));
        }
        return salts;
    }

    /**
     * Create test accounts with funding
     */
    static async createTestAccounts(count: number, fundAmount: string = "10.0"): Promise<SignerWithAddress[]> {
        const accounts: SignerWithAddress[] = [];
        const [funder] = await ethers.getSigners();

        for (let i = 0; i < count; i++) {
            const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
            const account = await ethers.getImpersonatedSigner(wallet.address);

            // Fund the account
            await funder.sendTransaction({
                to: account.address,
                value: ethers.parseEther(fundAmount)
            });

            accounts.push(account);
        }

        return accounts;
    }

    /**
     * Calculate gas cost for a transaction
     */
    static async calculateGasCost(tx: any): Promise<bigint> {
        const receipt = await tx.wait();
        return receipt.gasUsed * receipt.gasPrice;
    }

    /**
     * Expect transaction to emit multiple events
     */
    static async expectMultipleEvents(tx: any, events: Array<{ contract: any, event: string, args?: any[] }>) {
        for (const eventSpec of events) {
            if (eventSpec.args) {
                await expect(tx).to.emit(eventSpec.contract, eventSpec.event).withArgs(...eventSpec.args);
            } else {
                await expect(tx).to.emit(eventSpec.contract, eventSpec.event);
            }
        }
    }

    /**
     * Deploy a contract with retry logic
     */
    static async deployContract(contractName: string, args: any[] = [], retries: number = 3): Promise<any> {
        for (let i = 0; i < retries; i++) {
            try {
                const ContractFactory = await ethers.getContractFactory(contractName);
                const contract = await ContractFactory.deploy(...args);
                await contract.waitForDeployment();
                return contract;
            } catch (error) {
                if (i === retries - 1) throw error;
                await this.fastForwardTime(1); // Wait a bit before retry
            }
        }
    }

    /**
     * Batch execute transactions
     */
    static async batchExecute(transactions: Array<() => Promise<any>>): Promise<any[]> {
        const results: any[] = [];
        for (const tx of transactions) {
            results.push(await tx());
        }
        return results;
    }

    /**
     * Create a deterministic address from salt
     */
    static computeCreate2Address(deployer: string, salt: string, bytecodeHash: string): string {
        return ethers.getCreate2Address(deployer, salt, bytecodeHash);
    }

    /**
     * Verify contract deployment
     */
    static async verifyContractDeployment(address: string): Promise<boolean> {
        const code = await ethers.provider.getCode(address);
        return code !== "0x";
    }

    /**
     * Get contract events from transaction
     */
    static async getEventsFromTx(tx: any, contract: any, eventName: string): Promise<any[]> {
        const receipt = await tx.wait();
        const contractAddress = await contract.getAddress();
        return receipt.logs
            .filter((log: any) => log.address === contractAddress)
            .map((log: any) => contract.interface.parseLog(log))
            .filter((parsedLog: any) => parsedLog?.name === eventName);
    }

    /**
     * Constants for testing
     */
    static readonly KEY_PURPOSES = {
        MANAGEMENT: 1,
        ACTION: 2,
        CLAIM_SIGNER: 3,
        ENCRYPTION: 4
    };

    static readonly KEY_TYPES = {
        ECDSA: 1,
        RSA: 2
    };

    static readonly CLAIM_TOPICS = {
        IDENTITY: 1,
        BIOMETRIC: 2,
        RESIDENCE: 3,
        REGISTRY: 4,
        ACCREDITATION: 5,
        KYC: 6,
        AML: 7,
        INVESTOR_TYPE: 8
    };

    static readonly SIGNATURE_SCHEMES = {
        ECDSA: 1,
        RSA: 2,
        CONTRACT: 3
    };

    static readonly TIME_CONSTANTS = {
        HOUR: 60 * 60,
        DAY: 24 * 60 * 60,
        WEEK: 7 * 24 * 60 * 60,
        DEFAULT_TIMELOCK: 24 * 60 * 60,
        RECOVERY_TIMELOCK: 48 * 60 * 60
    };
}

// Re-export expect for convenience
export { expect } from "chai";