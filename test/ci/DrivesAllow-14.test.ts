import { expect } from "chai";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 14 (item B, lane G's round-13 hides, swarm-13/G/out/
 * ci3-attacks-13.txt; R14-C2, R14-C3, R14-C4, R14-C9): what still changed
 * what a listed line runs. A second workflow got the table only (H7-H7e);
 * env keys NODE_OPTIONS, LD_PRELOAD, PATH, npm_config_* and a step's
 * working-directory passed (H2 H3 H3b H4 H6d), so did the .npmrc keys
 * node-options, shell, onload-script (H16 H1), npm's implicit node-gyp
 * install (H18), a symlinked table (H11), a listed uses with another
 * `with` or any 40-hex SHA in a drive job or the prepare action (H8 H8b
 * H8c), and the lifecycle scripts npm ci also runs (H20; npm 10.9.8:
 * dependencies, prepublish, preprepare, postprepare). Each row runs the
 * real CLI on a copy of the shipped tree (lane G's shape).
 */
describe("every drive exactly once: what changes a listed line is refused too (round 14)", function () {
  this.timeout(120000);
  const yaml = require("js-yaml");
  const ROOT = path.join(__dirname, "../..");
  const DRIVE = "scripts/ci/deploy-drive.sh";
  const TABLE = "scripts/ci/run-lines.json";
  const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
  const tree = () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "drives-14-"));
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
  const P = (t: string, f: (p: any) => void) => {
    const file = path.join(t, "package.json");
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    f(p);
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
  };
  const SH = (t: string, rel: string, txt: string) => {
    fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true });
    fs.writeFileSync(path.join(t, rel), txt);
  };
  /** `e` added to the copy's table (as a PR would list a line). */
  const TAB = (t: string, e: any) => {
    const f = path.join(t, TABLE);
    fs.writeFileSync(f, JSON.stringify([...JSON.parse(fs.readFileSync(f, "utf8")), e]));
  };
  /** The gates step `name` changed by `f`. */
  const gstep = (t: string, name: string, f: (s: any) => void) =>
    edit(t, (d) => f(d.jobs.gates.steps.find((s: any) => s.name === name)));
  const INSTALL = "Install dependencies";
  /** A second workflow w2.yml of job `x` (header lines `head`, job lines `job`) whose one step is `step`; npm ci tabled under x. */
  const w2 = (t: string, head: string, job: string, step = "- run: npm ci") => {
    TAB(t, { job: "x", run: "npm ci" });
    SH(t, ".github/workflows/w2.yml", `name: w2\non: push\n${head}jobs:\n  x:\n    runs-on: ubuntu-24.04\n${job}    steps:\n      ${step}\n`);
  };
  const gate = (t: string) => {
    const r = cp.spawnSync("node", [path.join(ROOT, "scripts/ci/drives-once.js"), ci(t)], { encoding: "utf8", cwd: t });
    return { code: r.status, out: `${r.stderr}${r.stdout}` };
  };
  /** `f` on a fresh copy of the shipped tree: exit 0, or refused naming each of `want`. */
  const row = (title: string, f: (t: string) => void, want: "PASSES" | string[]) =>
    it(title, function () {
      const t = tree();
      try {
        f(t);
        const r = gate(t);
        if (want === "PASSES") expect(r.code, r.out).to.equal(0);
        else {
          expect(r.code, "refused").to.equal(1);
          for (const w of want) expect(r.out).to.contain(w);
        }
      } finally {
        fs.rmSync(t, { recursive: true, force: true });
      }
    });

  describe("controls", function () {
    row("the shipped tree passes (ci.yml, the prepare action, package.json, the table)", () => {}, "PASSES");
    row("a second workflow of tabled lines under ci.yml's grammar passes", (t) => w2(t, "", ""), "PASSES");
  });

  describe("R14-C2: a second workflow under ci.yml's job and step rules (lane G F3)", function () {
    row("H7 a workflow-level BASH_ENV with tabled lines", (t) => {
      SH(t, "hide.sh", DRIVE);
      w2(t, "env:\n  BASH_ENV: ./hide.sh\n", "");
    }, ["w2.yml: the workflow sets env BASH_ENV"]);
    row("H7b a job container and job defaults with tabled lines", (t) => w2(t, "", "    container: evil/image\n    defaults:\n      run:\n        working-directory: sub\n"), [
      "w2.yml: x job sets container",
      "w2.yml: x job sets defaults",
    ]);
    row("H7c a remote reusable workflow", (t) => SH(t, ".github/workflows/w2.yml", `name: w2\non: push\njobs:\n  x:\n    uses: evil/repo/.github/workflows/w.yml@${"a".repeat(40)}\n`), [
      "w2.yml: x job calls the reusable workflow evil/repo/.github/workflows/w.yml@",
    ]);
    row("H7d a job with services and no steps", (t) => SH(t, ".github/workflows/w2.yml", "name: w2\non: push\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    services:\n      s:\n        image: evil\n    steps: []\n"), ["w2.yml: x job sets services"]);
    row("H7e a tabled line under shell: python", (t) => {
      TAB(t, { job: "x", run: "print(1)" });
      SH(t, ".github/workflows/w2.yml", "name: w2\non: push\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: print(1)\n        shell: python\n");
    }, ['w2.yml: x step "print(1)" shell is python, not bash']);
    row("a workflow-level defaults", (t) => w2(t, "defaults:\n  run:\n    shell: sh\n", ""), ["w2.yml: the workflow sets defaults"]);
    row("a step with continue-on-error", (t) => w2(t, "", "", "- run: npm ci\n        continue-on-error: true"), ['w2.yml: x step "npm ci" sets continue-on-error']);
    row("an upper-case job key", (t) => {
      TAB(t, { job: "X", run: "npm ci" });
      SH(t, ".github/workflows/w2.yml", "name: w2\non: push\njobs:\n  X:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm ci\n");
    }, ["w2.yml: job key X is not lower-case"]);
  });

  describe("R14-C3: env keys, working-directory, .npmrc keys, node-gyp and the table's own file (lane G F2)", function () {
    row("H2 NODE_OPTIONS in a listed step's env", (t) => gstep(t, INSTALL, (s) => (s.env = { NODE_OPTIONS: "--require ./hide.js" })), [`gates step "${INSTALL}" sets env NODE_OPTIONS`]);
    row("H6d NODE_OPTIONS on the gate's own step", (t) => gstep(t, "Every drive exactly once", (s) => (s.env = { NODE_OPTIONS: "--require ./x.js" })), ['gates step "Every drive exactly once" sets env NODE_OPTIONS']);
    row("H3 npm_config_script_shell in a job env", (t) => edit(t, (d) => (d.jobs.gates.env = { npm_config_script_shell: "./hide.sh" })), ["gates job sets env npm_config_script_shell"]);
    row("NPM_CONFIG_IGNORE_SCRIPTS in a listed step's env (any case)", (t) => gstep(t, INSTALL, (s) => (s.env = { NPM_CONFIG_IGNORE_SCRIPTS: "false" })), [`gates step "${INSTALL}" sets env NPM_CONFIG_IGNORE_SCRIPTS`]);
    row("H3b PATH in a listed step's env", (t) => gstep(t, INSTALL, (s) => (s.env = { PATH: "./hide:/usr/bin" })), [`gates step "${INSTALL}" sets env PATH`]);
    row("LD_PRELOAD in a job env", (t) => edit(t, (d) => (d.jobs.gates.env = { LD_PRELOAD: "./x.so" })), ["gates job sets env LD_PRELOAD"]);
    row("H4 working-directory on a listed npm ci", (t) => {
      SH(t, "sub/package.json", JSON.stringify({ name: "s", scripts: { preinstall: `../${DRIVE}` } }));
      gstep(t, INSTALL, (s) => (s["working-directory"] = "sub"));
    }, [`gates step "${INSTALL}" sets working-directory`]);
    row("H1 an .npmrc onload-script", (t) => SH(t, ".npmrc", "onload-script=./hide.js\n"), [".npmrc: an .npmrc is not allowed in this tree"]);
    row("H16 an .npmrc node-options", (t) => SH(t, ".npmrc", "node-options=--require ./hide.js\n"), [".npmrc: an .npmrc is not allowed in this tree"]);
    row("an .npmrc shell in a package directory", (t) => SH(t, "pk/.npmrc", "shell = ./x.sh\n"), ["pk/.npmrc: an .npmrc is not allowed in this tree"]);
    row("H18 a root binding.gyp (npm's implicit node-gyp install)", (t) => SH(t, "binding.gyp", "{}"), ["binding.gyp at the root"]);
    row("a package.json gypfile key", (t) => P(t, (p) => (p.gypfile = true)), ["package.json sets gypfile"]);
    row("H11 the table a symlink", (t) => {
      const f = path.join(t, TABLE);
      fs.renameSync(f, path.join(t, "elsewhere.json"));
      fs.symlinkSync(path.join(t, "elsewhere.json"), f);
    }, [`${TABLE} is missing or not a regular file`]);
  });

  describe("R14-C9: every lifecycle script npm ci runs (npm 10.9.8)", function () {
    for (const k of ["prepublish", "preprepare", "postprepare", "dependencies"])
      row(`${k === "prepublish" ? "H20 " : ""}a listed npm ci whose ${k} script runs a drive`, (t) => P(t, (p) => (p.scripts[k] = DRIVE)), [
        `gates step "${INSTALL}" runs npm ci, whose ${k} script runs a drive`,
      ]);
  });

  describe("R14-C4: every uses is a table entry with its with (lane G F5, lane D)", function () {
    row("H8 a drive job's checkout at another SHA", (t) => edit(t, (d) => (d.jobs.demo.steps[0].uses = `actions/checkout@${"b".repeat(40)}`)), [
      `uses not in ${TABLE}: demo: actions/checkout@${"b".repeat(40)}`,
    ]);
    row("H8b the prepare action's setup-node at another SHA", (t) => {
      const f = path.join(t, ".github/actions/prepare/action.yml");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("49933ea5288caeca8642d1e84afbd3f7d6820020", "c".repeat(40)));
    }, [`uses not in ${TABLE}: ./.github/actions/prepare: actions/setup-node@${"c".repeat(40)}`]);
    row("H8c a listed checkout with another with", (t) => edit(t, (d) => (d.jobs.gates.steps[0].with = { repository: "evil/x", ref: "main" })), [
      `uses not in ${TABLE}: gates: ${CHECKOUT} with {"ref":"main","repository":"evil/x"}`,
    ]);
  });
});
