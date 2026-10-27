import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 12 (item B, lane G's GCI11-1 and GCI11-2,
 * swarm-11/G/out/ci-attacks-new-11.txt; R12-C3, R12-C5): the hides round
 * 11's gate passed, each refused by name. Through package.json: pre/post
 * hooks, flags before `run`, the run-script/rum/urn aliases, `npx` or
 * `npm exec` of a bin, yarn, pnpm, bun, workspace packages. In a run line
 * outside the drive jobs: a command built at run time (node -e, bash -c,
 * xargs) and a `${{ }}` expansion other than an integer matrix value. The
 * actions: a symlink under .github/actions, a local `uses:` other than
 * the prepare action (any job, any workflow), the prepare action's
 * inputs, shell and run lines; a drive job's checkout and setup-node
 * inputs; BASH_ENV in any env.
 */
describe("every drive exactly once: package scripts, run-time commands, actions (round 12)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const gate = require("../../scripts/ci/drives-once");
  const { check, drives, others, actions } = gate;
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const names = drives(path.join(ROOT, "scripts/ci"));
  const load = () => yaml.load(CI);
  const DRIVE = "scripts/ci/deploy-drive.sh";
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drives-12-"));
  // Round 11's gate read the root package.json's scripts only.
  const scriptsOf = (root: string) =>
    gate.scriptsOf
      ? gate.scriptsOf(root)
      : JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  /** A repo root whose package.json is the shipped one changed by `f`. */
  const repo = (f: (p: any) => void, more?: (root: string) => void) => {
    const root = tmp();
    const p = JSON.parse(JSON.stringify(PKG));
    f(p);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(p));
    more?.(root);
    return scriptsOf(root);
  };
  /** The shipped workflow with `run` added as a gates step (and `env`). */
  const gates = (run: string, env?: any) => {
    const doc = load();
    doc.jobs.gates.steps.push(env ? { run, env } : { run });
    return doc;
  };
  const refused = (got: string[], ...why: string[]) => {
    for (const w of why) expect(got.join("\n")).to.contain(w);
  };
  const twice = "scripts/ci/deploy-drive.sh runs 2 times, not once";
  const outside = (run: string) =>
    `gates step "${run}" runs a drive outside demo and deploy-drives`;

  it("the shipped workflow, package.json, actions and directory pass", function () {
    expect(check(load(), names, scriptsOf(ROOT))).to.deep.equal([]);
    const wf = path.join(ROOT, ".github/workflows");
    expect(others(wf, path.join(wf, "ci.yml"), names)).to.deep.equal([]);
    expect(actions(path.join(ROOT, ".github/actions"), names)).to.deep.equal([]);
  });

  it("P3, P3b, P3c: a pre or post hook of the script a run line reaches is read", function () {
    for (const [hook, run, main] of [
      ["predrives", "npm run drives", "drives"],
      ["postdrives", "npm run drives", "drives"],
      ["pretest", "npm test", "test"],
    ]) {
      const s = repo((p) => {
        p.scripts[main] = "echo ok";
        p.scripts[hook] = DRIVE;
      });
      // npm test runs in the tests job too: 3 times there
      refused(check(gates(run), names, s), outside(run), main === "test" ? "runs 3 times, not once" : twice);
    }
  });

  it("P5, P5b, P5c, P5e: flags before run and the run-script, rum, urn aliases", function () {
    const s = repo((p) => (p.scripts.drives = DRIVE));
    for (const run of [
      "npm --silent run drives",
      "npm -s run drives",
      "npm --prefix . run drives",
      "npm rum drives",
      "npm urn drives",
    ])
      refused(check(gates(run), names, s), outside(run), twice);
  });

  it("P6b, P6c: npx or npm exec of a package.json bin that is a drive", function () {
    const s = repo((p) => (p.bin = { drivebin: DRIVE }));
    for (const run of ["npx drivebin", "npm exec drivebin"])
      refused(check(gates(run), names, s), outside(run), twice);
  });

  it("P7-P7e: yarn, pnpm and bun running a script that runs a drive", function () {
    const s = repo((p) => (p.scripts.drives = DRIVE));
    for (const run of ["yarn drives", "yarn run drives", "pnpm run drives", "pnpm drives", "bun run drives"])
      refused(check(gates(run), names, s), outside(run), twice);
  });

  it("P8, P8b: a workspace package's script is read", function () {
    const s = repo(
      (p) => (p.workspaces = ["packages/*"]),
      (root) => {
        fs.mkdirSync(path.join(root, "packages/x"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "packages/x/package.json"),
          JSON.stringify({ name: "x", scripts: { drives: `../../${DRIVE}` } }),
        );
      },
    );
    for (const run of ["npm run -w x drives", "npm run drives --workspaces"])
      refused(check(gates(run), names, s), outside(run), twice);
  });

  it("P9, P9b, P10, P11b, P10d: a command built at run time outside the drive jobs is refused by name", function () {
    for (const [run, what, env] of [
      [`node -e "require('child_process').execSync('scripts/ci/deploy'+'-drive.sh')"`, "node -e"],
      [`node -e "require('child_process').execSync(process.env.X)"`, "node -e", { X: DRIVE }],
      ['bash -c "$X"', "bash -c", { X: DRIVE }],
      ['a=scripts/ci/dep; b=loy-drive.sh\nbash -c "$a$b"', "bash -c"],
      ["xargs -a scripts/ci/list.txt -n1 bash", "xargs"],
      ['eval "$X"', "eval", { X: DRIVE }],
    ] as const) {
      const doc = gates(run, env);
      refused(check(doc, names), `gates step "${run}" builds a command at run time (${what})`);
    }
  });

  it("P10b, P10c: a ${{ env }} or a string ${{ matrix }} expansion in a run line outside the drive jobs is refused by name (R12-C5)", function () {
    const env = load();
    env.jobs.gates.env = { X: DRIVE };
    env.jobs.gates.steps.push({ run: "${{ env.X }}" });
    refused(check(env, names), 'gates step "${{ env.X }}" expands ${{ env.X }} in its run line');
    const mx = load();
    mx.jobs.gates.strategy = { matrix: { x: [DRIVE] } };
    mx.jobs.gates.steps.push({ run: "${{ matrix.x }}" });
    refused(check(mx, names), 'gates step "${{ matrix.x }}" expands ${{ matrix.x }} in its run line');
  });

  it("R12-C5 (1): an integer matrix value joined to a path is a name built at run time", function () {
    const doc = load();
    doc.jobs.tests.steps.push({ run: "bash scripts/ci/${{ matrix.shard }}-drive.sh" });
    refused(
      check(doc, names),
      'tests step "bash scripts/ci/${{ matrix.shard }}-drive.sh" builds a name at run time (scripts/ci/${{ matrix }}-drive.sh)',
    );
  });

  it("P14: a symlink under .github/actions is refused, not followed; a non-drive job using it too", function () {
    const root = tmp();
    fs.mkdirSync(path.join(root, "evil"));
    fs.writeFileSync(
      path.join(root, "evil/action.yml"),
      "runs:\n  using: composite\n  steps:\n    - run: for f in scripts/ci/*-drive*.sh; do $f; done\n      shell: bash\n",
    );
    fs.mkdirSync(path.join(root, "actions"));
    fs.symlinkSync("../evil", path.join(root, "actions/ln"));
    refused(actions(path.join(root, "actions"), names), `${path.join(root, "actions/ln")} is a symlink: refused, not followed`);
    const doc = load();
    doc.jobs.gates.steps.push({ uses: "./.github/actions/ln" });
    refused(
      check(doc, names),
      'gates step "./.github/actions/ln" uses ./.github/actions/ln, a local action other than ./.github/actions/prepare',
    );
  });

  it("P14b, P17d: a local uses outside the prepare action, in ci.yml or a second workflow, is refused by name", function () {
    const doc = load();
    doc.jobs.gates.steps.push({ uses: "./tools/act" });
    refused(check(doc, names), 'gates step "./tools/act" uses ./tools/act, a local action other than ./.github/actions/prepare');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "ci.yml"), CI);
    fs.writeFileSync(path.join(dir, "w.yaml"), "on: push\njobs:\n  a:\n    uses: ./.github/workflows/./ci.yml\n");
    refused(
      others(dir, path.join(dir, "ci.yml"), names),
      `${path.join(dir, "w.yaml")} uses a local path other than ./.github/actions/prepare`,
    );
  });

  /** The shipped prepare action with `f` applied, its faults. */
  const prepare = (f: (t: string) => string) => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "prepare"));
    const at = path.join(dir, "prepare/action.yml");
    fs.writeFileSync(at, f(fs.readFileSync(path.join(ROOT, ".github/actions/prepare/action.yml"), "utf8")));
    return { at, got: actions(dir, names) };
  };

  it("P19, P19b, P19c: the prepare action's inputs are the shipped ones", function () {
    for (const [from, to, k] of [
      ["cache: npm }", "cache: npm, node-version-file: x }", "setup-node"],
      ["path: build/circuits/powersOfTau28_hez_final_15.ptau", "path: scripts/ci", "cache/restore"],
      ["with: { name: contracts }", "with: { name: contracts, path: scripts/ci }", "download-artifact"],
    ]) {
      const { got } = prepare((t) => t.replace(from, to));
      refused(got, `is not ${k}'s shipped input`);
    }
  });

  it("P19d, P19e, P19g: a prepare run line that redirects or expands a name indirectly, or a shell other than bash", function () {
    for (const [line, why] of [
      ['    - run: v=GITHUB_; v="${v}ENV"; echo "x" >> "${!v}"\n      shell: bash\n', "redirects or expands a name indirectly"],
      ["    - run: echo 'trap \"exit 0\" ERR' >> ~/.bashrc\n      shell: bash\n", "redirects or expands a name indirectly"],
      ['    - run: "true"\n      shell: "bash -c \'trap exit 0 EXIT; . {0}\'"\n', "shell is bash -c 'trap exit 0 EXIT; . {0}', not bash"],
    ]) {
      const { got } = prepare((t) => t + line);
      refused(got, why);
    }
  });

  it("P21b, P22: a drive job's checkout and setup-node take the shipped inputs only", function () {
    const doc = load();
    doc.jobs["deploy-drives"].steps[0].with = { "persist-credentials": "${{ secrets.X }}" };
    refused(check(doc, names), 'with {"persist-credentials":"${{ secrets.X }}"} is not checkout\'s shipped input');
    const node = load();
    node.jobs["deploy-drives"].steps.splice(1, 0, {
      uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      with: { "node-version": "10", cache: "npm" },
    });
    refused(check(node, names), 'with {"node-version":"10","cache":"npm"} is not setup-node\'s shipped input');
  });

  it("P23: BASH_ENV in a non-drive step's or job's env is refused by name", function () {
    refused(check(gates("true", { BASH_ENV: "/tmp/x" }), names), 'gates step "true" sets env BASH_ENV');
    const doc = load();
    doc.jobs.gates.env = { SHELLOPTS: "x" };
    refused(check(doc, names), "gates job sets env SHELLOPTS");
  });
});
