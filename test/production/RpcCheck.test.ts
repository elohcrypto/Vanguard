import { expect } from "chai";
import * as http from "http";
import { AddressInfo } from "net";

const { checkUrl } = require("../../scripts/production/rpcCheck");

/**
 * Task 5.15 (owner Q18 = B): scripts/production/rpcCheck.js against two
 * fake RPCs on ephemeral 127.0.0.1 ports: a pruned, range-capped,
 * rate-limiting one and an archive one.
 */
describe("rpc-check (scripts/production/rpcCheck.js)", function () {
  /** A fake RPC: `cap` max getLogs span, `pruned` below `head - 128`. */
  async function rpc(o: { pruned: boolean; cap: number; every429: number }) {
    const head = 300_000;
    let n = 0;
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        n++;
        const reply = (x: object, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id, ...x }));
        };
        if (method === "eth_blockNumber" && o.every429 && n % o.every429 === 0)
          return reply(
            { error: { code: 429, message: "Too Many Requests" } },
            429,
          );
        if (method === "eth_chainId") return reply({ result: "0xaa36a7" });
        if (method === "eth_blockNumber")
          return reply({ result: `0x${head.toString(16)}` });
        if (method === "eth_getBalance") {
          const at = Number(params[1]);
          return o.pruned && at < head - 128
            ? reply({
                error: {
                  code: -32000,
                  message: "missing trie node 0xabc (path ) <nil>",
                },
              })
            : reply({ result: "0x0" });
        }
        if (method === "eth_getLogs") {
          const q = params[0];
          const span = Number(q.toBlock) - Number(q.fromBlock) + 1;
          if (span > o.cap)
            return reply({
              error: {
                code: -32005,
                message: `block range is too large, max is ${o.cap}`,
              },
            });
          if (!q.address)
            return reply({
              error: {
                code: -32005,
                message: "query returned more than 10000 results",
              },
            });
          return reply({ result: [] });
        }
        if (method === "eth_gasPrice") return reply({ result: "0x77359400" });
        if (method === "eth_maxPriorityFeePerGas")
          return reply({ result: "0x3b9aca00" });
        if (method === "eth_getBlockByNumber")
          return reply({ result: { baseFeePerGas: "0x3b9aca00" } });
        reply({ error: { code: -32601, message: "no" } });
      });
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }

  it("reports a pruned, capped, rate-limited RPC and fails it on archive", async function () {
    const f = await rpc({ pruned: true, cap: 5_000, every429: 3 });
    try {
      const r = await checkUrl(f.url, { chain: 11155111 });
      const t = r.lines.join("\n");
      expect(r.ok).to.equal(false);
      expect(t).to.contain("✅ chain id 11155111 (want 11155111)");
      expect(t).to.match(
        /❌ archive: state at block 100000 refused: -32000 missing trie node/,
      );
      expect(t).to.contain(
        "getLogs 10000 blocks refused: -32005 block range is too large, max is 5000 (a range error: scanLogs halves)",
      );
      expect(t).to.contain(
        "✅ getLogs: up to 5000 blocks per call accepted (logChunk <= 5000)",
      );
      expect(t).to.match(
        /address-less scan of 5000 blocks refused: .*query returned more than 10000 results \(range\/cap error: halved, then capped\)/,
      );
      expect(t).to.match(
        /rate: 40 calls at once in \d+ ms: \d+ answered, \d+ refused \(\d+ rate-limit or transient, retried by RpcRetry\)/,
      );
      expect(t).to.contain(
        "gas: gasPrice 2.000 gwei, priority fee 1.000 gwei, base fee 1.000 gwei",
      );
    } finally {
      f.s.close();
    }
  });

  it("passes an archive RPC and refuses another chain", async function () {
    const f = await rpc({ pruned: false, cap: 100_000, every429: 0 });
    try {
      const r = await checkUrl(f.url, { chain: 11155111 });
      expect(r.ok, r.lines.join("\n")).to.equal(true);
      expect(r.lines.join("\n")).to.contain(
        "up to 100000 blocks per call accepted",
      );
      const other = await checkUrl(f.url, { chain: 1 });
      expect(other.ok).to.equal(false);
      expect(other.lines.join("\n")).to.contain(
        "❌ chain id 11155111 (want 1)",
      );
    } finally {
      f.s.close();
    }
  });
});
