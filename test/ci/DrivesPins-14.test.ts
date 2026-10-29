import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 14 (item C, R14-C6): the gate survivors of lane G's round-13
 * lever (swarm-13/G/out/g-mutants-13-all.txt) its own kill rows kill
 * (g-kill-13.txt), one pin each: D18 (the verdict reads names only), L31
 * (a second workflow that is no YAML accepted), L23 and L26 (an .npmrc in
 * node_modules or .git read), L29 (any verdict "names a drive"), L01 (the
 * table's run entries untrimmed). Lane G's K-D21 is DrivesAllow-14's
 * second-workflow control. And the round-14 lever's Z14-15 (a second
 * workflow that is no mapping no longer read as an empty one).
 */
describe("drives-once pins, round 14 (lane G's round-13 survivors)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const { check, drives, others, scriptsOf } = require("../../scripts/ci/drives-once");
  const lines = require("../../scripts/ci/drives-lines");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const names = drives(path.join(ROOT, "scripts/ci"));
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-14-"));
  const put = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  it("P-D18: a listed npm ci whose postinstall runs the drives by a glob is refused by name", function () {
    const root = tmp();
    put(root, "package.json", JSON.stringify({ name: "x", scripts: { postinstall: "bash scripts/ci/*-drive*.sh" } }));
    expect(check(yaml.load(CI), names, scriptsOf(root)).join("\n")).to.contain(
      'gates step "Install dependencies" runs npm ci, whose postinstall script runs a drive',
    );
  });

  it("P-L31: a second workflow that is no YAML is refused by name", function () {
    const dir = tmp();
    put(dir, "ci.yml", CI);
    put(dir, "w2.yml", "jobs: [unclosed\n  x: {\n");
    expect(others(dir, path.join(dir, "ci.yml"), names)).to.deep.equal([`${path.join(dir, "w2.yml")} is not YAML`]);
  });

  for (const [id, at] of [
    ["P-L23", "node_modules/x/.npmrc"],
    ["P-L26", ".git/.npmrc"],
  ])
    it(`${id}: an .npmrc under ${at.split("/")[0]} is not read`, function () {
      const root = tmp();
      put(root, at, "script-shell=./x\n");
      expect(lines.npmrc(root)).to.deep.equal([]);
    });

  it("P-L29: an env value that builds a command names no drive", function () {
    const doc = yaml.load(CI);
    doc.jobs.gates.steps.find((s: any) => s.run === "npm ci").env = { X: "bash -c ls" };
    expect(check(doc, names)).to.deep.equal([]);
  });

  // The round-14 lever's own survivor (r14/mutants-14-full-gate-s0.txt).
  it("P-Z15: an empty or one-scalar second workflow runs nothing and passes", function () {
    const dir = tmp();
    put(dir, "ci.yml", CI);
    put(dir, "w2.yml", "");
    put(dir, "w3.yml", "just text\n");
    expect(others(dir, path.join(dir, "ci.yml"), names)).to.deep.equal([]);
  });

  it("P-L01: a table entry with trailing blanks lists the trimmed line", function () {
    const root = tmp();
    put(root, lines.TABLE, JSON.stringify([{ job: "gates", run: "echo hi  " }]));
    expect(lines.unlisted(lines.table(root), "gates", { run: "echo hi" })).to.deep.equal([]);
  });
});
