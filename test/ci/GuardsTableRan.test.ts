import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Slice A review HIGH-1: scripts/ci/guards-table.js --ran binds every
 * tested row to a test that passed in the tests job (its MOCHA_TIMINGS
 * records), not to text: a guard file commented out line by line, or a
 * describe under `if (process.env.X)`, has no passing test and fails.
 */
describe("guards-table --ran: tested rows bound to passing tests", function () {
  const { notPassed } = require("../../scripts/ci/guards-table.js");
  const pass = (file: string, name: string) => ({ kind: "test", file, name });

  it("matches (file, title) of passing tests only; ${...} matches any expansion", function () {
    const rows = [
      { file: "t/a.ts", test: "a ${on} recovery reverts", site: "s1" },
      { file: "t/a.ts", test: "plain", site: "s2" },
      { file: "t/b.ts", test: "plain", site: "s3" },
      { file: "t/a.ts", test: "hooked", site: "s4" },
      // INFO-1: all template, no literal text: bound to nothing.
      { file: "t/b.ts", test: "${name}", site: "s5" },
    ];
    const ran = [
      pass("t/a.ts", "a VGT recovery reverts"),
      pass("t/b.ts", "plain"),
      { kind: "hook", file: "t/a.ts", name: "hooked" },
    ];
    expect(notPassed(rows, ran).map((r: any) => r.site)).to.deep.equal([
      "s2",
      "s4",
      "s5",
    ]);
  });

  it("the CLI fails naming each row whose test is missing from the runs", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ran-"));
    try {
      const table = "test/guards/table";
      const rows = fs
        .readdirSync(table)
        .flatMap(
          (f) => JSON.parse(fs.readFileSync(path.join(table, f), "utf8")).sites,
        )
        .filter((r: any) => r.class === "tested");
      const gone = "test/guards/RegistryTokenGuards.test.ts";
      const write = (name: string, keep: (r: any) => boolean) => {
        const f = path.join(dir, name);
        fs.writeFileSync(
          f,
          rows
            .filter(keep)
            .map((r: any) => JSON.stringify(pass(r.file, r.test)))
            .join("\n"),
        );
        return f;
      };
      const all = spawnSync(
        process.execPath,
        ["scripts/ci/guards-table.js", "--ran", write("all.log", () => true)],
        { encoding: "utf8" },
      );
      expect(all.status, all.stderr).to.equal(0);
      const some = spawnSync(
        process.execPath,
        [
          "scripts/ci/guards-table.js",
          "--ran",
          write("some.log", (r) => r.file !== gone),
        ],
        { encoding: "utf8" },
      );
      expect(some.status).to.equal(1);
      const missing = rows.filter((r: any) => r.file === gone).length;
      expect(missing).to.be.greaterThan(0);
      expect(
        some.stderr.match(/did not pass in the recorded test runs/g),
      ).to.have.length(missing);
      expect(some.stderr).to.contain(`(${gone}) did not pass`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  // Slice B review L-3: a test that skips itself synchronously finishes
  // without an error; the recorder must not list it as passed.
  it("the recorder lists passing tests only, not a this.skip() one", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ran-skip-"));
    try {
      const spec = path.join(dir, "s.spec.js");
      fs.writeFileSync(
        spec,
        [
          'it("passes", function () {});',
          'it("skips itself", function () { this.skip(); });',
          'it("skips itself async", async function () { this.skip(); });',
        ].join("\n"),
      );
      const out = path.join(dir, "t.log");
      const run = spawnSync(
        process.execPath,
        [
          "-e",
          `const path = require("path");
           const Mocha = require(require.resolve("mocha", { paths: [path.dirname(require.resolve("hardhat/package.json"))] }));
           const m = new Mocha({ rootHooks: require(process.argv[1]).mochaHooks, reporter: "dot" });
           m.addFile(process.argv[2]);
           m.run((f) => process.exit(f));`,
          path.resolve("scripts/ci/mocha-log.js"),
          spec,
        ],
        { env: { ...process.env, MOCHA_TIMINGS: out }, encoding: "utf8" },
      );
      expect(run.status, run.stderr + run.stdout).to.equal(0);
      const tests = fs
        .readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.kind === "test")
        .map((r) => r.name);
      expect(tests).to.deep.equal(["passes"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
