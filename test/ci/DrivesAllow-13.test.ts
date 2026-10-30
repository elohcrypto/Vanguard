import { expect } from "chai";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 13 (item C, lane G L3: swarm-12/G attack-u2r12-ci 99 rows and
 * attack-u2r12-ci2 51 rows; R13-C1, R13-C5, R13-C6): the deny-list grammar
 * failed twice (GCI11, lane G round 12), so the gate refuses what it does
 * not know. Outside the drive jobs every run line and every `uses:` of
 * ci.yml or a second workflow, and every run line of the prepare action,
 * equals an entry of the shipped scripts/ci/run-lines.json under its job
 * key; refused anywhere: a `shell:` other than bash, `container:`,
 * `services:`, job `defaults:`, an env or `with:` value naming a drive, an
 * .npmrc setting script-shell, and a listed `npm ci|install|pack|version`
 * whose package.json lifecycle scripts run a drive or build a command.
 * Each row runs the real CLI on a copy of the shipped tree (lane G's
 * shape); PASSES rows are the controls and lane G's non-hides.
 */
describe("every drive exactly once: run lines and uses come from a shipped table (round 13)", function () {
  this.timeout(120000);
  const yaml = require("js-yaml");
  const ROOT = path.join(__dirname, "../..");
  const DRIVE = "scripts/ci/deploy-drive.sh";
  const SHA = "a".repeat(40);
  const TABLE = "scripts/ci/run-lines.json";
  const tree = () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "drives-13-"));
    fs.cpSync(path.join(ROOT, ".github"), path.join(t, ".github"), { recursive: true });
    fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(t, "scripts/ci"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(t, "package.json"));
    return t;
  };
  const ci = (t: string) => path.join(t, ".github/workflows/ci.yml");
  const load = (t: string) => yaml.load(fs.readFileSync(ci(t), "utf8"));
  const save = (t: string, d: any) => fs.writeFileSync(ci(t), yaml.dump(d, { lineWidth: -1 }));
  const edit = (t: string, f: (d: any) => void) => {
    const d = load(t);
    f(d);
    save(t, d);
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
  const step = (t: string, s: any, job = "gates") => edit(t, (d) => d.jobs[job].steps.push(s));
  const matrix = (t: string, m: any, run: string) =>
    edit(t, (d) => {
      d.jobs.gates.strategy = m;
      d.jobs.gates.steps.push({ run });
    });
  const action = (t: string, more: string) =>
    fs.appendFileSync(path.join(t, ".github/actions/prepare/action.yml"), more);
  const wf = (t: string, rel: string, run: string) =>
    SH(t, rel, `name: w\non: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${run}\n`);
  const gate = (t: string) => {
    const r = cp.spawnSync("node", [path.join(ROOT, "scripts/ci/drives-once.js"), ci(t)], { encoding: "utf8", cwd: t });
    return { code: r.status, out: `${r.stderr}${r.stdout}` };
  };
  /** The table's refusal of `run` (of `job`) and of a `uses`. */
  const T = (run: string, job = "gates") => `run line not in ${TABLE}: ${job}: ${run}`;
  const U = (uses: string, job = "gates") => `uses not in ${TABLE}: ${job}: ${uses}`;

  /** `f` on a fresh copy of the shipped tree: exit 0, or refused naming `want`. */
  const row = (title: string, f: (t: string) => void, want: string | null) =>
    it(title, function () {
      const t = tree();
      try {
        f(t);
        const r = gate(t);
        if (want === "PASSES") expect(r.code, r.out).to.equal(0);
        else {
          expect(r.code, "refused").to.equal(1);
          if (want !== null) expect(r.out).to.contain(want);
        }
      } finally {
        fs.rmSync(t, { recursive: true, force: true });
      }
    });
  /** A gates step running `run` (after `pre`), refused by the table. */
  const line = (title: string, run: string, pre?: (t: string) => void) =>
    row(title, (t) => {
      pre?.(t);
      step(t, { run });
    }, T(run));
  const drive = (k: string) => (t: string) => P(t, (p) => (p.scripts[k] = DRIVE));
  const bin = (t: string) => P(t, (p) => (p.bin = { x: DRIVE }));
  const ws = (glob: any, dir: string, up: string) => (t: string) => {
    SH(t, `${dir}/package.json`, JSON.stringify({ name: "x", scripts: { a: `${up}${DRIVE}` } }));
    P(t, (p) => (p.workspaces = glob));
  };

  describe("controls and lane G's non-hides", function () {
    row("the shipped tree passes", () => {}, "PASSES");
    row("H41: a workflow in .github/workflows/sub (GitHub reads none there)", (t) => SH(t, ".github/workflows/sub/w.yml", "x: 1\n"), "PASSES");
    row("H43: the prepare action with a trailing newline", (t) => action(t, "\n"), "PASSES");
    row("K41: a second action never referenced", (t) => SH(t, ".github/actions/y/action.yml", "name: y\nruns:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n"), "PASSES");
    row("K44: a .js file under .github/actions", (t) => SH(t, ".github/actions/z/run.js", "x"), "PASSES");
    row("K45: a drive-like file under .github/scripts, never run", (t) => SH(t, ".github/scripts/s.sh", DRIVE), "PASSES");
    row("K47: scripts/ci/x-drive.bash (no drive by name)", (t) => SH(t, "scripts/ci/x-drive.bash", "echo"), "PASSES");
    row("K48: scripts/ci/x-drive.SH (no drive by name)", (t) => SH(t, "scripts/ci/x-drive.SH", "echo"), "PASSES");
    row("K50: a drive in .github/workflows/sub (GitHub reads none there)", (t) => wf(t, ".github/workflows/sub/w.yml", DRIVE), "PASSES");
    row("H83: an invalid workspace package.json fails the gate", (t) => {
      SH(t, "packages/x/package.json", "{bad");
      P(t, (p) => (p.workspaces = ["packages/*"]));
    }, null);
    row("the table missing is refused", (t) => fs.rmSync(path.join(t, TABLE)), `${TABLE} is missing`);
  });

  describe("R13-C1: a run line outside the drive jobs is a table entry (lane G round 12)", function () {
    line("C1 a pre hook", "npm run drives", (t) => P(t, (p) => Object.assign(p.scripts, { drives: "echo", predrives: DRIVE })));
    line("C2 npm start", "npm start", drive("start"));
    line("C3 npm -w . run", "npm -w . run drives", drive("drives"));
    line("C4 npx of a bin", "npx x", bin);
    line("C5 yarn --cwd", "yarn --cwd . run drives", drive("drives"));
    line("C6 bun run --silent", "bun run --silent drives", drive("drives"));
    for (const [id, run] of [["C7", "node -p 1"], ["C8", "bash -c ls"], ["C9", "sh -ec ls"], ["C10", "eval ls"], ["C11", "ls | xargs echo"], ["C12", "echo ${{ env.CIRCOM_VERSION }}"], ["C13", "echo ${{ github.sha }}"], ["C17", "echo"]])
      line(`${id} ${run}`, run);
    line("H1 make", "make d", (t) => SH(t, "Makefile", `d:\n\t${DRIVE}\n`));
    line("H2 ./node_modules/.bin/x", "./node_modules/.bin/x", bin);
    line("H3 $X indirection", "X=scripts/ci/deploy-drive.sh; $X");
    line("H4 $X indirection in a script", "npm run a", (t) => P(t, (p) => (p.scripts.a = "X=scripts/ci/deploy-drive; ${X}.sh")));
    line("H5 source a file", "source s.sh", (t) => SH(t, "s.sh", DRIVE));
    line("H6 bash s.sh", "bash s.sh", (t) => SH(t, "s.sh", DRIVE));
    line("H7 a heredoc into bash", `bash <<EOF\n${DRIVE}\nEOF`);
    line("H8 python -c", `python3 -c 'import os;os.system("scripts/ci/deploy-"+"drive.sh")'`);
    line("H9 perl -e", `perl -e 'system("scripts/ci/deploy-"."drive.sh")'`);
    line("H10 ruby -e", `ruby -e 'system("scripts/ci/deploy-"+"drive.sh")'`);
    line("H11 node file.js", "node r.js", (t) => SH(t, "r.js", `require('child_process').execSync('${DRIVE}')`));
    line("H12 npx tsx of a repo file", "npx tsx r.ts", (t) => SH(t, "r.ts", "x"));
    line("H13 cd then a relative drive", "npm run a", (t) => P(t, (p) => (p.scripts.a = "cd scripts/ci && ./deploy-drive.sh")));
    line("H14 npm run s -- arg", "npm run a -- --x", drive("a"));
    line("H15 npm-run-all run-s", "npx run-s a", drive("a"));
    line("H16 npx concurrently", "npx concurrently 'npm:a'", drive("a"));
    line("H17 npm --prefix of a package not in workspaces", "npm --prefix pk run a", (t) => SH(t, "pk/package.json", JSON.stringify({ name: "pk", scripts: { a: `../${DRIVE}` } })));
    line("H18 cd into a package then npm run", "cd pk && npm run a", (t) => SH(t, "pk/package.json", JSON.stringify({ name: "pk", scripts: { a: `../${DRIVE}` } })));
    line("H20b npm install", "npm install", drive("prepare"));
    line("H21 npm test with an .npmrc script-shell", "npm test", (t) => {
      SH(t, ".npmrc", "script-shell=./x.sh\n");
      SH(t, "x.sh", DRIVE);
    });
    line("H22 a package.json config value", "npm run a", (t) => P(t, (p) => Object.assign(p, { config: { d: DRIVE } }, { scripts: { ...p.scripts, a: "$npm_package_config_d" } })));
    row("H23 matrix with max-parallel", (t) => matrix(t, { "max-parallel": 1, matrix: { shard: [1, 2] } }, "echo ${{ matrix.shard }}"), T("echo ${{ matrix.shard }}"));
    row("H24 matrix include", (t) => matrix(t, { matrix: { shard: [1, 2], include: [{ shard: 3 }] } }, "echo ${{ matrix.shard }}"), T("echo ${{ matrix.shard }}"));
    row("H25 a matrix integer as a script's argv index", (t) => {
      P(t, (p) => (p.scripts.a = "ls=(scripts/ci/deploy-drive scripts/ci/x); ${ls[$1]}.sh"));
      matrix(t, { matrix: { shard: [0, 1] } }, "npm run a ${{ matrix.shard }}");
    }, T("npm run a ${{ matrix.shard }}"));
    for (const [id, m, run] of [
      ["H26", { shard: [0, 1] }, "bash scripts/ci/x${{ matrix.shard }}.sh"],
      ["H27", { shard: ["a"] }, "echo ${{ matrix.shard }}"],
      ["H28", { shard: "${{ fromJSON('[1]') }}" }, "echo ${{ matrix.shard }}"],
      ["H29", { shard: [1.5] }, "echo ${{ matrix.shard }}"],
      ["H30", { shard: [1, 2] }, "node scripts/ci/x.js --f=${{ matrix.shard }}"],
      ["K27", { shard: [1, 2] }, "npm test -- ${{ matrix.shard }}"],
      ["K28", { "a-b": [1] }, "echo ${{ matrix.a-b }}"],
      ["K29", { s: [1] }, "./${{ matrix.s }}"],
      ["K30", { s: [1] }, "bash d${{ matrix.s }}.sh"],
      ["K31", { s: [1] }, "bash run.sh ${{ matrix.s }}"],
      ["K32", { s: [1] }, "echo ${{matrix.s}}"],
      ["K33", { s: [1] }, "echo ${{ matrix.s || env.X }}"],
      ["K34", { s: [1] }, "echo ${{ matrix['s'] }}"],
    ] as [string, any, string][])
      row(`${id} ${run}`, (t) => matrix(t, { matrix: m }, run), T(run));
    line("H46 working-directory and a relative drive", "./deploy-drive.sh");
    line("H47 a write to GITHUB_ENV", "echo X=1 >> $GITHUB_ENV");
    line("H48 a second line", "echo hi\nnpm run a", drive("a"));
    line("H49 / K2 a backslash continuation", "npm \\\n  run a", drive("a"));
    line("H50 a script name with a colon", "npm run a:b", (t) => P(t, (p) => (p.scripts["a:b"] = DRIVE)));
    for (const [id, run] of [["H51", "npm run --if-present a"], ["H52", "npm run -- a"], ["H53", "npm --workspaces=false run a"], ["H54", "npm --loglevel silent run a"], ["H55", "FOO=1 npm run a"], ["K10", "npm --loglevel silent run a"], ["K11", "npm --userconfig /dev/null run a"], ["K12", "npm --loglevel=silent run a"], ["K23", "if true; then npm run a; fi"], ["K24", "time npm run a"]])
      line(`${id} ${run}`, run, drive("a"));
    for (const [id, run] of [["H56", "npm exec --package=. -- x"], ["H57", "npx --no-install x"], ["H58", "npx -y x"], ["H59", "npm x x"], ["H76", "pnpm exec x"], ["H77", "npx -p lodash x"], ["K13", "npm x x"]])
      line(`${id} ${run}`, run, bin);
    line("H60 $npm_execpath", "$npm_execpath");
    line("H61 a script chained through ;", "npm run a", (t) => P(t, (p) => Object.assign(p.scripts, { a: "echo; npm run b", b: DRIVE })));
    line("H62 a script cycle (the gate terminates)", "npm run a", (t) => P(t, (p) => Object.assign(p.scripts, { a: "npm run b", b: "npm run a" })));
    line("H63 run-script inside a post hook", "npm run a", (t) => P(t, (p) => Object.assign(p.scripts, { a: "echo", posta: "npm --silent run-script b", b: DRIVE })));
    for (const [id, run] of [["H64", "PATH=$PATH:scripts/ci deploy-drive.sh"], ["H65", "cd scripts/ci; deploy-drive.sh"], ["H66", "scripts/ci/deploy-\\\ndrive.sh"], ["H67", "scripts/ci/{deploy-drive,x}.sh"], ["H68", "scripts/ci/d?ploy-drive.sh"], ["H69", "$(echo scripts/ci/deploy-drive.sh)"], ["H70", "'scripts/ci/deploy-'drive.sh"], ["H71", "scripts/c?/deploy-drive.sh"], ["K9", "npm exec --call 'scripts/ci/deploy-drive.sh'"]])
      line(`${id} ${run}`, run);
    line("H72 a glob in a script", "npm run a", (t) => P(t, (p) => (p.scripts.a = "for f in scripts/ci/*-drive*.sh; do $f; done")));
    line("H74 yarn workspace", "yarn workspace x run drives", drive("drives"));
    line("H75 pnpm -r run", "pnpm -r run drives", drive("drives"));
    line("H79 workspaces.packages", "npm run a -w x", ws({ packages: ["packages/*"] }, "packages/x", "../../"));
    line("H80 workspaces packages/**", "npm run a -w x", ws(["packages/**"], "packages/g/x", "../../../"));
    line("H81 workspaces packages/x-*", "npm run a -w x", ws(["packages/x-*"], "packages/x-1", "../../"));
    line("H82 workspaces ./packages/*", "npm run a -w x", ws(["./packages/*"], "packages/x", "../../"));
    line("H84 a non-string script", "npm run a", (t) => P(t, (p) => (p.scripts.a = ["x"])));
    line("K14 npm it", "npm it", drive("test"));
    line("K18 npm pack", "npm pack", drive("prepack"));
    line("K19 npm version", "npm version patch", drive("version"));
    line("K20 npm start (server.js)", "npm start");
    line("K21 npm restart", "npm restart", drive("restart"));
    line("K22 npm stop", "npm stop", drive("stop"));
    row("K35 a name with an expression", (t) => step(t, { name: "x ${{ env.A }}", run: "echo" }), T("echo"));
    row("K36 an if: expression", (t) => step(t, { if: "${{ env.A }}", run: "echo" }), T("echo"));
    line("a listed line in another job (npm run gas:claims is the tests job's)", "npm run gas:claims");
    row("a second workflow's run line", (t) => wf(t, ".github/workflows/w.yml", "echo hi"), T("echo hi", "a"));
  });

  describe("R13-C5: a uses outside the drive jobs is a table entry", function () {
    row("H32 a remote action at a SHA", (t) => step(t, { uses: `evil/act@${SHA}` }), U(`evil/act@${SHA}`));
    row("K39 the prepare action in a job that does not use it", (t) => step(t, { uses: "./.github/actions/prepare", with: { x: 1 } }), U("./.github/actions/prepare"));
    row("C15 a local action other than prepare", (t) => {
      SH(t, ".github/actions/x/action.yml", "name: x\nruns:\n  using: composite\n  steps: []\n");
      step(t, { uses: "./.github/actions/x" });
    }, U("./.github/actions/x"));
  });

  describe("R13-C6: the prepare action's run lines are table entries", function () {
    row("a run line added to the action", (t) => {
      SH(t, "s.sh", DRIVE);
      action(t, "    - run: bash s.sh\n      shell: bash\n");
    }, T("bash s.sh", "./.github/actions/prepare"));
    row("K17 npm ci in the action with a preinstall hook", (t) => P(t, (p) => (p.scripts.preinstall = DRIVE)), `.github/actions/prepare/action.yml step "Install dependencies" runs npm ci, whose preinstall script runs a drive`);
  });

  describe("R13-C1: refused anywhere", function () {
    row("H44 shell: python", (t) => step(t, { run: "npm ci", shell: "python" }), `gates step "npm ci" shell is python, not bash`);
    row("H45 shell: bash {0}", (t) => step(t, { run: "npm ci", shell: "bash {0}" }), `gates step "npm ci" shell is bash {0}, not bash`);
    row("K5 shell: naming the drive", (t) => step(t, { run: "npm ci", shell: `${DRIVE} {0}` }), `shell is ${DRIVE} {0}, not bash`);
    row("H33 container:", (t) => edit(t, (d) => (d.jobs.gates.container = "alpine")), "gates job sets container");
    row("H34 services:", (t) => edit(t, (d) => (d.jobs.gates.services = { x: { image: "alpine" } })), "gates job sets services");
    row("K25 job defaults:", (t) => edit(t, (d) => (d.jobs.gates.defaults = { run: { shell: "bash" } })), "gates job sets defaults");
    row("K3 a step env value naming the drive", (t) => step(t, { run: "$X", env: { X: DRIVE } }), `gates step "$X" env X names a drive`);
    row("K4 a step env value naming the drive (bash $X)", (t) => step(t, { run: "bash $X", env: { X: DRIVE } }), `gates step "bash $X" env X names a drive`);
    row("K7 a job env value naming the drive", (t) => edit(t, (d) => {
      d.jobs.gates.env = { X: DRIVE };
      d.jobs.gates.steps.push({ run: "$X" });
    }), "gates job env X names a drive");
    row("an env value naming the drive on a listed line", (t) => edit(t, (d) => (d.jobs.gates.steps.find((s: any) => s.run === "npm ci").env = { X: DRIVE })), "env X names a drive");
    row("an env value naming a drive's directory", (t) => edit(t, (d) => (d.jobs.gates.env = { P: "scripts/ci/" })), "gates job env P names a drive");
    row("K6 a with: value of a remote action naming the drive", (t) => step(t, { uses: `evil/act@${SHA}`, with: { run: DRIVE } }), "with run names a drive");
    row("H31 a docker action's args naming the drive", (t) => step(t, { uses: "docker://alpine:3", with: { args: DRIVE } }), "with args names a drive");
    row("a with: value naming the drive on a listed uses", (t) => edit(t, (d) => (d.jobs.tests.steps.find((s: any) => /upload-artifact/.test(s.uses ?? "")).with.path = DRIVE)), "with path names a drive");
    row("H21 an .npmrc setting script-shell", (t) => SH(t, ".npmrc", "script-shell=./x.sh\n"), ".npmrc: an .npmrc is not allowed in this tree");
    row("an .npmrc in a workspace package setting script-shell", (t) => SH(t, "pk/.npmrc", "script-shell = ./x.sh\n"), "pk/.npmrc: an .npmrc is not allowed in this tree");
    // Round 16 (R16-C1, countersigned R16-CS2): any .npmrc is refused by name.
    row("an .npmrc without script-shell", (t) => SH(t, ".npmrc", "fund=false\n"), ".npmrc: an .npmrc is not allowed in this tree");
    row("H19 npm ci and a preinstall running the drive", (t) => P(t, (p) => (p.scripts.preinstall = DRIVE)), `gates step "Install dependencies" runs npm ci, whose preinstall script runs a drive`);
    row("H20 / K15 npm ci and a postinstall", (t) => P(t, (p) => (p.scripts.postinstall = DRIVE)), "runs npm ci, whose postinstall script runs a drive");
    row("K16 npm ci and a prepare script", (t) => P(t, (p) => (p.scripts.prepare = DRIVE)), "runs npm ci, whose prepare script runs a drive");
    row("npm ci and an install script reaching the drive through npm run", (t) => P(t, (p) => Object.assign(p.scripts, { install: "npm run b", b: DRIVE })), "runs npm ci, whose install script runs a drive");
    row("npm ci and a postinstall building a command", (t) => P(t, (p) => (p.scripts.postinstall = "bash -c x")), "runs npm ci, whose postinstall script builds a command at run time");
  });
  describe("refused at 9e757a4 already, each keeps its reason (lane G round 12)", function () {
    row("C14 a symlink under .github/actions", (t) => fs.symlinkSync("/tmp", path.join(t, ".github/actions/lnk")), "lnk is a symlink: refused, not followed");
    row("C16 BASH_ENV in a non-drive job env", (t) => edit(t, (d) => (d.jobs.gates.env = { BASH_ENV: "/tmp/x" })), "gates job sets env BASH_ENV");
    for (const u of ["./.github/actions/prepare/", "./.github/actions//prepare", "./.github/actions/prepare/../x"])
      row(`H35-H37 uses ${u}`, (t) => step(t, { uses: u }), `uses ${u}, a local action other than ./.github/actions/prepare`);
    row("H38 a symlinked workflow file", (t) => fs.symlinkSync(ci(t), path.join(t, ".github/workflows/other.yml")), "other.yml runs a drive script or names a drive job");
    row("H39 a symlinked workflow file from outside", (t) => {
      wf(t, "elsewhere/w.yml", DRIVE);
      fs.symlinkSync(path.join(t, "elsewhere/w.yml"), path.join(t, ".github/workflows/w.yml"));
    }, "w.yml runs a drive script or names a drive job");
    row("H40 a .yaml workflow running a drive", (t) => wf(t, ".github/workflows/w.yaml", DRIVE), "w.yaml runs a drive script or names a drive job");
    row("K49 a hidden workflow running a drive", (t) => wf(t, ".github/workflows/.h.yml", DRIVE), ".h.yml runs a drive script or names a drive job");
    row("H42 a reusable workflow call", (t) => edit(t, (d) => (d.jobs.r = { uses: "./.github/workflows/w.yml" })), "r job calls the reusable workflow ./.github/workflows/w.yml");
    row("H73 an upper-case job key", (t) => edit(t, (d) => (d.jobs.Demo2 = { "runs-on": "ubuntu-24.04", steps: [{ run: DRIVE }] })), "job key Demo2 is not lower-case");
    row("H78 npm in a drive job", (t) => step(t, { run: "npm run compile" }, "deploy-drives"), `deploy-drives step "npm run compile" is not a drive line`);
    row("K8 a workflow env", (t) => edit(t, (d) => (d.env = { ...d.env, X: DRIVE })), "the workflow sets env X");
    row("K26 workflow defaults", (t) => edit(t, (d) => (d.defaults = { run: { "working-directory": "scripts/ci" } })), "the workflow sets defaults");
    row("K37 a drive in the prepare action", (t) => action(t, `    - run: ${DRIVE}\n      shell: bash\n`), "runs a drive script: drives run only in the drive jobs");
    row("K38 the prepare action's download name", (t) => {
      const f = path.join(t, ".github/actions/prepare/action.yml");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("name: contracts", "name: other"));
    }, `with {"name":"other"} is not download-artifact's shipped input`);
    row("K40 a node action", (t) => {
      SH(t, ".github/actions/prepare/index.js", "x");
      fs.writeFileSync(path.join(t, ".github/actions/prepare/action.yml"), "name: prepare\nruns:\n  using: node20\n  main: index.js\n");
    }, "runs using node20, not composite");
    row("K42 the prepare action nested in another", (t) => SH(t, ".github/actions/y/action.yml", "name: y\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/prepare\n"), "uses ./.github/actions/prepare, not setup-node, download-artifact or cache/restore");
    row("K43 a docker action", (t) => {
      SH(t, ".github/actions/y/action.yml", "name: y\nruns:\n  using: docker\n  image: Dockerfile\n");
      SH(t, ".github/actions/y/Dockerfile", `FROM alpine\nENTRYPOINT ["/work/${DRIVE}"]\n`);
    }, "runs using docker, not composite");
    row("K46 a new drive run nowhere", (t) => SH(t, "scripts/ci/new-drive.sh", "echo"), "scripts/ci/new-drive.sh runs 0 times, not once");
    row("K51 a symlinked action file", (t) => {
      SH(t, "e/a.yml", `name: y\nruns:\n  using: composite\n  steps:\n    - run: ${DRIVE}\n      shell: bash\n`);
      fs.mkdirSync(path.join(t, ".github/actions/y"));
      fs.symlinkSync(path.join(t, "e/a.yml"), path.join(t, ".github/actions/y/action.yml"));
    }, "action.yml is a symlink: refused, not followed");
  });
});
