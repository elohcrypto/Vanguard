import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Task 5.15 (review L-5): scripts/ci/coverage-merge.js sums the shards'
 * hit counts, and refuses a merge that is not the expected number of
 * shards or whose shards instrumented different contracts (a shard that
 * ran on another tree, or lost files, must not pass as the whole run).
 * Task 5.17 (deep review M-7): it also checks the set against the tracked
 * contracts and the merged branches against 91, so each case runs in a
 * fixture repo: contracts/A.sol and a test double, contracts/test/M.sol,
 * tracked, its .solcover.js skipping "test" as the real one does.
 */
describe("Coverage shard merge (scripts/ci/coverage-merge.js)", function () {
  let dir: string;
  const cov = (hits: number[], lines: number[], file = "contracts/A.sol") => ({
    [file]: {
      path: file,
      s: { 1: hits[0], 2: hits[1] },
      statementMap: {
        1: { start: { line: 1 }, end: { line: 1 } },
        2: { start: { line: 2 }, end: { line: 2 } },
      },
      f: { 1: hits[0] },
      fnMap: { 1: { name: "f", line: 1, loc: { start: { line: 1 } } } },
      b: { 1: [hits[0], hits[1]] },
      branchMap: { 1: { line: 1, type: "if", locations: [] } },
      l: { 1: lines[0], 2: lines[1] },
    },
  });
  const write = (name: string, c: object) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(c));
    return f;
  };
  const script = path.resolve("scripts/ci/coverage-merge.js");
  const merge = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd: dir,
    });
  const skip = (files: string[]) =>
    fs.writeFileSync(
      path.join(dir, ".solcover.js"),
      `module.exports = { skipFiles: ${JSON.stringify(files)} };`,
    );
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "covm-"));
    fs.mkdirSync(path.join(dir, "contracts"));
    fs.mkdirSync(path.join(dir, "contracts", "test"));
    for (const c of ["A", "test/M"])
      fs.writeFileSync(path.join(dir, "contracts", `${c}.sol`), "");
    skip(["test"]);
    for (const a of [
      ["init", "-q"],
      ["add", "contracts"],
    ])
      spawnSync("git", a, { cwd: dir });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sums the recorded hits: a line or arm hit in either shard is hit", function () {
    const a = write("a.json", cov([1, 0], [1, 0]));
    const b = write("b.json", cov([0, 2], [0, 2]));
    const out = path.join(dir, "m.json");
    const r = merge(out, "2", a, b);
    expect(r.status, r.stderr).to.equal(0);
    const m = JSON.parse(fs.readFileSync(out, "utf8"))["contracts/A.sol"];
    expect(m.l).to.deep.equal({ 1: 1, 2: 2 });
    expect(m.b[1]).to.deep.equal([1, 2]);
    expect(r.stdout).to.match(
      /^All files\s+\|\s+100 \|\s+100 \|\s+100 \|\s+100 \|/m,
    );
  });

  it("refuses another shard count, or shards with different contracts", function () {
    const a = write("a.json", cov([1, 0], [1, 0]));
    const b = write("b.json", cov([0, 2], [0, 2]));
    const c = write("c.json", {
      ...cov([0, 2], [0, 2]),
      ...cov([1, 1], [1, 1], "contracts/B.sol"),
    });
    const out = path.join(dir, "m.json");
    const few = merge(out, "3", a, b);
    expect(few.status).to.equal(1);
    expect(few.stderr).to.contain("2 shard file(s), expected 3");
    const odd = merge(out, "2", a, c);
    expect(odd.status).to.equal(1);
    expect(odd.stderr).to.match(
      /instrumented other contracts .*contracts\/B\.sol/,
    );
  });

  it("refuses a tracked contract missing from the shards (M-7)", function () {
    fs.writeFileSync(path.join(dir, "contracts", "B.sol"), "");
    spawnSync("git", ["add", "contracts"], { cwd: dir });
    const a = write("a.json", cov([1, 0], [1, 0]));
    const b = write("b.json", cov([0, 2], [0, 2]));
    const r = merge(path.join(dir, "m.json"), "2", a, b);
    expect(r.status).to.equal(1);
    expect(r.stderr).to.contain("contracts/B.sol not instrumented");
  });

  it("refuses merged branch coverage under the baseline (M-7)", function () {
    const a = write("a.json", cov([1, 0], [1, 1]));
    const r = merge(path.join(dir, "m.json"), "2", a, a);
    expect(r.status).to.equal(1);
    expect(r.stdout).to.contain("branch coverage: 50% (baseline 91)");
    expect(r.stderr).to.contain("branch coverage 50% dropped below baseline");
  });
});
