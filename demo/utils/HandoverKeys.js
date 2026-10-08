/**
 * @fileoverview Handover ceremony, plan v2 Task 4.2: KeyManager.
 *
 * KeyManager has no owner and no allowlist (identities opt in with
 * OnchainID.authorizeManager), so there is nothing to hand over. What the
 * ceremony proves instead: the deployed runtime code is the compiled
 * KeyManager (a pre-4.2 one kept an owner and an allowlist), and the demo
 * identity named by the config authorizes that KeyManager while the
 * deployer is neither its owner, nor an authorized manager, nor a
 * MANAGEMENT key on it. Both config keys are optional: "keyManager" (an
 * address) and "keyManagerIdentity" (an OnchainID, only with keyManager).
 * Nothing in the ceremony changes the identity, so the preflight refuses
 * a failing identity before Step 1.
 */

const { ethers } = require("hardhat");
const { addrOf, fail } = require("./HandoverChecks");
const { codeHash, expectedHash } = require("./HandoverCodeHash");

const MANAGED_ABI = [
  "function authorizedManagers(address) view returns (bool)",
  "function keyHasPurpose(bytes32,uint256) view returns (bool)",
  "function owner() view returns (address)",
  "function recoveryManager() view returns (address)",
  "function getManagers() view returns (address[])",
];
const KM_ABI = [
  "function getKeyRecovery(address) view returns (address[],uint256,uint256,bool,uint256,bytes32)",
];

/**
 * The demo identity's facts: { idAddr, authorizes, deployerRoles } where
 * deployerRoles lists what the deployer still is on it (empty: nothing).
 */
async function identityFacts(o, kmAddr, dAddr) {
  const idAddr = await addrOf(o.keyManagerIdentity);
  const id = await ethers.getContractAt(MANAGED_ABI, idAddr);
  const read = (p) => p.catch(() => null);
  const key = ethers.solidityPackedKeccak256(["address"], [dAddr]);
  const owner = await read(id.owner());
  const roles = [];
  if (owner === null || owner.toLowerCase() === dAddr.toLowerCase())
    roles.push("owner");
  if ((await read(id.authorizedManagers(dAddr))) !== false)
    roles.push("authorized manager");
  if ((await read(id.keyHasPurpose(key, 1))) !== false)
    roles.push("MANAGEMENT key");
  // Task 4.11: agents at the threshold can take the identity.
  const km = await ethers.getContractAt(KM_ABI, kmAddr);
  const rec = await read(km.getKeyRecovery(idAddr));
  if (
    rec === null ||
    rec[0].some((a) => a.toLowerCase() === dAddr.toLowerCase())
  )
    roles.push("recovery agent");
  const authorizes = (await read(id.authorizedManagers(kmAddr))) === true;
  // Task 4.11 (R-411-14): KeyManager is the pinned recovery manager and
  // the only authorized manager.
  const pin = await read(id.recoveryManager());
  const managers = await read(id.getManagers());
  const pinned = pin !== null && pin.toLowerCase() === kmAddr.toLowerCase();
  const onlyKm =
    managers !== null &&
    managers.length === 1 &&
    managers[0].toLowerCase() === kmAddr.toLowerCase();
  return { idAddr, authorizes, pinned, onlyKm, deployerRoles: roles };
}

/** { addr, hasCode, actual, expected } for o.keyManager, or null. */
async function keyManagerCode(o) {
  if (!o.keyManager) return null;
  const addr = await addrOf(o.keyManager);
  const hasCode = (await ethers.provider.getCode(addr)) !== "0x";
  const [actual, expected] = [
    await codeHash(addr),
    await expectedHash("KeyManager"),
  ];
  return { addr, hasCode, actual, expected };
}

/** Read-only, before the first transaction: refuse a KeyManager that is not one. */
async function preflightKeyManager(o) {
  if (o.keyManagerIdentity && !o.keyManager) {
    fail(
      `keyManagerIdentity is named without keyManager: name the deployed KeyManager too, or leave both out`,
    );
  }
  const k = await keyManagerCode(o);
  if (!k) return;
  if (!k.hasCode) {
    fail(
      `keyManager ${k.addr} has no code: name the deployed KeyManager, or leave "keyManager" out`,
    );
  }
  if (k.actual !== k.expected) {
    fail(
      `KeyManager ${k.addr} runtime code hash ${k.actual} is not the compiled KeyManager (${k.expected}): one from before Task 4.2 keeps an owner and an allowlist; redeploy it from this build`,
    );
  }
  if (o.keyManagerIdentity) {
    const id = await addrOf(o.keyManagerIdentity);
    if ((await ethers.provider.getCode(id)) === "0x") {
      fail(`keyManagerIdentity ${id} has no code: name the demo OnchainID`);
    }
    const f = await identityFacts(o, k.addr, await addrOf(o.deployer));
    if (!f.authorizes) {
      fail(
        `keyManagerIdentity ${f.idAddr} has not authorized KeyManager ${k.addr}: its owner must send authorizeManager(${k.addr}) first`,
      );
    }
    if (f.deployerRoles.length) {
      fail(
        `the deployer is still ${f.deployerRoles.join(", ")} on keyManagerIdentity ${f.idAddr}: its owner must remove that before the handover`,
      );
    }
    if (!f.pinned) {
      fail(
        `keyManagerIdentity ${f.idAddr} does not pin KeyManager ${k.addr} as its recovery manager: create it through the factory (recoveryManager set) or have its owner pinRecoveryManager(${k.addr})`,
      );
    }
    if (!f.onlyKm) {
      fail(
        `keyManagerIdentity ${f.idAddr} authorizes managers other than KeyManager ${k.addr} (getManagers): its owner must deauthorize them`,
      );
    }
  }
}

/** Completion lines: [label, pass][]; none when the config names no KeyManager. */
async function keyManagerLines(o, dAddr) {
  const k = await keyManagerCode(o);
  if (!k) return [];
  const lines = [
    [
      `KeyManager ${k.addr} code matches the compiled KeyManager: no owner, no allowlist, the deployer holds no KeyManager power; only an identity's pinned recovery manager can move its ownership: its recovery agents at their threshold evict its MANAGEMENT keys after 48h and move its owner after 7 days`,
      k.hasCode && k.actual === k.expected,
    ],
  ];
  if (o.keyManagerIdentity) {
    const f = await identityFacts(o, k.addr, dAddr);
    lines.push([
      `demo identity ${f.idAddr} pins KeyManager ${k.addr} as its recovery manager and authorizes only it; the deployer is not its owner, manager, MANAGEMENT key or recovery agent`,
      f.authorizes && f.pinned && f.onlyKm && f.deployerRoles.length === 0,
    ]);
  }
  return lines;
}

module.exports = { preflightKeyManager, keyManagerLines };
