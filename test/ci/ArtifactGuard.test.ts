import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const {
  fingerprint,
  artifactsChanged,
} = require("../../scripts/ci/artifactGuard");

/**
 * Task 5.17 (CI run 39308877486): the coverage runs fail when artifacts/
 * changes during the run (a child `hardhat run` recompiled the clean
 * build over the instrumented one), naming the cause once.
 */
describe("Coverage artifact guard (scripts/ci/artifactGuard.js)", function () {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-"));
    fs.mkdirSync(path.join(dir, "contracts", "A.sol"), { recursive: true });
    fs.writeFileSync(path.join(dir, "contracts", "A.sol", "A.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an artifact");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("an untouched tree passes; a rewritten, added or removed artifact fails once, naming it", function () {
    const start = fingerprint(dir);
    expect(start).to.have.length(1);
    expect(artifactsChanged(start, fingerprint(dir))).to.equal(null);
    // A non-artifact file does not count.
    fs.writeFileSync(path.join(dir, "notes.txt"), "changed");
    expect(artifactsChanged(start, fingerprint(dir))).to.equal(null);
    const a = path.join(dir, "contracts", "A.sol", "A.json");
    fs.writeFileSync(a, '{"bytecode":"0x60"}');
    const why = artifactsChanged(start, fingerprint(dir));
    expect(why).to.equal(
      `artifacts/ changed during the coverage run: a child process recompiled; wrap that suite in describeUnlessCoverage or pass --no-compile (1 artifact(s) changed, e.g. ${path.join("contracts", "A.sol", "A.json")})`,
    );
    const now = fingerprint(dir);
    fs.writeFileSync(path.join(dir, "B.json"), "{}");
    expect(artifactsChanged(now, fingerprint(dir))).to.contain("B.json");
    fs.rmSync(a);
    expect(artifactsChanged(now, fingerprint(dir))).to.contain("A.json");
  });

  it("a missing tree fingerprints as empty", function () {
    expect(fingerprint(path.join(dir, "none"))).to.deep.equal([]);
  });
});
