import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { byVote, captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import * as fs from "fs";

const { assertHandoverComplete } = require("../../demo/utils/Handover");
const { nodeFacts } = require("../../demo/utils/HandoverNodes");

const RULES = 1; // ProposalType.ComplianceRules
const ORACLE = 2; // ProposalType.OracleParameters
const TOKEN = 3; // ProposalType.TokenParameters
const PASSED = "\n✅ Audit passed: the deployer holds no power.";

/**
 * Plan v2 Task 5.6b: HANDOVER_PHASE=audit, the day-2 re-check. It runs
 * the completion lines against the state governance derives now, with no
 * snapshot or voting window: a change made by vote passes (the accept
 * phase fails it forever, its window ended at the ceremony), any
 * deployer power or unacknowledged holder fails, and it refuses before
 * the ceremony completed.
 */
describe("Handover audit (HANDOVER_PHASE=audit, Task 5.6b)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  let dir: string;
  const out: string[] = [];
  const run = (phase: string) =>
    captured(out, () => runHandover(cfg, phase, cfgPath));
  const fails = async (phase: string, line: RegExp) => {
    out.length = 0;
    await expect(run(phase)).to.be.rejectedWith(
      phase === "audit" ? /audit failed/ : /handover incomplete/,
    );
    expect(out.join("\n")).to.match(line);
  };

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    out.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HANDOVER_SNAPSHOT_SHA256;
  });

  const nodes = async () => (await ethers.getSigners()).slice(9, 12);
  /** D50: three nodes registered by OracleParameters votes. */
  async function registerNodes(executor: any = f.proposer) {
    const om = f.c.oracleManager;
    for (const [i, n] of (await nodes()).entries()) {
      const data = om.interface.encodeFunctionData("registerOracle", [
        n.address,
        `NODE_${i + 1}`,
        "production node",
        500,
      ]);
      await byVote(f, ORACLE, om, data, executor);
    }
  }

  it("refuses before the ceremony completed, sending nothing", async function () {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(run("audit")).to.be.rejectedWith(
      /HANDOVER_PHASE=audit: the ceremony has not completed: governance does not own Token, .*; run the full phase/,
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("passes after a D50 node rotation by vote that accept fails", async function () {
    await run("full");
    out.length = 0;
    await run("audit");
    expect(out).to.include(PASSED);
    await registerNodes();
    const [n1, n2, n3] = await nodes();
    const om = f.c.oracleManager;
    await byVote(
      f,
      ORACLE,
      om,
      om.interface.encodeFunctionData("removeOracle", [n3.address, "D50"]),
    );
    process.env.HANDOVER_SNAPSHOT_SHA256 = fs
      .readFileSync(`${cfgPath}.snapshot.json.sha256`, "utf8")
      .split(" ")[0];
    // The accept phase compares with the ceremony's snapshot: a voted node
    // reads as one that appeared after the preflight.
    await fails(
      "accept",
      new RegExp(
        `❌ appeared after the preflight, not granted by the ceremony: ${n1.address} in OracleManager nodes`,
      ),
    );
    // (c) unacknowledged, the audit fails them.
    await fails(
      "audit",
      /❌ every registered OracleManager node is acknowledged in oracleNodes \(2 registered, 0 acknowledged\)/,
    );
    cfg.oracleNodes = [n1.address, n2.address];
    out.length = 0;
    await run("audit");
    expect(out).to.include(PASSED);
    expect(out.join("\n")).to.not.include("❌");
    expect(out.join("\n")).to.not.include("appeared after the preflight");
  });

  it("passes after a rule-administrator change by vote", async function () {
    await run("full");
    const rules = f.c.complianceRules;
    const vsc = await f.c.token.getAddress();
    await byVote(
      f,
      RULES,
      rules,
      rules.interface.encodeFunctionData("setRuleAdministrator", [
        vsc,
        f.ops.address,
        true,
      ]),
    );
    expect(await rules.ruleAdministrators(vsc, f.ops.address)).to.equal(true);
    out.length = 0;
    await run("audit");
    expect(out).to.include(
      "   ✅ no ComplianceRules rule administrator but governance and ops",
    );
    expect(out).to.include(PASSED);
  });

  it("fails on a deployer power re-granted by vote", async function () {
    await run("full");
    const t = f.c.token;
    await byVote(
      f,
      TOKEN,
      t,
      t.interface.encodeFunctionData("addAgent", [f.deployer.address]),
    );
    await fails("audit", /❌ deployer is not a Token agent/);
  });

  it("fails on a pending owner that is neither ops nor governance", async function () {
    await run("full");
    const t = f.c.token;
    const nominate = (a: string) =>
      byVote(
        f,
        TOKEN,
        t,
        t.interface.encodeFunctionData("transferOwnership", [a]),
      );
    await nominate(f.ops.address);
    out.length = 0;
    await run("audit");
    expect(out).to.include(
      `   ✅ Token pending owner is none, governance or ops (${f.ops.address})`,
    );
    await nominate(f.stranger.address);
    await fails(
      "audit",
      new RegExp(
        `❌ Token pending owner is none, governance or ops \\(${f.stranger.address}\\)`,
      ),
    );
  });

  it("fails on an InvestorRequestManager nominee other than ops or governance (R-56c-9)", async function () {
    await run("full");
    const irm = await f.custody.getAddress();
    const line = (ok: string) =>
      `   ${ok} registrar / officer contract ${irm} has no pending owner other than ops or governance`;
    out.length = 0;
    await run("audit");
    expect(out).to.include(line("✅"));
    await f.custody.connect(f.ops).transferOwnership(f.stranger.address);
    await fails("audit", /❌ registrar \/ officer contract .* has no pending/);
    expect(out).to.include(line("❌"));
  });

  it("trusts a node a governance execution registered, whoever sent it (D50)", async function () {
    await run("full");
    // executeProposal is permissionless: the deployer executes the votes.
    await registerNodes(f.deployer);
    const facts = await nodeFacts(f.args);
    expect(facts.nodes.map((n: any) => n.registeredBy)).to.deep.equal(
      Array(3).fill(f.deployer.address),
    );
    expect(facts.nodes.map((n: any) => n.byGovernance)).to.deep.equal(
      Array(3).fill(true),
    );
    cfg.oracleNodes = (await nodes()).map((n) => n.address);
    // The ceremony's completion names each as deployer-registered...
    const { warnings } = await assertHandoverComplete({
      ...f.args,
      oracleNodes: cfg.oracleNodes,
    });
    expect(warnings.join("\n")).to.include("was registered by the deployer");
    // ...the audit sees each registration was a governance execution.
    out.length = 0;
    await run("audit");
    expect(out).to.include(PASSED);
    expect(out.join("\n")).to.not.include("was registered by the deployer");
  });

  it("keeps D50's warning for a node the deployer registered (R-56c-1)", async function () {
    // Deployer era: the deployer registers the nodes directly, and the
    // config acknowledges them.
    const om = f.c.oracleManager.connect(f.deployer);
    for (const [i, n] of (await nodes()).entries())
      await om.registerOracle(n.address, `DEP_${i + 1}`, "deployer era", 500);
    cfg.oracleNodes = (await nodes()).map((n) => n.address);
    await run("full");
    const facts = await nodeFacts(f.args);
    expect(facts.nodes.map((n: any) => n.byGovernance)).to.deep.equal(
      Array(3).fill(false),
    );
    out.length = 0;
    await run("audit");
    const text = out.join("\n");
    for (const n of await nodes())
      expect(text).to.include(`OracleManager node ${n.address} (DEP_`);
    expect(text).to.include("was registered by the deployer");
    expect(out).to.include("\n⚠️  Audit passed with warnings: see above.");
    expect(out).to.not.include(PASSED);
  });
});
