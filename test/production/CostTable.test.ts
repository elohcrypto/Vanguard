import { expect } from "chai";
import * as http from "http";
import { AddressInfo } from "net";

const {
  labels,
  measure,
  table,
} = require("../../scripts/production/costTable");

/**
 * Task 5.15 (owner Q19 = A): scripts/production/costTable.js sums the gas
 * a drive's steps used per sender, names the senders by role, prices it
 * with 50% headroom per account, and counts the deploy twice for the
 * deployer (the stray probe's throwaway deploy).
 */
describe("Cost table (scripts/production/costTable.js)", function () {
  const W = Array.from(
    { length: 12 },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
  );
  const h = {
    ops: 10,
    guardian: 11,
    issuerAdmin: 9,
    proposer: 4,
    voters: [5, 6],
    oracleNodes: [W[1]],
    feeWallets: [W[8]],
  };

  it("names senders by role", function () {
    const n = labels(W, h);
    expect(n.get(W[0])).to.equal("deployer");
    expect(n.get(W[10])).to.equal("ops");
    expect(n.get(W[4])).to.equal("proposer");
    expect(n.get(W[5])).to.equal("voter 5");
    expect(n.get(W[1])).to.equal("node 1");
    expect(n.get(W[8])).to.equal("escrow fee wallet");
    expect(n.get(W[7])).to.equal("wallet 7");
  });

  it("measures gas per step and sender from the blocks", async function () {
    const txs: Record<number, { from: string; hash: string; gas: number }[]> = {
      5: [{ from: W[0], hash: "0xa", gas: 1000 }],
      6: [
        { from: W[0], hash: "0xb", gas: 500 },
        { from: W[5], hash: "0xc", gas: 70 },
      ],
      9: [{ from: W[4], hash: "0xd", gas: 30 }],
    };
    const byHash: Record<string, number> = {};
    for (const l of Object.values(txs))
      for (const t of l) byHash[t.hash] = t.gas;
    const s = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(b);
        const result =
          method === "eth_getBlockByNumber"
            ? { transactions: txs[Number(params[0])] || [] }
            : { gasUsed: `0x${byHash[params[0]].toString(16)}` };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      const m = await measure(
        url,
        [
          { step: "deploy", from: 1, to: 6 },
          { step: "ceremony", from: 7, to: 9 },
        ],
        W,
        h,
      );
      expect(m).to.deep.equal([
        { step: "deploy", gas: { deployer: 1500, "voter 5": 70 } },
        { step: "ceremony", gas: { proposer: 30 } },
      ]);
      const t = table([m], 20).join("\n");
      expect(t).to.contain("Cost table at 20 gwei (fund = +50%, Q19):");
      expect(t).to.match(/stray probe throwaway deploy\s+1500 gas/);
      // deployer: 1500 x 2 = 3000 gas = 0.00006 ETH, fund 0.00009.
      expect(t).to.match(
        /deployer\s+3000 gas\s+0\.0001 ETH\s+fund 0\.0001 ETH/,
      );
      expect(t).to.match(/total\s+3100 gas/);
    } finally {
      s.close();
    }
  });
});
