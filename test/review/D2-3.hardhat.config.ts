// D2-3: the same project, but the in-process node answers as Sepolia
// (chain id 11155111) with accounts that are not the published Hardhat
// phrase (hardhat.config.ts refuses that phrase on any chain but 31337).
import * as path from "path";
import base from "../../hardhat.config";

const config: any = {
  ...base,
  paths: { ...base.paths, root: path.resolve(__dirname, "../..") },
  networks: {
    ...base.networks,
    hardhat: {
      ...(base.networks as any).hardhat,
      chainId: 11155111,
      accounts: {
        mnemonic:
          "legal winner thank year wave sausage worth useful legal winner thank yellow",
        count: 12,
      },
      hardfork: "cancun",
    },
  },
};
export default config;
