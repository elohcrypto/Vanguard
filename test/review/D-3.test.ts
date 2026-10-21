// D-3: the deploy config refuses a role key (ops, guardian, issuer admin,
// proposer, voter) as a consensus node before any transaction, rather than
// the preflight after the whole deploy (HandoverNodeKeys.roleOf).
import { expect } from "chai";
import { ethers } from "hardhat";
import { resolveInputs } from "../../scripts/production/deployConfig";

describe("D-3 deploy config: role keys as nodes", function () {
  it("resolveInputs refuses ops, the guardian, the issuer admin, the proposer or a voter as a node", async function () {
    const accounts = (await ethers.getSigners()).map((s) => s.address);
    const attestor = { Ax: "1", Ay: "2" };
    const nodes = (role: number) => [accounts[1], accounts[2], accounts[role]];
    expect(() =>
      resolveInputs(
        { attestor, oracleNodes: [accounts[10], accounts[11], accounts[5]] },
        31337,
        accounts,
      ),
    ).to.throw(
      `oracleNodes[0] ${accounts[10]} is ops: a node is a key of its own (D25 b)`,
    );
    for (const [i, role] of [
      [10, "ops"],
      [11, "guardian"],
      [9, "issuerAdmin"],
      [4, "proposer"],
      [5, "voters[0]"],
      [6, "voters[1]"],
    ] as [number, string][]) {
      expect(() =>
        resolveInputs({ attestor, oracleNodes: nodes(i) }, 31337, accounts),
      ).to.throw(
        `oracleNodes[2] ${accounts[i]} is ${role}: a node is a key of its own (D25 b)`,
      );
    }
    const ok = resolveInputs({ attestor }, 31337, accounts);
    console.log(`      default nodes ${ok.oracleNodes.join(", ")}`);
    expect(ok.oracleNodes).to.deep.equal([
      accounts[1],
      accounts[2],
      accounts[3],
    ]);
  });
});
