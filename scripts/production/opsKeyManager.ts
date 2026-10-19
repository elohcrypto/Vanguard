import { artifacts, ethers } from "hardhat";
import { KeyManager, OnchainIDFactory } from "../../typechain-types";

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
 * Task 4.11 (R-411-18, L-3): the ops identity must also pin KeyManager as
 * its recovery manager. The deploy pins it when the deploying wallet owns
 * the identity, prints the pinRecoveryManager call for another owner, and
 * refuses an identity already pinned to another manager (a pin is final).
 * Task 5.17 (deep review, ceremony L-1; readiness L-4): when the identity's
 * owner is an external role (the ops multisig, Task 5.13) both calls are
 * role steps (demo/utils/RoleCalls.js): exported as a Safe batch, the
 * deploy pauses (exit 3), and a re-run proves their effects on chain
 * (recoveryManager() == KeyManager, authorizedManagers(KeyManager))
 * before it finishes. Owned by another key, they are printed as before.
 *
 * The KeyManager steps of scripts/production/DeployProduction.ts live
 * here too: the code hash the factory accepts, the deploy, and the
 * configuration step (timelocks logged, the ops identity wired).
 */

/** Task 4.11 (R-411-19): the compiled KeyManager's runtime code hash. */
export async function keyManagerCodeHash(): Promise<string> {
  return ethers.keccak256(
    (await artifacts.readArtifact("KeyManager")).deployedBytecode,
  );
}

/** Step 2 of the production deploy: KeyManager, with its gas used. */
export async function deployKeyManager(
  overrides: Record<string, unknown>,
  confirmations: number,
): Promise<{ keyManager: KeyManager; address: string; gasUsed: bigint }> {
  console.log("\n🔐 Deploying KeyManager...");
  const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
  const keyManager = await KeyManagerFactory.deploy(overrides);

  console.log(
    `   Transaction hash: ${keyManager.deploymentTransaction()?.hash}`,
  );
  console.log("   Waiting for confirmations...");

  await keyManager.waitForDeployment();
  const receipt = await keyManager.deploymentTransaction()?.wait(confirmations);
  const gasUsed = receipt?.gasUsed || BigInt(0);

  const address = await keyManager.getAddress();
  console.log(`✅ KeyManager deployed at: ${address}`);
  console.log(`   Gas used: ${gasUsed.toLocaleString()}`);
  return { keyManager, address, gasUsed };
}

/**
 * Task 4.11 (R-411-14): identities the factory creates pin KeyManager as
 * their one recovery manager.
 */
export async function pinKeyManagerOnFactory(
  factory: OnchainIDFactory,
  keyManager: string,
  overrides: Record<string, unknown>,
  confirmations: number,
): Promise<void> {
  const tx = await factory.setRecoveryManager(keyManager, overrides);
  await tx.wait(confirmations);
  console.log(`   Recovery manager pinned on new identities: ${keyManager}`);
}

/**
 * Configure KeyManager: RECOVERY_TIMELOCK (48h) and DEFAULT_TIMELOCK (24h)
 * are fixed contract constants, not configurable — KeyManager exposes no
 * setRecoveryTimelock/setKeyRotationTimelock setters (only a per-identity
 * setCustomTimelock override). Read and log them so this step stays
 * informative without pretending to configure something immutable; then
 * wire the ops identity (authorizeKeyManagerOnOps).
 */
export async function configureKeyManager(
  keyManager: KeyManager,
  deployer: { address: string },
  opsIdentity: string | undefined,
  overrides: Record<string, unknown>,
  roles?: OpsIdentityRoles,
): Promise<{
  recoveryTimelock: bigint;
  keyRotationTimelock: bigint;
  opsKeyManager: OpsKeyManagerResult;
}> {
  console.log("\n🔐 Configuring KeyManager...");
  const recoveryTimelock = await keyManager.RECOVERY_TIMELOCK();
  const keyRotationTimelock = await keyManager.DEFAULT_TIMELOCK();
  console.log(`   Recovery timelock: ${recoveryTimelock} seconds (fixed)`);
  console.log(
    `   Key rotation timelock: ${keyRotationTimelock} seconds (default; an identity's MANAGEMENT key may set its own)`,
  );
  const opsKeyManager = await authorizeKeyManagerOnOps(
    await keyManager.getAddress(),
    deployer,
    opsIdentity,
    overrides,
    roles,
  );
  return { recoveryTimelock, keyRotationTimelock, opsKeyManager };
}

/**
 * The deploy's external roles (DeployProduction.rolePause): whether an
 * address is one, and the pause that exports role steps and checks them.
 */
export interface OpsIdentityRoles {
  isExternal: (a: string) => boolean;
  /** The configured ops address: the one external owner accepted. */
  ops: string;
  opsIdentity: (steps: any[]) => Promise<void>;
}

/** The pin and the authorization as role steps of `owner` (external). */
function opsIdentitySteps(id: any, owner: string, keyManager: string) {
  const { externalRole } = require("../../demo/utils/RoleCalls");
  const role = externalRole(owner, "ops");
  const same = (a: string) => a.toLowerCase() === keyManager.toLowerCase();
  return [
    {
      id: "deploy.opsIdentity.pinRecoveryManager",
      role,
      roleLabel: "ops",
      contract: id,
      name: "OnchainID (ops identity)",
      fn: "pinRecoveryManager",
      args: [keyManager],
      purpose:
        "the ops identity pins KeyManager as its one recovery manager (Task 4.11, R-411-18; a pin is final)",
      status: async () => {
        const m: string = await id.recoveryManager();
        if (same(m)) return "done";
        if (m === ethers.ZeroAddress) return "pending";
        return `recoveryManager is ${m}, not KeyManager ${keyManager}`;
      },
    },
    {
      id: "deploy.opsIdentity.authorizeManager",
      role,
      roleLabel: "ops",
      contract: id,
      name: "OnchainID (ops identity)",
      fn: "authorizeManager",
      args: [keyManager],
      purpose:
        "the ops identity opts in to KeyManager's rotation and recovery (Task 4.2)",
      status: async () =>
        (await id.authorizedManagers(keyManager)) ? "done" : "pending",
    },
  ];
}
export interface OpsKeyManagerResult {
  opsIdentity: string | null;
  authorized: boolean;
  /**
   * The calls still to send (the pin, the authorization, or both,
   * "; "-joined), or null when nothing is pending (Task 4.16, review
   * B L-5: a pending pin used to report nothing).
   */
  pending: string | null;
}

export async function authorizeKeyManagerOnOps(
  keyManager: string,
  deployer: { address: string },
  opsIdentity: string | undefined,
  overrides: Record<string, unknown> = {},
  roles?: OpsIdentityRoles,
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
  const idOwner: string = await id.owner();
  // Slice C review L-4 and slice D review LOW-3: only ops owns the ops
  // identity, an external ops (its multisig) or a key this signer holds;
  // the deployer only until it transfers it. Another role (the
  // issuer-admin multisig, the guardian's key) would sign "ops" steps.
  const is = (a: string) => idOwner.toLowerCase() === a.toLowerCase();
  if (roles && !is(roles.ops) && !is(deployer.address))
    throw new Error(
      `ops identity ${opsIdentity} is owned by ${idOwner}, not ops ${roles.ops}: name the ops OnchainID (OPS_IDENTITY)`,
    );
  if (roles?.isExternal(idOwner)) {
    // A pin to another manager is refused before anything is exported.
    const pinned: string = await id.recoveryManager();
    if (
      pinned !== ethers.ZeroAddress &&
      pinned.toLowerCase() !== keyManager.toLowerCase()
    ) {
      throw new Error(
        `ops identity ${opsIdentity} pins recovery manager ${pinned}, not KeyManager ${keyManager}; a pin is final: use another ops identity`,
      );
    }
    await roles.opsIdentity(opsIdentitySteps(id, idOwner, keyManager));
    console.log(
      `   ✅ KeyManager pinned and authorized on ops identity ${opsIdentity} (by its owner ${idOwner})`,
    );
    return { opsIdentity, authorized: true, pending: null };
  }
  const pinPending = await pinOnOps(
    id,
    opsIdentity,
    keyManager,
    deployer,
    overrides,
  );
  const join = (...calls: (string | null)[]) =>
    calls.filter(Boolean).join("; ") || null;
  if (await id.authorizedManagers(keyManager)) {
    console.log(
      `   KeyManager already authorized on ops identity ${opsIdentity}`,
    );
    return { opsIdentity, authorized: true, pending: join(pinPending) };
  }
  const owner = await id.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    const pending = call(opsIdentity, owner);
    console.log(
      `   ⚠️  The deployer does not own ops identity ${opsIdentity}.`,
    );
    console.log(`   The ops key must send: ${pending}`);
    return {
      opsIdentity,
      authorized: false,
      pending: join(pinPending, pending),
    };
  }
  const signer = await ethers.getSigner(deployer.address);
  await (
    await id.connect(signer).authorizeManager(keyManager, overrides)
  ).wait();
  if (!(await id.authorizedManagers(keyManager))) {
    throw new Error(`authorizeManager on ${opsIdentity} did not take effect`);
  }
  console.log(`   ✅ KeyManager authorized on ops identity ${opsIdentity}`);
  return { opsIdentity, authorized: true, pending: join(pinPending) };
}

/**
 * Pins KeyManager on the ops identity; returns the pin call still to send
 * when another wallet owns the identity, else null (pinned, or was).
 */
async function pinOnOps(
  id: any,
  opsIdentity: string,
  keyManager: string,
  deployer: { address: string },
  overrides: Record<string, unknown>,
): Promise<string | null> {
  const pinned: string = await id.recoveryManager();
  if (pinned.toLowerCase() === keyManager.toLowerCase()) {
    console.log(`   KeyManager already pinned on ops identity ${opsIdentity}`);
    return null;
  }
  if (pinned !== ethers.ZeroAddress) {
    throw new Error(
      `ops identity ${opsIdentity} pins recovery manager ${pinned}, not KeyManager ${keyManager}; a pin is final: use another ops identity`,
    );
  }
  const owner: string = await id.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    const pending = `OnchainID(${opsIdentity}).pinRecoveryManager(${keyManager}) from the identity owner ${owner}`;
    console.log(`   The ops key must also send: ${pending}`);
    return pending;
  }
  const signer = await ethers.getSigner(deployer.address);
  await (
    await id.connect(signer).pinRecoveryManager(keyManager, overrides)
  ).wait();
  console.log(`   ✅ KeyManager pinned as recovery manager on ${opsIdentity}`);
  return null;
}
