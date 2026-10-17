import { ethers } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";

/**
 * Task 5.15: the two local signers (scripts/production/signer.js,
 * scripts/ci/remote-signer.js) as child processes on port 0, against a
 * fake upstream on an ephemeral 127.0.0.1 port that records every raw
 * transaction it is sent and answers eth_getCode with `code`.
 */
export async function fakeUpstream(chain: number, code = "0x") {
  const raws: string[] = [];
  const H = `0x${"11".repeat(32)}`;
  const answers: Record<string, (p: any[]) => unknown> = {
    eth_chainId: () => ethers.toQuantity(chain),
    eth_getTransactionCount: () => "0x5",
    eth_estimateGas: () => "0x5208",
    eth_gasPrice: () => "0x3b9aca00",
    eth_maxPriorityFeePerGas: () => "0x3b9aca00",
    eth_blockNumber: () => "0x10",
    eth_getBlockByNumber: () => ({
      number: "0x10",
      hash: H,
      parentHash: H,
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: ethers.ZeroAddress,
      extraData: "0x",
      baseFeePerGas: "0x3b9aca00",
      timestamp: "0x1",
      transactions: [],
    }),
    eth_sendRawTransaction: (p) => {
      raws.push(p[0]);
      return ethers.keccak256(p[0]);
    },
    eth_getTransactionByHash: () => null,
    eth_getCode: () => code,
  };
  const one = (c: any) =>
    answers[c.method]
      ? { jsonrpc: "2.0", id: c.id, result: answers[c.method](c.params || []) }
      : {
          jsonrpc: "2.0",
          id: c.id,
          error: { code: -32601, message: `no ${c.method}` },
        };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(call) ? call.map(one) : one(call)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, raws, url };
}

export type Live = { url: string; port: number; token: string };

/**
 * Run `script` with `env`; once it prints its listening line, `use` runs
 * with { url, port, token } (the token read from SIGNER_TOKEN_FILE, which
 * env must set), then it is stopped. Its exit code and output.
 */
export async function runSigner(
  script: string,
  env: Record<string, string>,
  use?: (live: Live) => Promise<void>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, [script, "0"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    let started = false;
    const add = (d: Buffer) => {
      text += d;
      const m = text.match(/signer on 127\.0\.0\.1:(\d+)/);
      if (!m || started) return;
      started = true;
      const port = Number(m[1]);
      const token = fs.readFileSync(env.SIGNER_TOKEN_FILE, "utf8").trim();
      (use
        ? use({ url: `http://127.0.0.1:${port}`, port, token })
        : Promise.resolve()
      ).then(
        () => p.kill("SIGTERM"),
        (e) => {
          p.kill("SIGTERM");
          ko(e);
        },
      );
    };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    p.on("exit", (code) => ok({ code, out: text }));
  });
}

/** What rpc() answers: the HTTP status, headers (lower-case) and body. */
export type RpcAnswer = {
  status: number;
  headers: Record<string, string>;
  body: any;
};

/** One JSON-RPC call: its HTTP status, headers and body. */
export async function rpc(
  live: Live,
  method: string,
  params: unknown[] = [],
  headers: Record<string, string> = {},
): Promise<RpcAnswer> {
  const r = await fetch(live.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${live.token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: any = await r.json();
  return { status: r.status, headers: Object.fromEntries(r.headers), body };
}
