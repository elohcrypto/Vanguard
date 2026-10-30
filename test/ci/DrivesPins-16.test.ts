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
  const { check, drives, others } = require("../../scripts/ci/drives-once");
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

  // R16-CS6: npm 10.9.8 takes an env npm_config_globalconfig over the
  // --globalconfig flag (npx exports one; measured), so the oracle sets
  // both npm_config_* keys to its pins too. A shim first in PATH records
  // what the oracle's npm printed for each `npm config list --json`.
  const shimmed = (env: Record<string, string>) => {
    const real = require("child_process").execFileSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
    const bin = tmp();
    const log = tmp();
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!/usr/bin/env bash\nout=$("${real}" "$@"); rc=$?\nprintf '%s' "$out"\ncase " $* " in *" --json "*) printf '%s' "$out" > "${log}/json-$$-$RANDOM";; esac\nexit $rc\n`,
      { mode: 0o755 },
    );
    const keep = { ...process.env };
    Object.assign(process.env, env, { PATH: `${bin}:${process.env.PATH}` });
    try {
      expect(oracle()).to.deep.equal([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
    return fs.readdirSync(log).map((f) => JSON.parse(fs.readFileSync(path.join(log, f), "utf8")));
  };
  /** Each JSON listing's user and global config: the two pinned files, distinct, whatever the env named. */
  const pinned = (lists: any[]) => {
    expect(lists).to.have.length(2);
    for (const o of lists) {
      expect(path.basename(o.userconfig), JSON.stringify(o.userconfig)).to.equal("user");
      expect(path.basename(o.globalconfig), JSON.stringify(o.globalconfig)).to.equal("global");
      expect(path.dirname(o.globalconfig)).to.equal(path.dirname(o.userconfig));
    }
  };
  it("P-N9: an inherited npm_config_globalconfig naming another file: npm still reads the oracle's pinned global file", function () {
    const other = path.join(tmp(), "other-npmrc");
    fs.writeFileSync(other, "");
    pinned(shimmed({ npm_config_globalconfig: other }));
  });

  it("P-N10: both npm_config_* keys naming one path: the oracle overrides them with its two distinct pins", function () {
    const one = path.join(tmp(), "one-npmrc");
    fs.writeFileSync(one, "");
    pinned(shimmed({ npm_config_userconfig: one, npm_config_globalconfig: one }));
  });

  it("P-N11: npm exiting non-zero is refused even when it printed a JSON object (lever row Z16-09)", function () {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\necho '{}'\nexit 1\n", { mode: 0o755 });
    const keep = process.env.PATH;
    process.env.PATH = `${bin}:${keep}`;
    try {
      const r = oracle();
      expect(r).to.have.length(1);
      expect(r[0]).to.match(/^npm config list failed: /);
    } finally {
      process.env.PATH = keep;
    }
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

  // Lane G G15-4 E13-E15: an env given as null is still an env key: it is
  // refused at each level as an unlisted literal, never skipped as falsy.
  for (const [id, at, put] of [
    ["P-E13", "the workflow", (d: any) => (d.env = null)],
    ["P-E14", "gates job", (d: any) => (d.jobs.gates.env = null)],
    ["P-E15", "gates step", (d: any) => (d.jobs.gates.steps.find((s: any) => s.run === "npm ci").env = null)],
  ] as [string, string, (d: any) => void][])
    it(`${id}: an env that is null at ${at} level is refused, not skipped`, function () {
      const doc = require("js-yaml").load(CI);
      put(doc);
      expect(check(doc, names)).to.include(`env not in ${lines.TABLE}: ${at}: null`);
    });

  it("P-E19: a second workflow's env that differs from the table is refused at workflow level", function () {
    expect(w2("name: w2\non: push\nenv:\n  CIRCOM_VERSION: v9.9.9\njobs: {}\n")).to.deep.equal([
      `w2.yml: env not in ${lines.TABLE}: the workflow: {"CIRCOM_VERSION":"v9.9.9"}`,
    ]);
  });
});
