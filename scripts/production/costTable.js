#!/usr/bin/env node
/**
 * Cost table (plan v2 Task 5.15, owner Q19 = A: a measured budget, funded
 * before the deploy). The local drives measure; this prices.
 *
 *   COST_RPC_URL=<rpc> (or COST_RPC_URL_FILE, 0600) \
 *     node scripts/production/costTable.js measure <steps.json> \
 *     <wallets.txt> <handover.json> > gas.json
 *     steps.json: [{ "step": "deploy", "from": <block>, "to": <block> }, ...]
 *     (a drive records the blocks around each step); every transaction
 *     mined in a step's blocks is summed by sender (receipts' gasUsed).
 *     wallets.txt: the role phrase's addresses, one per line (index 0 the
 *     deployer); handover.json names the roles, nodes, voters, fee wallet.
 *   node scripts/production/costTable.js table --gwei <price> gas.json...
 *     gas per step and per account, ETH at the price and with 50% headroom
 *     (Q19), per account to fund. A "deploy" step is counted twice for the
 *     deployer: the stray probe runs on a second, throwaway deploy (Q19 =
 *     A, not the cheaper same-deploy variant).
 */
"use strict";

const fs = require("fs");
const { fetchTarget, scrubKnown, urlsFrom } = require("./redact");

let id = 1;
async function rpc(url, method, params = []) {
  // Deep review L-3: credentials as Basic auth (fetch refuses them).
  const to = fetchTarget(url);
  const r = await fetch(to.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...to.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}

/** address (lower case) -> role label, from the drive's wallets and handover.json. */
function labels(wallets, h) {
  const out = new Map();
  const set = (a, l) => {
    if (a && !out.has(a.toLowerCase())) out.set(a.toLowerCase(), l);
  };
  const at = (v) => (typeof v === "string" ? v : wallets[v]);
  set(wallets[0], "deployer");
  for (const k of ["ops", "guardian", "issuerAdmin"]) set(at(h[k]), k);
  set(at(h.proposer), "proposer");
  for (const v of h.voters || []) set(at(v), `voter ${v}`);
  for (const [i, n] of (h.oracleNodes || []).entries()) set(n, `node ${i + 1}`);
  for (const f of h.feeWallets || []) set(f, "escrow fee wallet");
  wallets.forEach((a, i) => set(a, `wallet ${i}`));
  return out;
}

async function measure(url, steps, wallets, h) {
  const names = labels(wallets, h);
  const out = [];
  for (const s of steps) {
    const gas = {};
    for (let b = s.from; b <= s.to; b++) {
      const blk = await rpc(url, "eth_getBlockByNumber", [
        `0x${b.toString(16)}`,
        true,
      ]);
      for (const t of blk?.transactions || []) {
        const rc = await rpc(url, "eth_getTransactionReceipt", [t.hash]);
        const who = names.get(t.from.toLowerCase()) || t.from;
        gas[who] = (gas[who] || 0) + Number(rc.gasUsed);
      }
    }
    out.push({ step: s.step, gas });
  }
  return out;
}

/** The table's lines for measured `runs` at `gwei`. */
function table(runs, gwei) {
  const eth = (g, k = 1) => ((g * gwei * k) / 1e9).toFixed(4);
  const steps = runs.flat();
  const total = {};
  const lines = [
    `Cost table at ${gwei} gwei (fund = +50%, Q19):`,
    "  gas by step:",
  ];
  for (const s of steps) {
    const g = Object.values(s.gas).reduce((a, b) => a + b, 0);
    lines.push(
      `    ${s.step.padEnd(34)} ${String(g).padStart(12)} gas  ${eth(g)} ETH`,
    );
    for (const [who, n] of Object.entries(s.gas))
      total[who] = (total[who] || 0) + n;
    if (s.step === "deploy" && s.gas.deployer) {
      lines.push(
        `    ${"stray probe throwaway deploy".padEnd(34)} ${String(s.gas.deployer).padStart(12)} gas  ${eth(s.gas.deployer)} ETH`,
      );
      total.deployer += s.gas.deployer;
    }
  }
  lines.push("  per account to fund:");
  let all = 0;
  for (const [who, g] of Object.entries(total).sort((a, b) => b[1] - a[1])) {
    all += g;
    lines.push(
      `    ${who.padEnd(34)} ${String(g).padStart(12)} gas  ${eth(g)} ETH  fund ${eth(g, 1.5)} ETH`,
    );
  }
  lines.push(
    `    ${"total".padEnd(34)} ${String(all).padStart(12)} gas  ${eth(all)} ETH  fund ${eth(all, 1.5)} ETH`,
  );
  return lines;
}

async function main(argv) {
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  const [url] = urlsFrom("COST_RPC_URL", argv);
  if (argv[0] === "measure" && argv.length === 4 && url) {
    const wallets = fs
      .readFileSync(argv[2], "utf8")
      .split(/\s+/)
      .filter(Boolean);
    console.log(
      JSON.stringify(await measure(url, read(argv[1]), wallets, read(argv[3]))),
    );
    return 0;
  }
  const g = argv.indexOf("--gwei");
  const gwei = Number(argv[g + 1]);
  if (argv[0] === "table" && g > 0 && gwei > 0) {
    const files = argv.slice(1).filter((_, i) => i !== g - 1 && i !== g);
    console.log(table(files.map(read), gwei).join("\n"));
    return 0;
  }
  console.error(
    "usage: COST_RPC_URL=<rpc> costTable.js measure <steps.json> <wallets.txt> <handover.json> | table --gwei <price> <gas.json>...",
  );
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (c) => (process.exitCode = c),
    (e) => {
      console.error(`costTable: ${scrubKnown(e.message)}`);
      process.exitCode = 1;
    },
  );
}
module.exports = { labels, measure, rpc, table };
