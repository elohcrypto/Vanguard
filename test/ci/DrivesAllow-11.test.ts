import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 11 (item B, lane G's GCI10-1): round 10's allow-list covered
 * the drive jobs and their steps and missed the workflow around them and
 * the prepare action's body. Each hide lane G's 47 rows found passing is
 * refused by name: a workflow-level env (BASH_ENV, SHELLOPTS reach every
 * run step), a top-level key outside the allow-list, a drive run given as
 * an array, runs-on as an array, a non-drive job running a drive through
 * a glob, a name built from a variable or an npm script, env values off
 * their shipped shape, and in the local actions a step writing
 * GITHUB_ENV, a glob, a node action, an uppercase or nested action file;
 * a second workflow running the drives by glob, quoting a drive job's
 * key or calling ci.yml. Job keys are lower-case.
 */
describe("every drive exactly once: the workflow around the drive jobs (round 11)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const { check, drives, others, actions } = require("../../scripts/ci/drives-once");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const names = drives(path.join(ROOT, "scripts/ci"));
  const load = () => yaml.load(CI);
  const DRIVE = "Production deploy drives (external signer; multisig roles)";
  const drive = (doc: any) =>
    doc.jobs["deploy-drives"].steps.find((x: any) => x.name === DRIVE);
  const refused = (got: string[], ...why: string[]) => {
    for (const w of why) expect(got.join("\n")).to.contain(w);
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drives-11-"));

  it("the committed workflow, its actions and its directory pass", function () {
    const pkg = require(path.join(ROOT, "package.json")).scripts;
    expect(check(load(), names, pkg)).to.deep.equal([]);
    const wf = path.join(ROOT, ".github/workflows");
    expect(others(wf, path.join(wf, "ci.yml"), names)).to.deep.equal([]);
    expect(actions(path.join(ROOT, ".github/actions"), names)).to.deep.equal([]);
  });

  it("W1, W2: a workflow-level env other than CIRCOM_VERSION is refused by name", function () {
    for (const k of ["BASH_ENV", "SHELLOPTS"]) {
      const doc = load();
      doc.env[k] = "/tmp/x";
      refused(check(doc, names), `the workflow sets env ${k}`);
    }
  });

  it("W4: a top-level key outside name, on, permissions, concurrency, env, jobs is refused by name", function () {
    const doc = load();
    doc["run-name"] = "x";
    refused(check(doc, names), "the workflow sets run-name");
  });

  it("S1, R1: a drive run or a drive job's runs-on given as an array is refused by name", function () {
    const doc = load();
    drive(doc).run = [drive(doc).run];
    refused(check(doc, names), `deploy-drives step "${DRIVE}" run is not a string`);
    const box = load();
    box.jobs["deploy-drives"]["runs-on"] = ["ubuntu-latest"];
    refused(
      check(box, names),
      'deploy-drives job runs on ["ubuntu-latest"], not a GitHub-hosted ubuntu label',
    );
  });

  it("S3, S5: a non-drive job running drives by a glob or a built name breaks runs-once by name", function () {
    for (const run of [
      "for f in scripts/ci/*-drive*.sh; do $f; done",
      "x=deploy-drive; bash scripts/ci/$x.sh",
    ]) {
      const doc = load();
      doc.jobs.gates.steps.push({ run });
      refused(
        check(doc, names),
        `gates step "${run}" runs a drive outside demo and deploy-drives`,
        "scripts/ci/deploy-drive.sh runs 2 times, not once",
      );
    }
  });

  it("S4: a non-drive job's npm script that runs a drive breaks runs-once by name", function () {
    const doc = load();
    doc.jobs.gates.steps.push({ run: "npm run drives" });
    refused(
      check(doc, names, { drives: "scripts/ci/deploy-drive.sh" }),
      'gates step "npm run drives" runs a drive outside demo and deploy-drives',
      "scripts/ci/deploy-drive.sh runs 2 times, not once",
    );
  });

  it("E1, E2: the drive jobs' env values keep their shipped shape", function () {
    const doc = load();
    doc.jobs.demo.env.DEMO_RPC_URL = "http://attacker.example:8545";
    doc.jobs.demo.env.DEMO_SMOKE_OUT = "/dev/null";
    refused(
      check(doc, names),
      "demo job env DEMO_RPC_URL is http://attacker.example:8545, not a http://127.0.0.1:<port> URL",
      "demo job env DEMO_SMOKE_OUT is /dev/null, not a /tmp/<name>.json file",
    );
  });

  it("a job key with a capital, a space or a quote is refused by name", function () {
    for (const id of ["Extra", "'deploy-drives'", "a b"]) {
      const doc = load();
      doc.jobs[id] = { "runs-on": "ubuntu-latest", steps: [{ run: "true" }] };
      refused(check(doc, names), `job key ${id} is not lower-case`);
    }
  });

  /** `text` as a local action at `rel` under a fresh actions dir. */
  const action = (rel: string, text: string) => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    return actions(dir, names);
  };
  const steps = (s: string) => `runs:\n  using: composite\n  steps:\n${s}`;

  it("A1, A2: a local action step naming GITHUB_ENV, or a drive by glob, is refused by name", function () {
    refused(
      action("p/action.yml", steps('    - run: echo "BASH_ENV=$PWD/x.sh" >> $GITHUB_ENV\n      shell: bash\n')),
      "p/action.yml step \"echo \"BASH_ENV=$PWD/x.sh\" >> $GITHUB_ENV\" names GITHUB_ENV, BASH_ENV or GITHUB_PATH",
    );
    refused(
      action("p/action.yml", steps("    - run: for f in scripts/ci/*-drive*.sh; do $f; done\n      shell: bash\n")),
      "p/action.yml runs a drive script",
    );
  });

  it("A3, A4: a node action, or a step using another action, is refused by name", function () {
    refused(
      action("p/action.yml", "runs:\n  using: node20\n  main: main.js\n"),
      "p/action.yml runs using node20, not composite",
    );
    refused(
      action("p/action.yml", steps("    - uses: evil/x@main\n")),
      'p/action.yml step "evil/x@main" uses evil/x@main, not setup-node, download-artifact or cache/restore',
    );
  });

  it("A6, A7: an uppercase or nested action file is read", function () {
    const drive = steps("    - run: scripts/ci/deploy-drive.sh\n      shell: bash\n");
    refused(action("p/Action.yml", drive), "p/Action.yml runs a drive script");
    refused(action("a/b/action.yml", drive), "a/b/action.yml runs a drive script");
  });

  /** `text` as a second workflow `f` beside ci.yml. */
  const second = (text: string) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "ci.yml"), CI);
    fs.writeFileSync(path.join(dir, "x.yml"), text);
    return others(dir, path.join(dir, "ci.yml"), names);
  };

  it("O1, O3, O4: a second workflow running drives by glob, quoting a drive job or calling ci.yml is refused by name", function () {
    refused(
      second("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: for f in scripts/ci/*-drive*.sh; do $f; done\n"),
      "x.yml runs a drive script or names a drive job",
    );
    refused(
      second("on: push\njobs:\n  \"deploy-drives\":\n    steps: []\n"),
      "x.yml runs a drive script or names a drive job",
    );
    refused(
      second("on: push\njobs:\n  a:\n    uses: ./.github/workflows/ci.yml\n"),
      "x.yml calls ci.yml",
    );
  });
});
