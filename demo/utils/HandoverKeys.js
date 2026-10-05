/**
 * @fileoverview Handover ceremony, plan v2 Task 4.2: KeyManager.
 *
 * KeyManager has no owner and no allowlist (identities opt in with
 * OnchainID.authorizeManager), so there is nothing to hand over. What the
 * ceremony proves instead: the deployed runtime code is the compiled
 * KeyManager (a pre-4.2 one kept an owner and an allowlist), and the demo
 * identity named by the config authorizes that KeyManager while the
 * deployer is not one of its managers. Both config keys are optional:
 * "keyManager" (an address) and "keyManagerIdentity" (an OnchainID).
 */

const { ethers } = require("hardhat");
const { addrOf, fail } = require("./HandoverChecks");
const { codeHash, expectedHash } = require("./HandoverCodeHash");

const MANAGED_ABI = [
  "function authorizedManagers(address) view returns (bool)",
];

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
  }
}

/** Completion lines: [label, pass][]; none when the config names no KeyManager. */
async function keyManagerLines(o, dAddr) {
  const k = await keyManagerCode(o);
  if (!k) return [];
  const lines = [
    [
      `KeyManager ${k.addr} code matches the compiled KeyManager: no owner, no allowlist, the deployer holds no KeyManager power`,
      k.hasCode && k.actual === k.expected,
    ],
  ];
  if (o.keyManagerIdentity) {
    const idAddr = await addrOf(o.keyManagerIdentity);
    const id = await ethers.getContractAt(MANAGED_ABI, idAddr);
    const read = (a) => id.authorizedManagers(a).catch(() => null);
    const [km, deployer] = [await read(k.addr), await read(dAddr)];
    lines.push([
      `demo identity ${idAddr} authorizes KeyManager ${k.addr}; the deployer is not its manager`,
      km === true && deployer === false,
    ]);
  }
  return lines;
}

module.exports = { preflightKeyManager, keyManagerLines };
