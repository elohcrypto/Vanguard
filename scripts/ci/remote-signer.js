#!/usr/bin/env node
/**
 * The CI stand-in for an external signer (plan v2 Task 5.7, D48 a): a
 * second process that holds the keys, so the deploy process holds none.
 * Frame style: a JSON-RPC endpoint that answers eth_accounts with its
 * wallets, signs eth_sendTransaction itself and sends it upstream raw,
 * signs personal_sign / eth_sign (the issuers' claim signatures), and
 * forwards every other call to the chain unchanged.
 *
 *   MNEMONIC="..." SIGNER_UPSTREAM=http://127.0.0.1:8547 \
 *     node scripts/ci/remote-signer.js 8549
 *
 * The wallets are the mnemonic's first SIGNER_COUNT (12) keys, the role
 * wallets of docs/TESTNET_SETUP.md. Test tooling only: a production
 * deploy uses a real signer (scripts/production/signer.js, or Frame).
 *
 * Readiness review L-3: it refuses an upstream chain other than 31337
 * unless SIGNER_ALLOW_CHAIN names that chain id, and the published
 * Hardhat phrase off 31337 always (its keys are anyone's). Exit 3.
 */
"use strict";

const http = require("http");
const { HDNodeWallet, JsonRpcProvider, Mnemonic, getBytes } = require("ethers");

const port = Number(process.argv[2] || 8549);
const upstream = process.env.SIGNER_UPSTREAM;
const phrase = process.env.MNEMONIC;
if (!upstream || !phrase) {
  console.error("set SIGNER_UPSTREAM and MNEMONIC");
  process.exit(3);
}
// cacheTimeout -1: ethers reuses an identical call's answer for 250 ms by
// default, which hands two quick sends from one key the same nonce.
const provider = new JsonRpcProvider(upstream, undefined, {
  staticNetwork: true,
  batchMaxCount: 1,
  cacheTimeout: -1,
});
const count = Number(process.env.SIGNER_COUNT || 12);
const root = Mnemonic.fromPhrase(phrase);
const wallets = Array.from({ length: count }, (_, i) =>
  HDNodeWallet.fromMnemonic(root, `m/44'/60'/0'/0/${i}`).connect(provider),
);
const byAddress = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
let signed = 0;

/** eth_sendTransaction: sign with the sender's key, send it raw. */
async function sendTransaction(tx) {
  const w = byAddress.get(String(tx.from).toLowerCase());
  if (!w) throw new Error(`the signer holds no key for ${tx.from}`);
  const req = {
    to: tx.to || null,
    data: tx.data || tx.input || "0x",
    value: tx.value || 0,
  };
  if (tx.gas) req.gasLimit = tx.gas;
  if (tx.nonce !== undefined) req.nonce = Number(tx.nonce);
  if (tx.maxFeePerGas) req.maxFeePerGas = tx.maxFeePerGas;
  if (tx.maxPriorityFeePerGas) {
    req.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  }
  if (tx.gasPrice) req.gasPrice = tx.gasPrice;
  const sent = await w.sendTransaction(req);
  signed++;
  return sent.hash;
}

/** Any other call goes upstream as it came, its answer back verbatim. */
async function forward(call) {
  const r = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(call),
  });
  return r.json();
}

/** personal_sign [data, address] / eth_sign [address, data] (claims). */
async function signMessage(address, data) {
  const w = byAddress.get(String(address).toLowerCase());
  if (!w) throw new Error(`the signer holds no key for ${address}`);
  signed++;
  return w.signMessage(getBytes(data));
}

const OWN = {
  eth_accounts: async () => wallets.map((w) => w.address),
  eth_sendTransaction: (p) => sendTransaction(p[0]),
  personal_sign: (p) => signMessage(p[1], p[0]),
  eth_sign: (p) => signMessage(p[0], p[1]),
};

async function answer(call) {
  const { id, method, params = [] } = call;
  if (!OWN[method]) return forward(call);
  try {
    const result = await OWN[method](params);
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    const err = e.info?.error || { message: e.shortMessage || e.message };
    return {
      jsonrpc: "2.0",
      id,
      error: { code: err.code ?? -32000, message: err.message, data: err.data },
    };
  }
}

const HARDHAT_PHRASE =
  "test test test test test test test test test test test junk";

/** L-3: the upstream's chain id, refused unless 31337 or allowed. */
async function guardChain() {
  const r = await forward({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
  const chain = Number(r.result);
  if (!r.result) throw new Error(`upstream ${upstream}: no chain id`);
  const allowed = process.env.SIGNER_ALLOW_CHAIN;
  if (chain !== 31337 && String(chain) !== String(allowed ?? "").trim()) {
    throw new Error(
      `upstream ${upstream} is chain ${chain}: this test signer serves only 31337 (set SIGNER_ALLOW_CHAIN=${chain} to allow it; a deployment uses scripts/production/signer.js)`,
    );
  }
  const words = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (chain !== 31337 && words === HARDHAT_PHRASE) {
    throw new Error(
      `refusing chain ${chain}: MNEMONIC is the published Hardhat test phrase, whose keys anyone holds`,
    );
  }
  return chain;
}

guardChain().then(serve, (e) => {
  console.error(`remote signer: ${e.shortMessage || e.message}`);
  process.exit(3);
});

// Task 5.15, drives only: SIGNER_FAULTS=<n> faults every n-th request, in
// turn a rate-limit answer (-32005, not forwarded), a connection dropped
// before forwarding, and one dropped AFTER answering it (a send's outcome
// unknown to its caller); SIGNER_FAULT_SENDS=<k> drops the reply to every
// k-th eth_sendTransaction after sending it; SIGNER_SEND_DELAY_MS slows
// each send.
const every = Number(process.env.SIGNER_FAULTS || 0);
const sendEvery = Number(process.env.SIGNER_FAULT_SENDS || 0);
const delay = Number(process.env.SIGNER_SEND_DELAY_MS || 0);
const faults = { seen: 0, sends: 0, rate: 0, drop: 0, dropAfter: 0 };
const KINDS = ["rate", "drop", "dropAfter"];

/** The fault for request number n (method `m`), or null. */
function faultOf(n, m) {
  if (
    m === "eth_sendTransaction" &&
    sendEvery &&
    ++faults.sends % sendEvery === 0
  )
    return "dropAfter";
  return every && n % every === 0 ? KINDS[(n / every) % 3] : null;
}

function serve(chain) {
  http
    .createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let out;
        let kind = null;
        try {
          const call = JSON.parse(body);
          kind = faultOf(++faults.seen, call.method);
          if (kind) faults[kind]++;
          if (kind === "drop") return req.socket.destroy();
          if (kind === "rate") {
            out = {
              jsonrpc: "2.0",
              id: call.id,
              error: { code: -32005, message: "rate limit exceeded (fault)" },
            };
          } else {
            if (delay && call.method === "eth_sendTransaction")
              await new Promise((ok) => setTimeout(ok, delay));
            out = Array.isArray(call)
              ? await Promise.all(call.map(answer))
              : await answer(call);
          }
        } catch (e) {
          out = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: e.message },
          };
        }
        if (kind === "dropAfter") return req.socket.destroy();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    })
    .listen(port, "127.0.0.1", () =>
      console.log(
        `remote signer on 127.0.0.1:${port}: ${wallets.length} keys, upstream ${upstream} (chain ${chain})`,
      ),
    );
}
process.on("SIGTERM", () => {
  console.log(`remote signer: ${signed} transactions signed`);
  if (every) console.log(`remote signer faults: ${JSON.stringify(faults)}`);
  process.exit(0);
});
