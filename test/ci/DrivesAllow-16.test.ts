import { expect } from "chai";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 16 (item A, lane G G15-1, lead-r15/g15-1-*; R16-C1): npm
 * 10.9.8 expands `${VAR}` inside an .npmrc KEY in its config layer, after
 * ini has parsed the file, so `${GITHUB_REF_NAME}=./hide.sh` is the key
 * script-shell on a branch named script-shell, and the gate, comparing
 * the raw key, passed it (A20-A23, swarm-15/G/tests/attack-u2r15-ci5).
 * Round 14 (quoting) and round 15 (ini's decode/unsafe) both re-derived
 * which keys npm honours and both failed; now any .npmrc in the tree is
 * refused by name, and npm itself is asked (`npm config list --json` at
 * the root against a fresh empty directory, user and global config pinned
 * to two distinct empty files): any key that differs is refused.
 */
describe("every drive exactly once: npm's project config is pinned empty (round 16)", function () {
  this.timeout(120000);
  const yaml = require("js-yaml");
  const ROOT = path.join(__dirname, "../..");
  const BYNAME = ".npmrc: an .npmrc is not allowed in this tree; npm's project config is pinned empty (R16-C1)";
  const tree = () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "drives-16-"));
    fs.cpSync(path.join(ROOT, ".github"), path.join(t, ".github"), { recursive: true });
    fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(t, "scripts/ci"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(t, "package.json"));
    return t;
  };
  const ci = (t: string) => path.join(t, ".github/workflows/ci.yml");
  const SH = (t: string, rel: string, txt: string) => {
    fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true });
    fs.writeFileSync(path.join(t, rel), txt);
  };
  const name = (t: string, n: string) => {
    const d = yaml.load(fs.readFileSync(ci(t), "utf8"));
    d.name = n;
    fs.writeFileSync(ci(t), yaml.dump(d, { lineWidth: -1 }));
  };
  const gate = (t: string, env: Record<string, string>) => {
    const r = cp.spawnSync("node", [path.join(ROOT, "scripts/ci/drives-once.js"), ci(t)], {
      encoding: "utf8",
      cwd: t,
      env: { ...process.env, ...env },
    });
    return { code: r.status, out: `${r.stderr}${r.stdout}` };
  };
  /** `f` on a fresh copy, the gate run with `env`: exit 0, or refused naming each of `want`. */
  const row = (title: string, env: Record<string, string>, f: (t: string) => void, want: "PASSES" | string[]) =>
    it(title, function () {
      const t = tree();
      try {
        f(t);
        const r = gate(t, env);
        expect(r.out, "no crash").not.to.match(/TypeError|ReferenceError|\n\s+at /);
        if (want === "PASSES") expect(r.code, r.out).to.equal(0);
        else {
          expect(r.code, `refused: ${r.out}`).to.equal(1);
          for (const w of want) expect(r.out).to.contain(w);
        }
      } finally {
        fs.rmSync(t, { recursive: true, force: true });
      }
    });

  describe("R16-C1: lane G's env-expanded keys, ci.yml untouched or only renamed", function () {
    row("control: the shipped tree passes", {}, () => {}, "PASSES");
    row("A20 `${GITHUB_WORKFLOW}=./hide.sh` + workflow `name: script-shell`", { GITHUB_WORKFLOW: "script-shell" }, (t) => {
      name(t, "script-shell");
      SH(t, ".npmrc", "${GITHUB_WORKFLOW}=./hide.sh\n");
    }, [BYNAME, "npm's project config sets script-shell"]);
    row("A21 `script-${GITHUB_WORKFLOW}=` + `name: shell`", { GITHUB_WORKFLOW: "shell" }, (t) => {
      name(t, "shell");
      SH(t, ".npmrc", "script-${GITHUB_WORKFLOW}=./hide.sh\n");
    }, [BYNAME]);
    row('A22 quoted `"${GITHUB_WORKFLOW}"=` + `name: node-options`', { GITHUB_WORKFLOW: "node-options" }, (t) => {
      name(t, "node-options");
      SH(t, ".npmrc", '"${GITHUB_WORKFLOW}"=--require ./hide.js\n');
    }, [BYNAME]);
    row("A23 `${GITHUB_WORKFLOW}=./evilrc` + `name: userconfig` + evilrc", { GITHUB_WORKFLOW: "userconfig" }, (t) => {
      name(t, "userconfig");
      SH(t, ".npmrc", "${GITHUB_WORKFLOW}=./evilrc\n");
      SH(t, "evilrc", "script-shell=./hide.sh\n");
    }, [BYNAME]);
    row("`${GITHUB_REF_NAME}=./hide.sh` on a branch named script-shell (ci.yml untouched)", { GITHUB_REF_NAME: "script-shell" }, (t) => SH(t, ".npmrc", "${GITHUB_REF_NAME}=./hide.sh\n"), [BYNAME]);
    row("`${GITHUB_HEAD_REF}=./hide.sh` on a fork branch named script-shell", { GITHUB_HEAD_REF: "script-shell" }, (t) => SH(t, ".npmrc", "${GITHUB_HEAD_REF}=./hide.sh\n"), [BYNAME]);
  });

  describe("R16-C1: the oracle alone (npm config list at the root against an empty directory)", function () {
    let config: ((root: string) => string[]) | null = null;
    try {
      config = require("../../scripts/ci/drives-npm").config;
    } catch {
      config = null;
    }
    const fixture = (rc?: string, extra: Record<string, string> = {}) => {
      const t = fs.mkdtempSync(path.join(os.tmpdir(), "drives-npm-16-"));
      SH(t, "package.json", '{"name":"f","version":"1.0.0"}');
      if (rc !== undefined) SH(t, ".npmrc", rc);
      for (const [f, c] of Object.entries(extra)) SH(t, f, c);
      return t;
    };
    /** The oracle's rows for the fixture (`rc`, `extra`) with `env` set in this process. */
    const ask = (env: Record<string, string>, rc?: string, extra?: Record<string, string>) => {
      expect(config, "scripts/ci/drives-npm.js exports config(root)").to.be.a("function");
      const t = fixture(rc, extra);
      const old: Record<string, string | undefined> = {};
      for (const k of Object.keys(env)) (old[k] = process.env[k]), (process.env[k] = env[k]);
      try {
        return config!(t);
      } finally {
        for (const k of Object.keys(env)) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]);
        fs.rmSync(t, { recursive: true, force: true });
      }
    };
    const SETS = (k: string) => `npm's project config sets ${k}`;
    it("an env-expanded key with its env set", function () {
      expect(ask({ X16: "script-shell" }, "${X16}=./hide.sh\n")).to.deep.equal([SETS("script-shell")]);
    });
    it("a quoted key", function () {
      expect(ask({}, '"script-shell"=./hide.sh\n')).to.deep.equal([SETS("script-shell")]);
    });
    it("CR-only line ends", function () {
      expect(ask({}, "foo=1\rscript-shell=./hide.sh\r")).to.include(SETS("script-shell"));
    });
    it("an unknown key", function () {
      expect(ask({}, "foo-bar=1\n")).to.deep.equal([SETS("foo-bar")]);
    });
    it("the userconfig redirect", function () {
      const r = ask({}, "userconfig=./evil.npmrc\n", { "evil.npmrc": "script-shell=./hide.sh\n" });
      expect(r).to.include(SETS("userconfig"));
      expect(r).to.include(SETS("script-shell"));
    });
    it("no .npmrc: nothing", function () {
      expect(ask({})).to.deep.equal([]);
    });
    it("npm missing from PATH: refused, never passed", function () {
      const r = ask({ PATH: path.join(os.tmpdir(), "no-npm-here") });
      expect(r).to.have.length(1);
      expect(r[0]).to.match(/^npm config list failed: /);
    });
  });
});
