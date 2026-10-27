import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 11 (item D): pins for the drive gate's rules lane G's lever
 * left unpinned at b7b314c (g-mutants-10.txt): G63 (the runner label is
 * the whole label), G72 (the prepare action is that path exactly), G73
 * (prepare takes no input), G74 (setup-node takes node-version and cache
 * only), G80 (an action.yaml is read). Each passes at the round-11 head.
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
