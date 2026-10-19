/**
 * Production test runner (plan v2 Task 4.13, D48): a thin local-only
 * wrapper that runs the production test set on the in-process Hardhat
 * network and summarises it.
 *
 *   npx hardhat run scripts/production/RunProductionTests.ts
 *   npx hardhat run scripts/production/RunProductionTests.ts --quiet
 *
 * It refuses any network but hardhat/localhost: the previous runner
 * deployed to whatever --network named (the checklist once ran it against
 * mainnet) and could never pass, since its unquoted test glob and the
 * in-process deployment both failed (B M-4). It never deploys anything
 * itself: the suites below deploy their own fixtures. A JSON summary goes
 * to test-reports/production/ (the HTML report is gone: nothing read it).
 */
import { spawnSync } from "child_process";
const { scrubKnown } = require("./redact");
import * as fs from "fs";
import * as path from "path";

/**
 * Every *.test.ts / *.test.js under `dir`, sorted. Task 4.17 (BF-7):
 * spawnSync passes no shell, so a glob reached hardhat literally and
 * matched nothing; the list is expanded here instead.
 */
export function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (/\.test\.(ts|js)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

/** The production test set. */
const SUITES: Array<[string, string[]]> = [
  ["Integration Tests", testFiles("test/integration")],
  [
    "Production Simulation",
    [
      "test/production/ProductionOnboarding.test.ts",
      "test/production/ProductionResilience.test.ts",
      "test/production/ProductionDeployOps.test.ts",
    ],
  ],
];
const LOCAL = new Set(["hardhat", "localhost"]);

interface SuiteResult {
  name: string;
  passed: number;
  failed: number;
  pending: number;
  exitCode: number;
  seconds: number;
}

/** Mocha's "N passing" / "N failing" / "N pending" lines. */
function count(output: string, word: string): number {
  const m = output.match(new RegExp(`(\\d+) ${word}`));
  return m ? Number(m[1]) : 0;
}

export function runSuite(name: string, files: string[]): SuiteResult {
  const started = Date.now();
  const r = spawnSync("npx", ["hardhat", "test", ...files], {
    encoding: "utf8",
    env: { ...process.env, HARDHAT_NETWORK: "hardhat" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return {
    name,
    passed: count(out, "passing"),
    failed: count(out, "failing"),
    pending: count(out, "pending"),
    exitCode: r.status ?? 1,
    seconds: (Date.now() - started) / 1000,
  };
}

export function refuseRemoteNetwork(network: string | undefined): void {
  if (network && !LOCAL.has(network)) {
    throw new Error(
      `RunProductionTests runs the production test set locally only (network "${network}" refused): it deploys nothing; a rehearsal on a live network is scripts/production/DeployProduction.ts (Phase 5)`,
    );
  }
}

async function main(): Promise<void> {
  refuseRemoteNetwork(process.env.HARDHAT_NETWORK);
  const quiet = process.argv.includes("--quiet");
  console.log("Production test set (local, in-process Hardhat network)");
  const results = SUITES.map(([name, files]) => {
    const r = runSuite(name, files);
    console.log(
      `${r.failed === 0 && r.exitCode === 0 ? "✅" : "❌"} ${r.name}: ${r.passed} passing, ${r.failed} failing, ${r.pending} pending (${r.seconds.toFixed(1)}s)`,
    );
    return r;
  });
  const failed = results.reduce((n, r) => n + r.failed, 0);
  const broken = results.filter((r) => r.exitCode !== 0 && r.failed === 0);
  const dir = path.join(process.cwd(), "test-reports", "production");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `production-test-report-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  );
  if (!quiet) console.log(`Report: ${file}`);
  if (failed > 0 || broken.length) {
    console.log(
      `❌ ${failed} test(s) failed${broken.length ? `; ${broken.map((r) => r.name).join(", ")} did not run` : ""}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("✅ The production test set passes locally.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ ${scrubKnown(e.message)}`);
    process.exitCode = 1;
  });
}
