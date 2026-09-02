import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      // OpenZeppelin 5.6 Bytes.sol uses the mcopy opcode (EIP-5656, Cancun).
      // Targets here (mainnet/sepolia/hardhat) are all post-Cancun.
      evmVersion: "cancun",
      // metadata.bytecodeHash is left at solc's default ("ipfs") on purpose:
      // the embedded hash is what lets Etherscan link deployed bytecode back to
      // source, which this project needs (see the etherscan config below).
      //
      // Consequence: the hash covers the source INCLUDING COMMENTS, so editing a
      // comment changes deployedBytecode even though the executable code is
      // byte-identical. That breaks re-verification of an already-deployed
      // address and shifts CREATE2 addresses. Set bytecodeHash: "none" only if
      // deterministic addresses matter more than source verification.
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      gas: 12000000,
      blockGasLimit: 12000000,
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      gas: 12000000,
      blockGasLimit: 12000000,
    },
    sepolia: {
      url:
        process.env.SEPOLIA_RPC_URL ||
        "https://sepolia.infura.io/v3/YOUR_PROJECT_ID",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
      gas: 8000000,
      gasPrice: 30000000000, // 30 gwei
    },
    mainnet: {
      url:
        process.env.MAINNET_RPC_URL ||
        "https://mainnet.infura.io/v3/YOUR_PROJECT_ID",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
      gas: 8000000,
      gasPrice: 50000000000, // 50 gwei
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
    gasPrice: 30,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
    },
  },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 60000,
  },
};

export default config;
