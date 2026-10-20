import { expect } from "chai";
import { network } from "hardhat";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handoverFixture } from "../helpers/governanceFixture";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import {
  countWith,
  diffScans,
  scanUrls,
} from "../../scripts/production/scanCount";

/**
 * Task 5.15 (readiness review L-7): scripts/production/scanCount.ts counts
 * the raw hits of every event scan the ceremony's read-only phase makes,
 * per reader and logChunk, and flags a scan whose count differs: a
 * provider that silently drops logs per call is caught.
 */
describe("scan-count (scripts/production/scanCount.ts)", function () {
  this.timeout(600_000);

  it("equal counts on honest readers and chunk sizes; a dropping provider is flagged", async function () {
    const f = await handoverFixture();
    const { cfg, cfgPath, dir } = await cliConfig(f);
    try {
      await captured([], () => runHandover(cfg, "full", cfgPath));
      const p: any = network.provider;
      const raw = p.request.bind(p);
      const honest = (m: string, a: any[]) => raw({ method: m, params: a });
      // Drops the last log of any eth_getLogs answer over 2 logs (a cap).
      const lossy = async (m: string, a: any[]) => {
        const out = await honest(m, a);
        return m === "eth_getLogs" && out.length > 2 ? out.slice(0, -1) : out;
      };
      const dbg: string[] = [];
      const head = Number(await honest("eth_blockNumber", []));
      const audit = (chunk: number) => () =>
        captured(dbg, () =>
          runHandover({ ...cfg, logChunk: chunk }, "audit", cfgPath),
        ).then(() => undefined);
      const runs = [];
      for (const [label, read, chunk] of [
        ["a/1000", honest, 1000],
        ["a/100", honest, 100],
        ["b/1000", lossy, 1000],
      ] as const)
        runs.push({ label, ...(await countWith(read, head, audit(chunk))) });
      expect(runs[0].error).to.equal(undefined);
      expect(runs[1].error).to.equal(undefined);
      // The ceremony fails closed on the dropping provider; counts show where.
      expect(runs[2].error?.message).to.match(/audit failed/);
      expect(dbg.join("\n")).to.contain(
        "event scan found none of the holders it must see",
      );
      const same = await diffScans(runs.slice(0, 2));
      expect(same.scans).to.be.greaterThan(10);
      expect(same.diffs, same.lines.join("\n")).to.equal(0);
      const lossyDiff = await diffScans(runs);
      expect(lossyDiff.diffs).to.be.greaterThan(0);
      expect(lossyDiff.lines.join("\n")).to.match(
        /❌ \d+ \| \d+ \| \d+  \w+ @ 0x/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task 5.16: the URLs also come from a 0600 file, never a typed line.
  it("reads SCAN_RPC_URLS_FILE (0600) and refuses a file others can read", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-urls-"));
    const keep = {
      urls: process.env.SCAN_RPC_URLS,
      file: process.env.SCAN_RPC_URLS_FILE,
    };
    try {
      const file = path.join(dir, "urls");
      fs.writeFileSync(file, "http://a.example/k1,\nhttp://b.example/k2\n", {
        mode: 0o600,
      });
      delete process.env.SCAN_RPC_URLS;
      process.env.SCAN_RPC_URLS_FILE = file;
      expect(scanUrls()).to.deep.equal([
        "http://a.example/k1",
        "http://b.example/k2",
      ]);
      fs.chmodSync(file, 0o644);
      expect(() => scanUrls()).to.throw(
        /SCAN_RPC_URLS_FILE must be this user's own file, mode 0600/,
      );
      delete process.env.SCAN_RPC_URLS_FILE;
      process.env.SCAN_RPC_URLS = "http://c.example,http://d.example";
      expect(scanUrls()).to.deep.equal(["http://c.example", "http://d.example"]);
    } finally {
      for (const [k, v] of [
        ["SCAN_RPC_URLS", keep.urls],
        ["SCAN_RPC_URLS_FILE", keep.file],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
