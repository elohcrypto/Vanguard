/**
 * @fileoverview A deploy flow's contract, checked to hold its artifact's code
 * @module DeployedCode
 * @description Moved out of DeployWiring.js (U2 round 9, size rule), body
 * unchanged; DeployWiring re-exports it.
 */

"use strict";

const { ethers } = require("hardhat");
const { isCodeOf } = require("./HandoverCodeHash");

/**
 * Round 5 (lane D-3): `c` deployed with code at its address, else a stop
 * naming it (its deploy mined without creating the contract), before
 * anything holds `c`: demo state never gets an address without code.
 * Round 6 (G4): and that code is `artifact`'s, its immutables aside, with
 * the masked comparison the handover's code-hash pins use (the record's
 * own checkCode compares a recorded hash, not an artifact).
 */
async function deployed(c, name, artifact = name) {
  await c.waitForDeployment();
  const at = await c.getAddress();
  const code = await ethers.provider.getCode(at);
  if (code === "0x") {
    throw new Error(
      `${name} at ${at} has no code: its deploy transaction mined without creating it`,
    );
  }
  if (!(await isCodeOf(code, artifact))) {
    throw new Error(
      `${name} at ${at} has code that is not ${artifact}'s: its deploy transaction created another contract`,
    );
  }
  return c;
}

module.exports = { deployed };
