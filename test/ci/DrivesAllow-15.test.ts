import { expect } from "chai";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 15 (items A, B and D's crash; lane G's round-14 rows,
 * swarm-14/G/out/ci4-attacks-14-effed74.txt; R15-C1, R15-C2, R15-C4).
 * A: the .npmrc keys were matched as raw text, but npm ini-parses the
 * file (ini 5.0.0): a quoted key, a JSON escape inside one, a key cut at
 * an unescaped ; or #, and the userconfig/globalconfig redirects are the
 * same keys to npm and passed the gate (A1-A5; r15/npm-ini-keys-15.txt).
 * B: the gate named the env keys it refused, so LD_LIBRARY_PATH,
 * NODE_PATH, HOME and an exported bash function passed (B1-B5, D2), and
 * so did an env that is no mapping (B6, B7); now every env is a table
 * literal. A job key `constructor` crashed the gate (lane G INFO).
 * Each row runs the real CLI on a copy of the shipped tree.
 */
describe("every drive exactly once: npm's .npmrc keys and the env literal (round 15)", function () {
  this.timeout(120000);
  const yaml = require("js-yaml");
  const ROOT = path.join(__dirname, "../..");
  const TABLE = "scripts/ci/run-lines.json";
  const tree = () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "drives-15-"));
    fs.cpSync(path.join(ROOT, ".github"), path.join(t, ".github"), { recursive: true });
    fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(t, "scripts/ci"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(t, "package.json"));
    return t;
  };
  const ci = (t: string) => path.join(t, ".github/workflows/ci.yml");
  const edit = (t: string, f: (d: any) => void) => {
    const d = yaml.load(fs.readFileSync(ci(t), "utf8"));
    f(d);
    fs.writeFileSync(ci(t), yaml.dump(d, { lineWidth: -1 }));
  };
  const SH = (t: string, rel: string, txt: string) => {
    fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true });
    fs.writeFileSync(path.join(t, rel), txt);
  };
  const TAB = (t: string, e: any) => {
    const f = path.join(t, TABLE);
    fs.writeFileSync(f, JSON.stringify([...JSON.parse(fs.readFileSync(f, "utf8")), e]));
  };
  const GATE = "Every drive exactly once";
  const INSTALL = "Install dependencies";
  const gstep = (t: string, name: string, f: (s: any) => void) =>
    edit(t, (d) => f(d.jobs.gates.steps.find((s: any) => s.name === name)));
  const gate = (t: string) => {
    const r = cp.spawnSync("node", [path.join(ROOT, "scripts/ci/drives-once.js"), ci(t)], { encoding: "utf8", cwd: t });
    return { code: r.status, out: `${r.stderr}${r.stdout}` };
  };
  /** `f` on a fresh copy: exit 0, or refused naming each of `want`, never by a crash. */
  const row = (title: string, f: (t: string) => void, want: "PASSES" | string[]) =>
    it(title, function () {
      const t = tree();
      try {
        f(t);
        const r = gate(t);
        expect(r.out, "no crash").not.to.match(/TypeError|ReferenceError|\n\s+at /);
        if (want === "PASSES") expect(r.code, r.out).to.equal(0);
        else {
          expect(r.code, "refused").to.equal(1);
          for (const w of want) expect(r.out).to.contain(w);
        }
      } finally {
        fs.rmSync(t, { recursive: true, force: true });
      }
    });
  const NPMRC = (t: string, text: string) => SH(t, ".npmrc", text);
  const envNot = (at: string, lit: string) => `env not in ${TABLE}: ${at}: ${lit}`;
  // Round 16 (R16-C1): any .npmrc is refused by name, its keys no longer read.
  const NA = ".npmrc: an .npmrc is not allowed in this tree";
  const BYNAME = [NA];

  describe("controls", function () {
    row("the shipped tree passes", () => {}, "PASSES");
    row("E6 a workspace member with binding.gyp (npm ci builds none)", (t) => {
      SH(t, "pk/package.json", '{"name":"pk","version":"1.0.0"}');
      SH(t, "pk/binding.gyp", "{}");
      const f = path.join(t, "package.json");
      const p = JSON.parse(fs.readFileSync(f, "utf8"));
      p.workspaces = ["pk"];
      fs.writeFileSync(f, JSON.stringify(p, null, 2));
    }, "PASSES");
    row("a second workflow of tabled lines and no env passes", (t) => {
      TAB(t, { job: "x", run: "npm ci" });
      SH(t, ".github/workflows/w2.yml", "name: w2\non: push\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm ci\n");
    }, "PASSES");
  });

  describe("R15-C1, refused by name since R16-C1: any .npmrc, whatever its keys", function () {
    row("A10 `Script-Shell=` (npm ignores another case; flipped, R16-C1)", (t) => NPMRC(t, "Script-Shell=./hide.sh\n"), BYNAME);
    row("A11 `script_shell=` (flipped)", (t) => NPMRC(t, "script_shell=./hide.sh\n"), BYNAME);
    row("an escaped `script\\-shell=` (flipped)", (t) => NPMRC(t, "script\\-shell=./hide.sh\n"), BYNAME);
    row("a comment line naming the key (flipped)", (t) => NPMRC(t, "; script-shell=./hide.sh\n# userconfig=./x\n"), BYNAME);
    row('A1 `"script-shell"=` (a double-quoted key)', (t) => NPMRC(t, '"script-shell"=./hide.sh\n'), BYNAME);
    row("A2 `'script-shell'=` (a single-quoted key)", (t) => NPMRC(t, "'script-shell'=./hide.sh\n"), BYNAME);
    row('A3 `"node-options"=` (quoted)', (t) => NPMRC(t, '"node-options"=--require ./hide.js\n'), BYNAME);
    row("A4 `userconfig=` naming a file that sets script-shell", (t) => {
      NPMRC(t, "userconfig=./evilrc\n");
      SH(t, "evilrc", "script-shell=./hide.sh\n");
    }, BYNAME);
    row("A5 `globalconfig=` naming a file that sets script-shell", (t) => {
      NPMRC(t, "globalconfig=./evilrc\n");
      SH(t, "evilrc", "script-shell=./hide.sh\n");
    }, BYNAME);
    row('`"script\\u002dshell"=` (a JSON escape in the quoted key)', (t) => NPMRC(t, '"script\\u002dshell"=./hide.sh\n'), BYNAME);
    row("`script-shell;x=` (ini cuts the key at an unescaped ;)", (t) => NPMRC(t, "script-shell;x=./hide.sh\n"), BYNAME);
    row("`script-shell#x=` (and at an unescaped #)", (t) => NPMRC(t, "script-shell#x=./hide.sh\n"), BYNAME);
    row("a key under an ini section `[x]` stays refused", (t) => NPMRC(t, "[x]\nscript-shell=./hide.sh\n"), BYNAME);
    row(`\`'"script-shell"'=\` (single quotes around a JSON string)`, (t) => NPMRC(t, `'"script-shell"'=./hide.sh\n`), BYNAME);
    row("a quoted key in a package directory's .npmrc, CRLF and a BOM", (t) => SH(t, "pk/.npmrc", '\ufeffregistry=https://registry.npmjs.org/\r\n "shell" = ./x.sh\r\n'), [`pk/${NA}`]);
  });

  describe("R15-C2: every env is a table literal (lane G G14-2)", function () {
    row("B1 BASH_FUNC_node%% on the gate's own step", (t) => gstep(t, GATE, (s) => (s.env = { "BASH_FUNC_node%%": "() { true; }" })), [
      envNot("gates step", '{"BASH_FUNC_node%%":"() { true; }"}'),
    ]);
    for (const k of ["LD_LIBRARY_PATH", "NODE_PATH", "HOME"])
      row(`${k} in a listed step's env`, (t) => gstep(t, INSTALL, (s) => (s.env = { [k]: "./hide" })), [envNot("gates step", `{"${k}":"./hide"}`)]);
    row("D2 a second workflow's job env with an exported bash function", (t) => {
      TAB(t, { job: "x", run: "npm ci" });
      SH(t, ".github/workflows/w2.yml", "name: w2\non: push\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    env:\n      'BASH_FUNC_npm%%': '() { true; }'\n    steps:\n      - run: npm ci\n");
    }, ["w2.yml: " + envNot("x job", '{"BASH_FUNC_npm%%":"() { true; }"}')]);
    const EXPR = "${{ fromJSON('{\"NODE_OPTIONS\":\"--require ./hide.js\"}') }}";
    row("B6 a job env that is an expression, no mapping", (t) => edit(t, (d) => (d.jobs.gates.env = EXPR)), [envNot("gates job", JSON.stringify(EXPR))]);
    row("B7 a step env that is an expression, no mapping", (t) => gstep(t, INSTALL, (s) => (s.env = EXPR)), [envNot("gates step", JSON.stringify(EXPR))]);
    row("a step env that is a list", (t) => gstep(t, INSTALL, (s) => (s.env = ["HOME=./x"])), [envNot("gates step", '["HOME=./x"]')]);
    row("the drive job's DEMO_RPC_URL on another port", (t) => edit(t, (d) => (d.jobs.demo.env.DEMO_RPC_URL = "http://127.0.0.1:8546")), [
      envNot("demo job", '{"DEMO_RPC_URL":"http://127.0.0.1:8546","DEMO_SMOKE_OUT":"/tmp/demo-smoke-out.json"}'),
    ]);
    row("the workflow's CIRCOM_VERSION changed", (t) => edit(t, (d) => (d.env.CIRCOM_VERSION = "v9.9.9")), [envNot("the workflow", '{"CIRCOM_VERSION":"v9.9.9"}')]);
    row("the required step's env given a second key", (t) => edit(t, (d) => (d.jobs.required.steps.find((s: any) => s.env).env.X = "1")), [
      envNot("required step", '{"RESULTS":"${{ toJSON(needs) }}","X":"1"}'),
    ]);
  });

  describe("R15-C4: a job key `constructor` is refused by name, not a crash (lane G INFO)", function () {
    row("E2 a table entry for a job `constructor` passes, no crash", (t) => TAB(t, { job: "constructor", run: "x" }), "PASSES");
    row("a ci.yml job `constructor` running an unlisted line", (t) => edit(t, (d) => (d.jobs.constructor = { "runs-on": "ubuntu-24.04", steps: [{ run: "npm ci" }] })), [
      `run line not in ${TABLE}: constructor: npm ci`,
    ]);
    row("a drive job env key `constructor`", (t) => edit(t, (d) => (d.jobs.demo.env.constructor = "x")), ["demo job sets env constructor"]);
  });
});
