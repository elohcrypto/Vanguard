import { ethers } from "hardhat";

/**
 * Plan v2 Task 4.2: the production deploy authorizes KeyManager on the
 * ops identity. KeyManager has no owner and no allowlist; an identity opts
 * in with OnchainID.authorizeManager(KeyManager), which only the identity's
 * owner may send. DeployProduction creates no identity, so the ops
 * identity is named by OPS_IDENTITY:
 *   - owned by the deploying wallet: the deploy sends the call itself;
 *   - owned by another wallet (the ops key): the deploy prints the exact
 *     call that wallet must send, and nothing is authorized yet;
 *   - unset: the deploy prints the call with a placeholder.
 */
export interface OpsKeyManagerResult {
  opsIdentity: string | null;
  authorized: boolean;
  /** The call still to send, or null when it was sent. */
  pending: string | null;
}

export async function authorizeKeyManagerOnOps(
  keyManager: string,
  deployer: { address: string },
  opsIdentity: string | undefined,
  overrides: Record<string, unknown> = {},
): Promise<OpsKeyManagerResult> {
  const call = (id: string, owner: string) =>
    `OnchainID(${id}).authorizeManager(${keyManager}) from the identity owner ${owner}`;
  if (!opsIdentity) {
    const pending = call("<ops identity>", "<ops key>");
    console.log(
      "   ⚠️  OPS_IDENTITY not set: KeyManager is authorized on no identity yet.",
    );
    console.log(`   The ops key must send: ${pending}`);
    return { opsIdentity: null, authorized: false, pending };
  }
  if (!ethers.isAddress(opsIdentity)) {
    throw new Error(`OPS_IDENTITY ${opsIdentity} is not an address`);
  }
  if ((await ethers.provider.getCode(opsIdentity)) === "0x") {
    throw new Error(
      `OPS_IDENTITY ${opsIdentity} has no code: name the ops OnchainID`,
    );
  }
  const id = await ethers.getContractAt("OnchainID", opsIdentity);
  if (await id.authorizedManagers(keyManager)) {
    console.log(
      `   KeyManager already authorized on ops identity ${opsIdentity}`,
    );
    return { opsIdentity, authorized: true, pending: null };
  }
  const owner = await id.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    const pending = call(opsIdentity, owner);
    console.log(
      `   ⚠️  The deployer does not own ops identity ${opsIdentity}.`,
    );
    console.log(`   The ops key must send: ${pending}`);
    return { opsIdentity, authorized: false, pending };
  }
  const signer = await ethers.getSigner(deployer.address);
  await (
    await id.connect(signer).authorizeManager(keyManager, overrides)
  ).wait();
  if (!(await id.authorizedManagers(keyManager))) {
    throw new Error(`authorizeManager on ${opsIdentity} did not take effect`);
  }
  console.log(`   ✅ KeyManager authorized on ops identity ${opsIdentity}`);
  return { opsIdentity, authorized: true, pending: null };
}
