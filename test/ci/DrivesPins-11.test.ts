import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

/**
 * U2 round 11 (item D): pins for the drive gate's rules lane G's lever
 * left unpinned at b7b314c (g-mutants-10.txt): G63 (the runner label is
 * the whole label), G72 (the prepare action is that path exactly), G73
 * (prepare takes no input), G74 (setup-node takes node-version and cache
 * only), G80 (an action.yaml is read). And the round-11 rules the lever
 * (tools/mutate-11.py, Ynn) found unpinned: a drive step's env value
 * (Y12), an action step's keys (Y23) and run type (Y24), an action file
 * that is not YAML (Y28), the gate reading package.json (Y29). Each
 * passes at the round-11 head.
 */
describe("drives-once pins, round 11 (lane G's round-10 survivors)", function () {
  const yaml = require("js-yaml");
  const { check, drives, actions } = require("../../scripts/ci/drives-once");
  const FILE = path.join(__dirname, "../../.github/workflows/ci.yml");
  const names = drives(path.join(__dirname, "../../scripts/ci"));
  const load = () => yaml.load(fs.readFileSync(FILE, "utf8"));
  const errs = (doc: any) => check(doc, names).join("\n");
  const prepare = (doc: any) =>
    doc.jobs.demo.steps.find((x: any) => x.uses === "./.github/actions/prepare");

  it("P-G63: a runner label with a suffix after an ubuntu label is refused by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"]["runs-on"] = "ubuntu-latest-xl";
    expect(errs(doc)).to.contain(
      "deploy-drives job runs on ubuntu-latest-xl, not a GitHub-hosted ubuntu label",
    );
  });

  it("P-G72: a local action whose path only starts with the prepare action's is refused by name", function () {
    const doc = load();
    prepare(doc).uses = "./.github/actions/prepare-x";
    expect(errs(doc)).to.contain(
      'demo step "./.github/actions/prepare-x" uses ./.github/actions/prepare-x, not',
    );
  });

  it("P-G73: an input passed to the prepare action is refused by name", function () {
    const doc = load();
    prepare(doc).with = { x: 1 };
    expect(errs(doc)).to.contain('demo step "./.github/actions/prepare" with sets x');
  });

  it("P-G74: a setup-node input beyond node-version and cache is refused by name", function () {
    const doc = load();
    const uses =
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
    doc.jobs["deploy-drives"].steps.splice(1, 0, {
      uses,
      with: { "node-version-file": ".nvmrc" },
    });
    expect(errs(doc)).to.contain(
      `deploy-drives step "${uses}" with sets node-version-file`,
    );
  });

  /** `text` as action `rel` under a fresh actions dir: its faults. */
  const action = (rel: string, text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-11-"));
    try {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
      return actions(dir, names).join("\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("P-Y12: a drive step's env value off its shipped shape is refused by name", function () {
    const doc = load();
    const step = doc.jobs.demo.steps.find((x: any) => x.run);
    step.env = { DEMO_RPC_URL: "http://10.0.0.1:8545" };
    expect(errs(doc)).to.contain(
      `demo step "${step.name}" env DEMO_RPC_URL is http://10.0.0.1:8545, not a http://127.0.0.1:<port> URL`,
    );
  });

  it("P-Y23, P-Y24: an action step's extra key, or a run that is not a string, is refused by name", function () {
    const steps = (s: string) => `runs:\n  using: composite\n  steps:\n${s}`;
    expect(
      action("p/action.yml", steps("    - run: npm ci\n      shell: bash\n      env: { X: '1' }\n")),
    ).to.contain('p/action.yml step "npm ci" sets env');
    expect(
      action("p/action.yml", steps("    - name: n\n      run: [npm ci]\n      shell: bash\n")),
    ).to.contain('p/action.yml step "n" run is not a string');
  });

  it("P-Y28: an action file that is not YAML is refused by name", function () {
    expect(action("p/action.yml", "runs: [\n")).to.contain(
      "p/action.yml is not YAML:",
    );
  });

  it("P-Y29: the gate step reads package.json: an npm script running a drive outside the drive jobs fails it by name", function () {
    const ROOT = path.join(__dirname, "../..");
    const step = load().jobs.gates.steps.find(
      (x: any) => x.name === "Every drive exactly once",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-11-"));
    try {
      const doc = load();
      doc.jobs.gates.steps.push({ name: "x", run: "npm run x" });
      fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"), yaml.dump(doc));
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ scripts: { x: "scripts/ci/deploy-drive.sh" } }),
      );
      fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(dir, "scripts/ci"), {
        recursive: true,
      });
      fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
      const r = spawnSync("bash", ["-e", "-c", step.run], {
        cwd: dir,
        encoding: "utf8",
      });
      const out = `${r.stdout}${r.stderr}`;
      expect(r.status, out).to.equal(1);
      expect(out).to.contain('gates step "x" runs a drive outside demo and deploy-drives');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P-G80: a local action written as action.yaml is read", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-11-"));
    try {
      fs.mkdirSync(path.join(dir, "p"));
      fs.writeFileSync(
        path.join(dir, "p/action.yaml"),
        "runs:\n  using: composite\n  steps:\n    - run: scripts/ci/deploy-drive.sh\n      shell: bash\n",
      );
      expect(actions(dir, names).join("\n")).to.contain(
        "p/action.yaml runs a drive script",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
