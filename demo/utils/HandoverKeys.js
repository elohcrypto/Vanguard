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
 * A named onchainIDFactory is checked either way (review L-1): its
 * recoveryManagerCodeHash must be zero or the compiled KeyManager's, and a
 * recovery manager it pins must be named as "keyManager".
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

/**
 * Task 4.11 (R-411-19): the factory pins its recovery manager on every
 * identity it creates. For o.onchainIDFactory (null when not named):
 * hashOk is a recoveryManagerCodeHash of zero (pins nothing, ever) or the
 * compiled KeyManager's; pins says it pins kmAddr; pinsNone that it pins
 * nothing. Checked whether or not a keyManager is named (review L-1).
 */
async function factoryFacts(o, kmAddr) {
  if (!o.onchainIDFactory) return null;
  const addr = await addrOf(o.onchainIDFactory);
  const f = await ethers.getContractAt(
    [
      "function recoveryManager() view returns (address)",
      "function recoveryManagerCodeHash() view returns (bytes32)",
    ],
    addr,
  );
  const rm = await f.recoveryManager().catch(() => null);
  const hash = await f.recoveryManagerCodeHash().catch(() => null);
  const expected = await expectedHash("KeyManager");
  return {
    addr,
    rm,
    hash,
    expected,
    hashOk: hash === ethers.ZeroHash || hash === expected,
    pins: !!kmAddr && rm !== null && rm.toLowerCase() === kmAddr.toLowerCase(),
    pinsNone: rm === ethers.ZeroAddress,
  };
}

/** Refuse a factory that pins, or may pin, a recovery manager unchecked. */
function refuseFactory(fac, kmAddr) {
  if (!fac.hashOk) {
    fail(
      `onchainIDFactory ${fac.addr} recoveryManagerCodeHash ${fac.hash} is neither zero nor the compiled KeyManager (${fac.expected}): it accepts a recovery manager that is not KeyManager; redeploy it from this build`,
    );
  }
  if (!kmAddr && !fac.pinsNone) {
    fail(
      `onchainIDFactory ${fac.addr} pins recovery manager ${fac.rm} on every identity it creates: name it as keyManager so the ceremony checks it`,
    );
  }
  if (kmAddr && !fac.pins) {
    fail(
      `onchainIDFactory ${fac.addr} does not pin KeyManager ${kmAddr} on the identities it creates: its owner must setRecoveryManager(${kmAddr}) first`,
    );
  }
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
  const fac = await factoryFacts(o, k && k.addr);
  if (!k) {
    if (fac) refuseFactory(fac, null);
    return;
  }
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
  if (fac) refuseFactory(fac, k.addr);
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

/**
 * Completion lines: [label, pass][]. A named factory always gets a line;
 * the KeyManager lines come only with a keyManager.
 */
async function keyManagerLines(o, dAddr) {
  const k = await keyManagerCode(o);
  const fac = await factoryFacts(o, k && k.addr);
  if (!k) {
    if (!fac) return [];
    return [
      [
        `OnchainIDFactory ${fac.addr} pins no recovery manager (none named as keyManager) and accepts only the compiled KeyManager (recoveryManagerCodeHash zero or its code hash)`,
        fac.hashOk && fac.pinsNone,
      ],
    ];
  }
  const lines = [
    [
      `KeyManager ${k.addr} code matches the compiled KeyManager: no owner, no allowlist, the deployer holds no KeyManager power; only an identity's pinned recovery manager can move its ownership: its recovery agents at their threshold evict its MANAGEMENT keys after 48h and move its owner after 7 days`,
      k.hasCode && k.actual === k.expected,
    ],
  ];
  if (fac) {
    lines.push([
      `OnchainIDFactory ${fac.addr} pins KeyManager ${k.addr} as the recovery manager of every identity it creates (recoveryManager, code-hash checked)`,
      fac.pins && fac.hashOk,
    ]);
  }
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
