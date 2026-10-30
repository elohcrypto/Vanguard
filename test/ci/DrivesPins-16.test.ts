import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 16 (items A and E; R16-C1, R16-C5): one pin per rule of the
 * pinned-empty npm project config that DrivesAllow-16's rows leave
 * unguarded (the static scan by name, the oracle's environment, its two
 * pinned files, values compared, not only keys), and lane G's round-15
 * survivors E18/E19 (a tabled env literal that differs in a second
 * workflow is refused at step and at workflow level).
 */
describe("drives-once pins, round 16 (npm's project config pinned empty; lane G's round-15 survivors)", function () {
  this.timeout(60000);
  const { drives, others } = require("../../scripts/ci/drives-once");
  const lines = require("../../scripts/ci/drives-lines");
  const npm = require("../../scripts/ci/drives-npm");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const names = drives(path.join(ROOT, "scripts/ci"));
  const BY = (p: string) => `${p}: an .npmrc is not allowed in this tree; npm's project config is pinned empty (R16-C1)`;
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drives-pins-16-"));
  const put = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  /** The oracle on a package directory holding `rc` as its .npmrc (none if undefined). */
  const oracle = (rc?: string) => {
    const root = tmp();
    put(root, "package.json", '{"name":"f","version":"1.0.0"}');
    if (rc !== undefined) put(root, ".npmrc", rc);
    return npm.config(root).map((r: string) => r.split(root).join("<root>"));
  };
  const PROJ = "npm reads a project config: <root>/.npmrc";

  // Item A (R16-C1): the static scan, by name.
  it("P-N1: an .npmrc in a subdirectory is refused by name", function () {
    const root = tmp();
    put(root, "a/b/.npmrc", "fund=false\n");
    expect(lines.npmrc(root)).to.deep.equal([BY("a/b/.npmrc")]);
  });

  it("P-N2: a symlink named .npmrc is refused, dangling or not", function () {
    const root = tmp();
    fs.symlinkSync("nowhere", path.join(root, ".npmrc"));
    expect(lines.npmrc(root)).to.deep.equal([BY(".npmrc")]);
  });

  it("P-N3: an .npmrc inside a symlinked directory is not followed (lane G N30: the rule as stated)", function () {
    const root = tmp();
    const out = tmp();
    put(out, ".npmrc", "script-shell=./hide.sh\n");
    fs.symlinkSync(out, path.join(root, "linked"));
    expect(lines.npmrc(root)).to.deep.equal([]);
  });

  // Item A (R16-C1): the oracle.
  it("P-N4: the oracle passes process.env through (scrubbing it is the mutant)", function () {
    process.env.X16P = "script-shell";
    try {
      expect(oracle("${X16P}=./h\n")).to.deep.equal(["npm's project config sets script-shell", PROJ]);
    } finally {
      delete process.env.X16P;
    }
  });

  it("P-N5: user and global config are two distinct empty files (one file makes npm fail, which must refuse, not pass)", function () {
    expect(oracle()).to.deep.equal([]);
  });

  it("P-N6: a differing value of a known key is refused, not only a new key", function () {
    expect(oracle("engine-strict=true\n")).to.deep.equal(["npm's project config sets engine-strict", PROJ]);
  });

  it("P-N7: a project config holding only globalconfig is a source the oracle refuses (the cli layer shadows the key)", function () {
    expect(oracle("globalconfig=./g\n")).to.deep.equal([PROJ]);
  });

  // R16-CS4 (1), measured: npm names no source for an .npmrc with no key,
  // so the oracle's claim is "npm reads no project config key here"; the
  // static scan refuses these files by name.
  it("P-N8: an .npmrc that is empty or comments only: npm reads no key, the oracle is silent", function () {
    expect(oracle("")).to.deep.equal([]);
    expect(oracle("; a comment\n# another\n")).to.deep.equal([]);
  });

  // Item E (R16-C5, lane G G15-4 E18/E19): a second workflow's env literal at each level.
  const w2 = (body: string) => {
    const dir = tmp();
    put(dir, "ci.yml", CI);
    put(dir, "w2.yml", body);
    return others(dir, path.join(dir, "ci.yml"), names).map((e: string) => e.replace(`${dir}/`, ""));
  };
  it("P-E18: a tabled env literal reused at step level in a second workflow is refused (lane G B33)", function () {
    expect(w2("name: w2\non: push\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm test\n        env:\n          CIRCOM_VERSION: v2.2.3\n")).to.include(
      `w2.yml: env not in ${lines.TABLE}: x step: {"CIRCOM_VERSION":"v2.2.3"}`,
    );
  });

  it("P-E19: a second workflow's env that differs from the table is refused at workflow level", function () {
    expect(w2("name: w2\non: push\nenv:\n  CIRCOM_VERSION: v9.9.9\njobs: {}\n")).to.deep.equal([
      `w2.yml: env not in ${lines.TABLE}: the workflow: {"CIRCOM_VERSION":"v9.9.9"}`,
    ]);
  });
});
