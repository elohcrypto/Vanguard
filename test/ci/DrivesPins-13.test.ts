import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 13 (item D, R13-C4): the round-12 gate rules lane G's
 * g-mutate12.py mutated without a shipped test failing
 * (swarm-12/G/out/g-mutants-12-fast.txt), one pin each. Under R13-C1 a
 * run line outside the drive jobs is a table entry, so each pin lists its
 * line in a copy of the shipped table (as a PR would) and shows the rule
 * still guards what a listed line runs; the script pins need no new line
 * (the shipped `npm run gas:claims` reaches them).
 */
describe("drives-once pins, round 13 (lane G's round-12 survivors)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const { check, drives, scriptsOf } = require("../../scripts/ci/drives-once");
  const lines = require("../../scripts/ci/drives-lines");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const names = drives(path.join(ROOT, "scripts/ci"));
  const load = () => yaml.load(CI);
  const DRIVE = "scripts/ci/deploy-drive.sh";
  const has = (got: string[], w: string) => expect(got.join("\n")).to.contain(w);
  /** The shipped package.json changed by `f` (and files by `more`): its scripts. */
  const repo = (f: (p: any) => void, more?: (root: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-13-"));
    const p = JSON.parse(JSON.stringify(PKG));
    f(p);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(p));
    more?.(root);
    return scriptsOf(root);
  };
  /** The workflow with `run` added to `job`, checked against the table with it listed. */
  const listed = (run: string, scripts: any, job = "gates", env?: any) => {
    const d = load();
    d.jobs[job].steps.push(env ? { run, env } : { run });
    const tab = lines.table(ROOT);
    tab[job].run.add(run);
    return check(d, names, scripts, tab);
  };
  const outside = (run: string) => `gates step "${run}" runs a drive outside demo and deploy-drives`;
  const ws = (pkg: any) => (root: string) => {
    fs.mkdirSync(path.join(root, "packages/x"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/x/package.json"), JSON.stringify(pkg));
  };

  for (const [id, run, f] of [
    ["P-B08", "npm tst", (p: any) => (p.scripts.test = DRIVE)],
    ["P-B15", "npm t", (p: any) => (p.scripts.test = DRIVE)],
    ["P-B10", "bunx x", (p: any) => (p.bin = { x: DRIVE })],
    ["P-B11", "pnpm dlx x", (p: any) => (p.bin = { x: DRIVE })],
    ["P-B20", "npx x", (p: any) => Object.assign(p, { name: "x", bin: DRIVE })],
  ] as [string, string, (p: any) => void][])
    it(`${id}: a listed \`${run}\` whose script runs a drive is refused by name`, function () {
      has(listed(run, repo(f)), outside(run));
    });

  it("P-B17: workspaces given as { packages } are read", function () {
    const s = repo((p) => (p.workspaces = { packages: ["packages/*"] }), ws({ name: "x", scripts: { a: DRIVE } }));
    has(listed("npm run a -w x", s), outside("npm run a -w x"));
  });
  it("P-B21: a script name the root and a workspace both define reads both lines", function () {
    const s = repo((p) => Object.assign(p, { workspaces: ["packages/*"], scripts: { ...p.scripts, a: DRIVE } }), ws({ name: "x", scripts: { a: "echo" } }));
    has(listed("npm run a", s), outside("npm run a"));
  });

  const gas = (line: string) => check(load(), names, repo((p) => (p.scripts["gas:claims"] = line)));
  for (const [id, line, m] of [
    ["P-B23", "node --eval 1", "node --eval"],
    ["P-B24", "node -p 1", "node -p"],
    ["P-B25", "node --print 1", "node --print"],
    ["P-B28", "dash -c x", "dash -c"],
    ["P-B28z", "zsh -c x", "zsh -c"],
    ["P-B29", "node --no-warnings -e 1", "node --no-warnings -e"],
  ])
    it(`${id}: the listed \`npm run gas:claims\` reaching \`${line}\` builds a command, refused by name`, function () {
      has(gas(line), `tests step "Gas ratchet (transfer gas table)" builds a command at run time (${m})`);
    });

  it("P-B36: an integer matrix value joined to a path not under scripts/ci is a name built at run time", function () {
    has(listed("bash ${{ matrix.shard }}/run.sh", {}, "tests"), 'tests step "bash ${{ matrix.shard }}/run.sh" builds a name at run time');
  });
  it("P-B37: an expression written without spaces is read as one", function () {
    has(listed("echo ${{env.X}}", {}, "tests"), 'tests step "echo ${{env.X}}" expands ${{env.X}} in its run line');
  });
  for (const [id, k] of [["P-B38", "BASHOPTS"], ["P-B40", "ENV"]])
    it(`${id}: ${k} in a listed step's env is refused by name`, function () {
      has(listed("npm ci", {}, "gates", { [k]: "x" }), `gates step "npm ci" sets env ${k}`);
    });
});
