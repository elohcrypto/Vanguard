import { expect } from "chai";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Plan v2 Task 4.13: scripts/handover.ts on a fresh node, as an operator
 * runs it (`hardhat run --network`), with a handover.json that names
 * only the allowed keys; a config naming a derived address wrongly is
 * refused. The node is this test's own (HANDOVER_TEST_PORT, default
 * 8547), never the lead's 8545. The fixture is deployed by
 * test/production/deployHandoverFixture.ts over the same RPC.
 */
describe("Handover CLI on a fresh node (Task 4.13)", function () {
  this.timeout(600_000);
  const port = Number(process.env.HANDOVER_TEST_PORT || 8547);
  const rpc = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handover-node-"));
  const cfgPath = path.join(dir, "handover.json");
  let node: ReturnType<typeof spawn> | null = null;

  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("npx", ["hardhat", "run", ...args, "--network", "devnode"], {
      encoding: "utf8",
      env: { ...process.env, DEMO_RPC_URL: rpc, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });

  before(async function () {
    // M-5: the binary itself, in its own process group, so after() kills
    // the node and not just an npx wrapper.
    node = spawn(
      path.join("node_modules", ".bin", "hardhat"),
      ["node", "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    const up = async () => {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      }).catch(() => null);
      return Boolean(r && r.ok);
    };
    for (let i = 0; i < 60 && !(await up()); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(await up(), `no node on ${rpc}`).to.equal(true);
    const d = run(["test/production/deployHandoverFixture.ts"], {
      HANDOVER_FIXTURE_OUT: cfgPath,
    });
    expect(d.status, `${d.stdout}\n${d.stderr}`).to.equal(0);
  });

  after(async function () {
    if (node && node.pid) {
      try {
        process.kill(-node.pid, "SIGTERM");
      } catch {
        node.kill("SIGTERM");
      }
    }
    // The port must be closed before the test ends (no orphan).
    const closed = async () =>
      (await fetch(rpc, { method: "POST", body: "{}" }).catch(() => null)) ===
      null;
    for (let i = 0; i < 30 && !(await closed()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await closed(), `node still listening on ${rpc}`).to.equal(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("completes with a config that names only the allowed keys", function () {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(Object.keys(cfg).sort()).to.deep.equal(
      [
        "attestors",
        "extraTrusted",
        "governance",
        "guardian",
        "issuerAdmin",
        "logChunk",
        "ops",
        "oracleNodes",
        "proposer",
        "voters",
      ].sort(),
    );
    const r = run(["scripts/handover.ts"], { HANDOVER_CONFIG: cfgPath });
    expect(r.status, `${r.stdout}\n${r.stderr}`).to.equal(0);
    expect(r.stdout).to.include(
      "✅ Handover complete: the deployer holds no power.",
    );
    expect(r.stdout).to.not.include("❌");
  });

  it("refuses a config naming a derived address wrongly, sending nothing", function () {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.token = "0x000000000000000000000000000000000000dEaD";
    const wrong = path.join(dir, "wrong.json");
    fs.writeFileSync(wrong, JSON.stringify(cfg));
    const r = run(["scripts/handover.ts"], { HANDOVER_CONFIG: wrong });
    expect(r.status).to.equal(1);
    expect(`${r.stdout}${r.stderr}`).to.match(
      /config "token" names 0x000000000000000000000000000000000000dEaD, but governance.boundTarget\(3\) \(TokenParameters\) is 0x/,
    );
    cfg.token = undefined;
    cfg.treasury = "0x000000000000000000000000000000000000dEaD";
    fs.writeFileSync(wrong, JSON.stringify(cfg));
    const u = run(["scripts/handover.ts"], { HANDOVER_CONFIG: wrong });
    expect(u.status).to.equal(1);
    expect(`${u.stdout}${u.stderr}`).to.include('unknown key "treasury"');
  });
});
