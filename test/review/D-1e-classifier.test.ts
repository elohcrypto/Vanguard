// D-1e (round 5, G4 ISSUE 1): ethers' JsonRpcProvider answers every
// eth_call error that carries no revert data with CALL_EXCEPTION and
// data null, so noSuchFunction read a missing trie node, a rate limit
// or a timeout as "no such function" and the check was skipped. Only
// data "0x" (an empty revert) is no such function now. Each shape is
// what a read sees: a Contract call on a JsonRpcProvider whose node
// answers the eth_call as scripted.
import { expect } from "chai";
import { ethers } from "hardhat";
import { Scripted } from "./D-1c-common";

const { noSuchFunction } = require("../../demo/utils/HandoverChecks");

const ABI = ["function investor() view returns (address)"];
const AT = "0x" + "11".repeat(20);

/** The error a read of investor() throws when the node answers `answer`. */
async function readError(answer: any) {
  const p = new Scripted(answer);
  try {
    await new ethers.Contract(AT, ABI, p).investor();
  } catch (e) {
    return e;
  } finally {
    p.destroy();
  }
  throw new Error("the scripted read did not fail");
}

/** Node faults: none of them says the function is missing. */
const faults: [string, any][] = [
  [
    "-32000 missing trie node",
    { code: -32000, message: "missing trie node abc (path )" },
  ],
  [
    "-32000 'execution reverted: missing trie node'",
    { code: -32000, message: "execution reverted: missing trie node" },
  ],
  ["-32005 rate limit", { code: -32005, message: "rate limit exceeded" }],
  ["-32016 execution timeout", { code: -32016, message: "execution timeout" }],
  ["-32603 internal error", { code: -32603, message: "internal error" }],
  [
    "-32603 internal error, data 0x",
    { code: -32603, message: "internal error", data: "0x" },
  ],
  ["-32000 out of gas", { code: -32000, message: "out of gas" }],
  [
    "-32000 gas required exceeds allowance",
    { code: -32000, message: "gas required exceeds allowance (50000000)" },
  ],
  [
    "3 'execution reverted' without data",
    { code: 3, message: "execution reverted" },
  ],
];

const SELECTOR =
  "Error: Transaction reverted: function selector was not recognized and there's no fallback function";

/** The missing selector, as nodes answer it (G4, measured). */
const genuine: [string, any][] = [
  [
    "an empty revert (code 3, data 0x)",
    { error: { code: 3, message: "execution reverted", data: "0x" } },
  ],
  [
    "a Hardhat node (-32603, data.data 0x)",
    {
      error: {
        code: -32603,
        message: SELECTOR,
        data: { message: SELECTOR, data: "0x" },
      },
    },
  ],
  ["no code at the address (result 0x)", { result: "0x" }],
];

describe("D-1e noSuchFunction through ethers' JsonRpcProvider", function () {
  for (const [name, error] of faults) {
    it(`${name} is a fault, not a missing function`, async function () {
      const e: any = await readError({ error });
      expect(e.code).to.equal("CALL_EXCEPTION");
      expect(noSuchFunction(e)).to.equal(false);
    });
  }
  for (const [name, answer] of genuine) {
    it(`${name} is no such function`, async function () {
      expect(noSuchFunction(await readError(answer))).to.equal(true);
    });
  }
});

// G4 ISSUES 2/3: each branch refuses what is not its missing-selector
// shape, so a branch read as "always true" fails here.
const pe = (m: string, code: any, data?: any) =>
  Object.assign(new Error(m), { code, data });
const refused: [string, any][] = [
  [
    "CALL_EXCEPTION with revert data",
    ethers.makeError("x", "CALL_EXCEPTION", {
      action: "call",
      data: "0x08c379a0",
      reason: null,
      transaction: {},
      invocation: null,
      revert: null,
    } as any),
  ],
  [
    "BAD_DATA with a value other than 0x",
    ethers.makeError("x", "BAD_DATA", { value: "0x00", info: {} } as any),
  ],
  ["-32603 without data", pe("internal error", -32603)],
  ["-32603 with data 0x but no data.data", pe("internal error", -32603, "0x")],
  ["-32000 out of gas with data 0x", pe("out of gas", -32000, "0x")],
  ["-32000 missing trie node", pe("missing trie node", -32000)],
  ["3 without data", pe("execution reverted", 3)],
];

describe("D-1e noSuchFunction refuses near misses", function () {
  for (const [name, e] of refused) {
    it(`refuses ${name}`, function () {
      expect(noSuchFunction(e)).to.equal(false);
    });
  }
});
