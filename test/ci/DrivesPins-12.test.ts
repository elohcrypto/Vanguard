import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 12 (item D, lane G's GPIN11-1): the round-11 gate rules lane
 * G's g-mutate11.py mutated without a shipped test failing, one pin each
 * (swarm-11/G/attack-u2r11-pins.test.js, kill-check out/g-kill-ci-11.txt;
 * the row names the mutant), and R12-C5's integer-matrix rule.
 */
describe("drives-once pins, round 12 (lane G's round-11 survivors, R12-C5)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const { check, drives, others, actions } = require("../../scripts/ci/drives-once");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const names = drives(path.join(ROOT, "scripts/ci"));
  const load = () => yaml.load(CI);
  const DRIVE = "scripts/ci/deploy-drive.sh";
  const SHA = "0".repeat(40);
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-12-"));
  const has = (got: string[], w: string) => expect(got.join("\n")).to.contain(w);

  const demoEnv = (k: string, v: string) => {
    const d = load();
    d.jobs.demo.env = { ...d.jobs.demo.env, [k]: v };
    return check(d, names);
  };
  for (const [id, k, v, shape] of [
    ["P-D07", "DEMO_RPC_URL", "http://127.0.0.1:8545/evil", "a http://127.0.0.1:<port> URL"],
    ["P-D08", "DEMO_RPC_URL", "xhttp://127.0.0.1:8545", "a http://127.0.0.1:<port> URL"],
    ["P-D09", "DEMO_SMOKE_OUT", "/tmp/a/../../etc/x", "a /tmp/<name>.json file"],
    ["P-D10", "DEMO_SMOKE_OUT", "/tmp/x.json.sh", "a /tmp/<name>.json file"],
  ])
    it(`${id}: the demo job's ${k} ${v} is refused by name (the shape is anchored)`, function () {
      has(demoEnv(k, v), `demo job env ${k} is ${v}, not ${shape}`);
    });

  /** The faults of one local action whose single step is `step`. */
  const act = (text: string, scripts = {}) => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "p"));
    fs.writeFileSync(path.join(d, "p/action.yml"), text);
    return { at: path.join(d, "p/action.yml"), got: actions(d, names, scripts) };
  };
  const comp = (step: string) => `runs:\n  using: composite\n  steps:\n    - ${step}\n      shell: bash\n`;

  it("P-D11: an action step pinned by a short ref is refused by name", function () {
    const { at, got } = act(`runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@abc123\n`);
    has(got, `${at} step "actions/setup-node@abc123" uses actions/setup-node@abc123, not setup-node, download-artifact or cache/restore`);
  });

  for (const [id, w] of [["P-D14", "GITHUB_PATH"], ["P-D15", "BASH_ENV"], ["P-D16", "GITHUB_ENV"]])
    it(`${id}: an action run naming only ${w} is refused by name`, function () {
      const { at, got } = act(comp(`run: echo x >> $${w}`));
      has(got, `${at} step "echo x >> $${w}" names GITHUB_ENV, BASH_ENV or GITHUB_PATH`);
    });

  const gates = (run: string, scripts: any) => {
    const d = load();
    d.jobs.gates.steps.push({ run });
    return check(d, names, scripts);
  };
  const outside = (run: string) => `gates step "${run}" runs a drive outside demo and deploy-drives`;
  for (const [id, run, k] of [
    ["P-D17", "npm run-script drives", "drives"],
    ["P-D18", "npm test", "test"],
    ["P-D18b", "npm start", "start"],
    ["P-D20", "npm run --silent drives", "drives"],
  ])
    it(`${id}: \`${run}\` whose script runs a drive is refused by name`, function () {
      has(gates(run, { [k]: DRIVE }), outside(run));
    });

  for (const [id, run] of [
    ["P-D22", "scripts/ci/deploy-drive.s?"],
    ["P-D23", "scripts/ci/deploy-drive.[s]h"],
  ])
    it(`${id}: a glob (${run}) into scripts/ci naming a drive is refused by name`, function () {
      has(gates(run, {}), outside(run));
    });

  it("P-D25: a script that only ends in a drive's name is no drive run", function () {
    expect(gates("echo notdeploy-drive.sh", {})).to.deep.equal([]);
  });

  const wf = (text: string, scripts = {}) => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "ci.yml"), "x: 1");
    fs.writeFileSync(path.join(d, "w.yml"), text);
    return { at: path.join(d, "w.yml"), got: others(d, path.join(d, "ci.yml"), names, scripts) };
  };
  it("P-D26: a quoted, capitalised drive job key in a second workflow is refused by name", function () {
    const { at, got } = wf('on: push\njobs:\n  "Deploy-Drives":\n    steps: []\n');
    has(got, `${at} runs a drive script or names a drive job`);
  });

  it("P-D40: a second workflow running an npm script that runs a drive is refused by name", function () {
    const { at, got } = wf("on: push\njobs:\n  a:\n    steps:\n      - run: npm run drives\n", { drives: DRIVE });
    has(got, `${at} runs a drive script or names a drive job`);
  });

  it("P-D41: an action running an npm script that runs a drive is refused by name", function () {
    const { at, got } = act(comp("run: npm run drives"), { drives: DRIVE });
    has(got, `${at} runs a drive script: drives run only in the drive jobs`);
  });

  it("P-D42: an action step using actions/checkout is refused by name", function () {
    const { at, got } = act(`runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@${SHA}\n`);
    has(got, `uses actions/checkout@${SHA}, not setup-node, download-artifact or cache/restore`);
    has(got, at);
  });

  // Round 12's own gate rules the round-12 lever found unpinned.
  it("P-Z40: a package script a run line reaches that builds a command is refused by name", function () {
    has(gates("npm run x", { x: `node -e "require('child_process').execSync('x')"` }), 'gates step "npm run x" builds a command at run time (node -e)');
  });
  it("P-Z60: a script that runs another script that runs a drive is read through", function () {
    has(gates("npm run drives", { drives: "npm run a", a: `echo a && ${DRIVE}` }), outside("npm run drives"));
  });
  it("P-Z56: an action run that builds a command is refused by name", function () {
    const { at, got } = act(comp('run: bash -c "$X"'));
    has(got, `${at} step "bash -c "$X"" builds a command at run time`);
  });

  // Round 12's shellEnv refuses BASH_ENV in every env, so round 10's pins
  // of the drive jobs' env allow-list (BASH_ENV) no longer tell it apart.
  it("P-X15 (kills X15, G10-G69): a drive job env name off the allow-list is refused by name", function () {
    has(demoEnv("FOO", "1"), "demo job sets env FOO");
  });
  it("P-X16 (kills X16, G10-G70): a drive step env name off the allow-list is refused by name", function () {
    const d = load();
    const s = d.jobs.demo.steps.find((x: any) => x.run);
    s.env = { ...s.env, FOO: "1" };
    has(check(d, names), `demo step "${s.name ?? s.run}" sets env FOO`);
  });

  // R12-C5: a run line outside the drive jobs may expand ${{ matrix.<k> }}
  // only when that job's strategy.matrix.<k> is a literal integer list.
  const matrix = (m: any, run = "TEST_SHARD=${{ matrix.shard }}/2 npm test") => {
    const d = load();
    d.jobs.tests.strategy.matrix = m;
    d.jobs.tests.steps.push({ run });
    return check(d, names);
  };
  const expands = (run: string) => `tests step "${run}" expands \${{ matrix.shard }} in its run line`;
  it("P-C5a: the shipped integer matrix passes", function () {
    expect(matrix({ shard: [1, 2] })).to.deep.equal([]);
  });
  it("P-C5b: a string matrix value is refused by name", function () {
    has(matrix({ shard: [1, "2"] }), expands("TEST_SHARD=${{ matrix.shard }}/2 npm test"));
  });
  it("P-C5c: a matrix with include (or exclude) is refused by name", function () {
    has(matrix({ shard: [1, 2], include: [{ shard: 3 }] }), expands("TEST_SHARD=${{ matrix.shard }}/2 npm test"));
    has(matrix({ shard: [1, 2], exclude: [{ shard: 2 }] }), expands("TEST_SHARD=${{ matrix.shard }}/2 npm test"));
  });
  it("P-C5d: a matrix list given as an expression is refused by name", function () {
    has(matrix({ shard: "${{ fromJSON(vars.S) }}" }), expands("TEST_SHARD=${{ matrix.shard }}/2 npm test"));
  });
  it("P-C5e: lane G's P10b (env) and P10c (a string matrix) stay refused", function () {
    const env = load();
    env.jobs.gates.env = { X: DRIVE };
    env.jobs.gates.steps.push({ run: "${{ env.X }}" });
    has(check(env, names), 'gates step "${{ env.X }}" expands ${{ env.X }} in its run line');
    const mx = load();
    mx.jobs.gates.strategy = { matrix: { x: [DRIVE] } };
    mx.jobs.gates.steps.push({ run: "${{ matrix.x }}" });
    has(check(mx, names), 'gates step "${{ matrix.x }}" expands ${{ matrix.x }} in its run line');
  });
});
