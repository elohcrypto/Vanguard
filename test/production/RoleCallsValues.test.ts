import { expect } from "chai";
import { ethers } from "hardhat";

const {
  batchFile,
  batchProblems,
  callOf,
} = require("../../demo/utils/RoleCalls");

/**
 * Task 5.17 slice C (deep review, RoleCalls): a role call's arguments
 * reach the Safe batch's contractInputsValues as Safe Transaction
 * Builder reads them. String(array) rendered ["0xA", "0xB"] as "0xA,0xB",
 * which the builder does not parse; an array or tuple is now its JSON
 * array (numbers as decimal strings), a scalar its plain string.
 */
describe("Role calls: Safe input values for arrays and tuples", function () {
  it("renders arrays and tuples as JSON arrays, scalars as strings", async function () {
    const [a, b] = (await ethers.getSigners()).map((s) => s.address);
    const contract = new ethers.Contract(
      b,
      [
        "function setMany(address[] wallets, uint256 cap, bool on, (uint8 kind, address who)[] rules)",
      ],
      ethers.provider,
    );
    const call = await callOf({
      id: "t.1",
      role: { address: a },
      roleLabel: "ops",
      contract,
      name: "Probe",
      fn: "setMany",
      args: [[a, b], 7n, true, [[1n, a]]],
      purpose: "probe",
    });
    expect(call.args).to.deep.equal([
      JSON.stringify([a, b]),
      "7",
      "true",
      JSON.stringify([["1", a]]),
    ]);
    const batch = batchFile(31337, [call], "probe");
    expect(batch.transactions[0].contractInputsValues).to.deep.equal({
      wallets: JSON.stringify([a, b]),
      cap: "7",
      on: "true",
      rules: JSON.stringify([["1", a]]),
    });
    expect(batchProblems(batch)).to.deep.equal([]);
    // The encoded call is the arguments' own, whatever the display.
    expect(call.data).to.equal(
      contract.interface.encodeFunctionData("setMany", [
        [a, b],
        7n,
        true,
        [[1n, a]],
      ]),
    );
  });
});
