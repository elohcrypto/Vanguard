import { artifacts, ethers } from "hardhat";

/**
 * Plan v2 Task 4.3: a ComplianceRules registrar (InvestorRequestManager,
 * EscrowWalletFactory) may trust only accounts whose runtime code hash is
 * the one the owner registered: the compiled wallet's deployedBytecode.
 */
export async function walletCodeHash(
  name: "MultiSigWallet" | "MultiSigEscrowWallet",
): Promise<string> {
  return ethers.keccak256(
    (await artifacts.readArtifact(name)).deployedBytecode,
  );
}

const addr = async (x: any): Promise<string> =>
  typeof x === "string" ? x : x.getAddress ? x.getAddress() : x.target;

/** The owner of `rules` names `registrar` on `token` for the `name` wallets. */
export async function addRegistrar(
  rules: any,
  token: any,
  registrar: any,
  name: "MultiSigWallet" | "MultiSigEscrowWallet",
) {
  await (
    await rules.setTrustedRegistrar(
      await addr(token),
      await addr(registrar),
      await walletCodeHash(name),
    )
  ).wait();
}
