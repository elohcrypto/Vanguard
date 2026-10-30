import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 15 (item D, R15-C4): lane G's round-14 survivors its own kill
 * rows kill (swarm-14/G/out/g-kill-14.txt), one pin each: L57 (an .npmrc
 * key on a later line), L62 (gypfile set to a non-true value), L66 (a uses
 * in a job the table has no key for, in ci.yml and in a second workflow),
 * O24 (a `.yaml` second workflow); and one pin per round-15 rule of items
 * A and B that DrivesAllow-15's rows leave unguarded.
 */
describe("drives-once pins, round 15 (lane G's round-14 survivors, the round-15 rules)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const { check, drives, others } = require("../../scripts/ci/drives-once");
  const lines = require("../../scripts/ci/drives-lines");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const names = drives(path.join(ROOT, "scripts/ci"));
  const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-15-"));
  const put = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const rc = (text: string) => {
    const root = tmp();
    put(root, ".npmrc", text);
    return lines.npmrc(root);
  };
  /** The shipped table with `extra` entries, as a PR would list them. */
  const tab = (...extra: any[]) => {
    const root = tmp();
    const f = path.join(ROOT, lines.TABLE);
    put(root, lines.TABLE, JSON.stringify([...JSON.parse(fs.readFileSync(f, "utf8")), ...extra]));
    return lines.table(root);
  };

  it("P-L57: an .npmrc key on a later line is read", function () {
    expect(rc("registry=https://registry.npmjs.org/\nscript-shell=./hide.sh\n")).to.deep.equal([
      ".npmrc: an .npmrc is not allowed in this tree; npm's project config is pinned empty (R16-C1)",
    ]);
  });

  it("P-L62: a package.json gypfile of any value is refused", function () {
    const root = tmp();
    put(root, "package.json", JSON.stringify({ name: "x", gypfile: "yes" }));
    expect(lines.gyp(root)).to.deep.equal(["package.json sets gypfile"]);
  });

  it("P-L66: a uses in a ci.yml job the table has no key for is refused by name", function () {
    const doc = yaml.load(CI);
    doc.jobs.newjob = { "runs-on": "ubuntu-24.04", steps: [{ uses: CHECKOUT, with: { "persist-credentials": false } }] };
    expect(check(doc, names)).to.deep.equal([`uses not in ${lines.TABLE}: newjob: ${CHECKOUT} with {"persist-credentials":false}`]);
  });

  it("P-L66b: and in a second workflow", function () {
    const dir = tmp();
    put(dir, "ci.yml", CI);
    put(dir, "w2.yml", `name: w2\non: push\njobs:\n  nokey:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`);
    expect(others(dir, path.join(dir, "ci.yml"), names)).to.deep.equal([
      `${path.join(dir, "w2.yml")}: uses not in ${lines.TABLE}: nokey: ${CHECKOUT} with {"persist-credentials":false}`,
    ]);
  });

  it("P-O24: a `.yaml` second workflow is read", function () {
    const dir = tmp();
    put(dir, "ci.yml", CI);
    put(dir, "w2.yaml", "name: w2\non: push\nenv:\n  BASH_ENV: ./hide.sh\njobs: {}\n");
    expect(others(dir, path.join(dir, "ci.yml"), names).join("\n")).to.contain("w2.yaml: the workflow sets env BASH_ENV");
  });

  // Item B (R15-C2): envs(), the table's env literals.
  it("P-B1: an env literal is listed under its scope only", function () {
    const doc = yaml.load(CI);
    doc.jobs.gates.steps.find((s: any) => s.run === "npm ci").env = { RESULTS: "${{ toJSON(needs) }}" };
    expect(check(doc, names)).to.deep.equal([`env not in ${lines.TABLE}: gates step: {"RESULTS":"\${{ toJSON(needs) }}"}`]);
  });

  it("P-B2: an env literal ignores key order", function () {
    const doc = yaml.load(CI);
    const e = doc.jobs.demo.env;
    doc.jobs.demo.env = { DEMO_SMOKE_OUT: e.DEMO_SMOKE_OUT, DEMO_RPC_URL: e.DEMO_RPC_URL };
    expect(check(doc, names)).to.deep.equal([]);
  });

  it("P-B3: a table entry whose env is no mapping lists nothing", function () {
    const doc = yaml.load(CI);
    doc.jobs.gates.env = "${{ fromJSON(vars.X) }}";
    expect(check(doc, names, {}, tab({ at: "gates job", env: "${{ fromJSON(vars.X) }}" }))).to.deep.equal([
      `env not in ${lines.TABLE}: gates job: "\${{ fromJSON(vars.X) }}"`,
    ]);
  });

  it("P-B4: a listed env literal passes in a second workflow too", function () {
    const dir = tmp();
    put(dir, "ci.yml", CI);
    put(dir, "w2.yml", "name: w2\non: push\nenv:\n  CIRCOM_VERSION: v2.2.3\njobs: {}\n");
    expect(others(dir, path.join(dir, "ci.yml"), names)).to.deep.equal([]);
  });
});
