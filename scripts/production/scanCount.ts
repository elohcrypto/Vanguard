/**
 * scan-count (plan v2 Task 5.15, readiness review L-7; 5.8 step 4's
 * cross-check): the raw hits of every event scan the ceremony makes, per
 * RPC and per logChunk, diffed. A provider that silently caps or drops
 * logs per call shows up as a scan with fewer hits at one chunk size or
 * on one provider than on the others; the ceremony would read such a
 * short scan as "no stray".
 *
 *   SCAN_RPC_URLS=<provider>,<own node> SCAN_CHUNKS=5000,1000 \
 *     HANDOVER_CONFIG=<handover.json> [HANDOVER_SNAPSHOT_SHA256=..] \
 *     npx hardhat run scripts/production/scanCount.ts --network remote
 *
 * For each URL and chunk the ceremony's read-only phase runs (the day-2
 * audit once governance owns the plan, the preflight before) with every
 * chain read sent to that URL (accounts still come from the signer) and
 * eth_blockNumber pinned to one head for all runs; each eth_getLogs
 * (address or "any", topics) adds its hits to that scan's count. Prints
 * one row per scan, the event named from the compiled ABIs, and exits 1
 * when any scan's count differs between runs. URLs are printed redacted
 * (rpcCheck.redactUrl: provider keys live in them).
 */
import * as fs from "fs";
import { artifacts, ethers, network } from "hardhat";
import { runHandover } from "../handover";

const { installRetry } = require("../../demo/utils/RpcRetry");
const { redactUrl, scrub } = require("./rpcCheck");

type Reader = (method: string, params: any[]) => Promise<any>;

/** A reader sending every call to `url` (errors keep their words). */
export function urlReader(url: string): Reader {
  let id = 1;
  return async (method, params) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    const body: any = await r.json();
    if (body.error)
      throw new Error(scrub(`${body.error.code} ${body.error.message}`, url));
    return body.result;
  };
}

const OWN = new Set([
  "eth_accounts",
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
]);

/**
 * Run `once()` with the provider's reads sent to `read`, eth_blockNumber
 * answering `head`: the hits per scan key it saw, and the phase's error
 * if it failed (a provider that drops logs makes the ceremony fail
 * closed; the counts still show where).
 */
export async function countWith(
  read: Reader,
  head: number,
  once: () => Promise<void>,
) {
  const p: any = network.provider;
  const [request, send] = [p.request.bind(p), p.send?.bind(p)];
  const hits = new Map<string, number>();
  const handle = async (method: string, params: any[] = []) => {
    if (OWN.has(method)) return request({ method, params });
    if (method === "eth_blockNumber") return ethers.toQuantity(head);
    const out = await read(method, params);
    if (method === "eth_getLogs") {
      const q = params[0] || {};
      const k = JSON.stringify({
        address: q.address ? String(q.address).toLowerCase() : "any",
        topics: (q.topics || []).map((t: any) =>
          t === null ? null : String(t).toLowerCase(),
        ),
      });
      hits.set(k, (hits.get(k) || 0) + out.length);
    }
    return out;
  };
  p.request = (a: any) => handle(a.method, a.params);
  if (send) p.send = (m: string, a: any[]) => handle(m, a);
  let error: Error | undefined;
  try {
    await once();
  } catch (e) {
    error = e as Error;
  } finally {
    p.request = request;
    if (send) p.send = send;
  }
  return { hits, error };
}

/** Event names by topic0, from the compiled ABIs. */
async function eventNames() {
  const names = new Map<string, string>();
  for (const fq of await artifacts.getAllFullyQualifiedNames()) {
    const i = new ethers.Interface((await artifacts.readArtifact(fq)).abi);
    i.forEachEvent((e) => names.set(e.topicHash, e.name));
  }
  return names;
}

/** Rows for `runs` ({ label, hits }): the counts per scan and the diffs. */
export async function diffScans(
  runs: { label: string; hits: Map<string, number> }[],
) {
  const names = await eventNames();
  const keys = [...new Set(runs.flatMap((r) => [...r.hits.keys()]))].sort();
  const lines = [`   ${runs.map((r) => r.label).join(" | ")}`];
  let diffs = 0;
  for (const k of keys) {
    const counts = runs.map((r) => r.hits.get(k) ?? 0);
    const same = counts.every((c) => c === counts[0]);
    if (!same) diffs++;
    const { address, topics } = JSON.parse(k);
    const ev = names.get(topics[0]) || topics[0] || "any event";
    lines.push(
      `   ${same ? "  " : "❌"} ${counts.join(" | ")}  ${ev} @ ${address}${topics.length > 1 ? ` (${topics.length - 1} topic filter(s))` : ""}`,
    );
  }
  return { lines, diffs, scans: keys.length };
}

async function main(): Promise<void> {
  installRetry(network.provider);
  const path = process.env.HANDOVER_CONFIG;
  const urls = (process.env.SCAN_RPC_URLS || "").split(",").filter(Boolean);
  const chunks = (process.env.SCAN_CHUNKS || "5000,1000")
    .split(",")
    .map(Number);
  if (!path || !urls.length)
    throw new Error("set HANDOVER_CONFIG and SCAN_RPC_URLS");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  const readers = urls.map(urlReader);
  const heads = await Promise.all(
    readers.map(async (r) => Number(await r("eth_blockNumber", []))),
  );
  const head = Math.min(...heads);
  console.log(`🔎 scan counts at block ${head} (heads ${heads.join(", ")})`);
  const quiet = console.log;
  const runs = [];
  let failed = 0;
  for (const [i, read] of readers.entries()) {
    for (const chunk of chunks) {
      let phase = "audit";
      const once = () => runHandover({ ...cfg, logChunk: chunk }, phase, path);
      console.log = () => {};
      let r;
      try {
        r = await countWith(read, head, once);
        if (r.error && /has not completed/.test(r.error.message)) {
          phase = "preflight";
          r = await countWith(read, head, once);
        }
      } finally {
        console.log = quiet;
      }
      if (r.error) failed++;
      runs.push({ label: `rpc${i + 1}/${chunk}`, hits: r.hits });
      console.log(
        `   rpc${i + 1} = ${redactUrl(urls[i])}, logChunk ${chunk}: ${phase}, ${r.hits.size} scans${r.error ? `; ❌ the ${phase} failed: ${scrub(r.error.message.split("\n")[0], urls[i])}` : ""}`,
      );
    }
  }
  const { lines, diffs, scans } = await diffScans(runs);
  console.log(lines.join("\n"));
  console.log(
    diffs
      ? `❌ ${diffs} of ${scans} scan(s) differ between RPCs or chunk sizes`
      : `✅ all ${scans} scans count the same on every RPC and chunk size`,
  );
  if (diffs || failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ scan-count failed: ${e.message}`);
    process.exitCode = 1;
  });
}
