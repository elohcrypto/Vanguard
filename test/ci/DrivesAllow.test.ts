import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 10 (item C, lane G's GCI-9; R10-C2): round 9's grammar
 * refused continue-on-error, if, strategy and matrix on the drive jobs
 * and nothing else, so a drive step's shell, working-directory or
 * BASH_ENV, a job's or the workflow's defaults, a local composite step,
 * a hidden extra run, a reusable workflow or a container all passed, and
 * the gate read only ci.yml. The drive jobs now follow an allow-list:
 * every other key, at any level, is refused by name; the gate reads
 * every workflow file. Lane G's rows, each refused by name; H35 pinned (a
 * `run: |` block is the drive line once trimmed).
 */
describe("every drive exactly once: the drive jobs' allow-list (round 10)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const { check, drives } = require("../../scripts/ci/drives-once");
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
  const refused = (doc: any, ...why: string[]) => {
    const got = check(doc, names).join("\n");
    for (const w of why) expect(got).to.contain(w);
  };

  it("the committed workflow passes", function () {
    expect(check(load(), names)).to.deep.equal([]);
  });

  it("V1, V1b, V13: a drive step's shell is refused by name", function () {
    for (const sh of ["true {0}", "bash -c 'exit 0' {0}", "pwsh"]) {
      const doc = load();
      drive(doc).shell = sh;
      refused(doc, `deploy-drives step "${DRIVE}" sets shell`);
    }
  });

  it("V2: a drive step's working-directory is refused by name", function () {
    const doc = load();
    drive(doc)["working-directory"] = "stub";
    refused(doc, `deploy-drives step "${DRIVE}" sets working-directory`);
  });

  it("V3, V19: defaults on the drive job or the workflow are refused by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"].defaults = { run: { shell: "true {0}" } };
    refused(doc, "deploy-drives job sets defaults");
    const top = load();
    top.defaults = { run: { shell: "true {0}" } };
    refused(top, "the workflow sets defaults");
  });

  it("V4: BASH_ENV on a drive step is refused by name", function () {
    const doc = load();
    drive(doc).env = { BASH_ENV: "/dev/null" };
    refused(doc, `deploy-drives step "${DRIVE}" sets env BASH_ENV`);
  });

  it("V5: a local composite step other than prepare is refused by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"].steps.push({ uses: "./.github/actions/drive" });
    refused(
      doc,
      `deploy-drives step "./.github/actions/drive" uses ./.github/actions/drive`,
    );
  });

  it("V6, V6b: a hidden extra run, in a drive job or another job, is refused by name", function () {
    const doc = load();
    const extra = "cd scripts/ci && ./deploy-drive.sh || true";
    doc.jobs["deploy-drives"].steps.push({ run: extra });
    refused(doc, `deploy-drives step "${extra}" is not a drive line`);
    const gates = load();
    const up = "bash scripts/ci/../ci/deploy-drive.sh || true";
    gates.jobs.gates.steps.push({ run: up });
    refused(
      gates,
      `gates step "${up}" runs a drive outside demo and deploy-drives`,
    );
  });

  it("V7: a job calling a reusable workflow is refused by name", function () {
    const doc = load();
    doc.jobs.drives2 = { uses: "./.github/workflows/drives.yml" };
    refused(doc, "drives2 job calls the reusable workflow ./.github/workflows/drives.yml");
  });

  it("V15, V18: a trailing-space continue-on-error or a container on the drive job is refused by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"]["continue-on-error "] = true;
    refused(doc, "deploy-drives job sets continue-on-error");
    const box = load();
    box.jobs["deploy-drives"].container = "alpine";
    refused(box, "deploy-drives job sets container");
  });

  it("a second workflow running a drive script, or naming a drive job, fails the gate step by name", function () {
    const step = load().jobs.gates.steps.find(
      (x: any) => x.name === "Every drive exactly once",
    );
    for (const [file, text] of [
      ["drives.yml", "on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - run: scripts/ci/deploy-drive.sh\n"],
      ["names.yaml", "on: push\njobs:\n  deploy-drives:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n"],
    ]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drives-allow-"));
      try {
        fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"), CI);
        fs.writeFileSync(path.join(dir, ".github/workflows", file), text);
        fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(dir, "scripts/ci"), {
          recursive: true,
        });
        fs.symlinkSync(
          path.join(ROOT, "node_modules"),
          path.join(dir, "node_modules"),
        );
        const r = spawnSync("bash", ["-e", "-c", step.run], {
          cwd: dir,
          encoding: "utf8",
        });
        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, out).to.equal(1);
        expect(out).to.contain(
          `.github/workflows/${file} runs a drive script or names a drive job`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("P35 (kills H35): a drive step written as a `run: |` block is the drive line, trimmed", function () {
    const doc = load();
    drive(doc).run =
      "scripts/ci/deploy-drive.sh && scripts/ci/multisig-drive.sh\n";
    expect(check(doc, names)).to.deep.equal([]);
  });
});
