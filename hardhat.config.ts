import { HardhatUserConfig, extendEnvironment, subtask } from "hardhat/config";
import { TASK_TEST_GET_TEST_FILES } from "hardhat/builtin-tasks/task-names";
import { HDNodeWallet, Wallet } from "ethers";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// R-56c-6: the published Hardhat test phrase (and its keys) is anyone's;
// on a live network it would sign with keys the whole internet holds.
const TEST_PHRASE =
  "test test test test test test test test test test test junk";
export function refuseTestKeys(network: string, accounts: any): void {
  if (!["sepolia", "mainnet"].includes(network)) return;
  const phrase = String(accounts?.mnemonic ?? "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .join(" ");
  const keys = Array.isArray(accounts) ? accounts : [];
  const published = new Set(
    Array.from(
      { length: 20 },
      (_, i) =>
        HDNodeWallet.fromPhrase(TEST_PHRASE, undefined, `m/44'/60'/0'/0/${i}`)
          .address,
    ),
  );
  if (
    phrase === TEST_PHRASE ||
    keys.some((k: string) => published.has(new Wallet(k).address))
  ) {
    throw new Error(
      `refusing --network ${network}: MNEMONIC / PRIVATE_KEY is the published Hardhat test phrase; unset it (the local rehearsal's) and use the deployment's own keys`,
    );
  }
}
extendEnvironment((hre) =>
  refuseTestKeys(hre.network.name, (hre.network.config as any).accounts),
);

// Task 5.15 (L-6): TEST_SHARD=<i>/<n> runs shard i of n of the test files
// (`hardhat test` and `hardhat coverage` both collect them here), as
// scripts/ci/test-shards.js deals them; TEST_SHARD_RUN=coverage balances
// by the coverage run's weights. A file the shards miss is an error.
subtask(TASK_TEST_GET_TEST_FILES).setAction(async (args, hre, runSuper) => {
  const files: string[] = await runSuper(args);
  if (!process.env.TEST_SHARD) return files;
  const { shardOf } = require("./scripts/ci/test-shards.js");
  return shardOf(process.env.TEST_SHARD, process.env.TEST_SHARD_RUN, files);
});

/** { Authorization } for the signer at `url`, when its token file exists. */
function signerAuth(url: string): Record<string, string> {
  const { tokenFileFor } = require("./scripts/production/rpcGuard.js");
  const file = tokenFileFor(new URL(url).port || "80");
  if (!fs.existsSync(file)) return {};
  return { Authorization: `Bearer ${fs.readFileSync(file, "utf8").trim()}` };
}

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
      // With MNEMONIC set, the in-process node funds the same 12 role
      // wallets the testnet uses, so a local rehearsal exercises the exact
      // key-per-role separation. Without it, Hardhat's default accounts.
      ...(process.env.MNEMONIC
        ? { accounts: { mnemonic: process.env.MNEMONIC, count: 12 } }
        : {}),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      gas: 12000000,
      blockGasLimit: 12000000,
      ...(process.env.MNEMONIC
        ? { accounts: { mnemonic: process.env.MNEMONIC, count: 12 } }
        : {}),
    },
    // A second local dev node at DEMO_RPC_URL (scripts/demo-drive.sh), so a
    // drive can run beside a node already on 8545. Absent unless set.
    ...(process.env.DEMO_RPC_URL
      ? {
          devnode: {
            url: process.env.DEMO_RPC_URL,
            chainId: 31337,
            gas: 12000000,
            blockGasLimit: 12000000,
            ...(process.env.MNEMONIC
              ? { accounts: { mnemonic: process.env.MNEMONIC, count: 12 } }
              : {}),
          },
        }
      : {}),
    // Task 5.7 (D48 a): an external signer's JSON-RPC endpoint (Frame
    // style: it holds the keys, signs eth_sendTransaction and forwards
    // the rest to its chain); this process holds no key. Absent unless
    // set. Long timeout: a person may approve each transaction.
    // Task 5.15: the signer's bearer token (scripts/production/rpcGuard.js)
    // from SIGNER_TOKEN_FILE, else the path the signer prints by default.
    ...(process.env.SIGNER_RPC_URL
      ? {
          remote: {
            url: process.env.SIGNER_RPC_URL,
            accounts: "remote" as const,
            timeout: 600_000,
            httpHeaders: signerAuth(process.env.SIGNER_RPC_URL),
          },
        }
      : {}),
    sepolia: {
      url:
        process.env.SEPOLIA_RPC_URL ||
        "https://sepolia.infura.io/v3/YOUR_PROJECT_ID",
      // Role wallets: one mnemonic, twelve derived keys. Falls back to a
      // single PRIVATE_KEY for scripts that only need a deployer.
      accounts: process.env.MNEMONIC
        ? { mnemonic: process.env.MNEMONIC, count: 12 }
        : process.env.PRIVATE_KEY
          ? [process.env.PRIVATE_KEY]
          : [],
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
    // CI's coverage runs set MOCHA_TIMINGS: a root hook records every
    // passing test's and hook's duration and own timeout there, for the
    // near-timeout guard (scripts/ci/mocha-log.js durations).
    ...(process.env.MOCHA_TIMINGS
      ? { rootHooks: require("./scripts/ci/mocha-log.js").mochaHooks }
      : {}),
  },
};

export default config;
