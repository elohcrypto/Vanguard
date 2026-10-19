import { expect } from "chai";

/**
 * Task 5.17 slice A (deep review H-1): the coverage runs' pending gate
 * (scripts/ci/mocha-log.js pending): each loaded file's pending tests
 * equal scripts/ci/coverage-pending.json, on fixture records here.
 */
describe("mocha-log pending", function () {
  const { pendingFindings } = require("../../scripts/ci/mocha-log.js");
  const listed = { "test/p/Proofs.test.js": 12 };
  const tracked = ["test/p/Proofs.test.js", "test/r/Guards.test.ts"];

  it("passes a run whose pending counts equal the list", function () {
    const recorded = {
      "test/p/Proofs.test.js": 12,
      "test/r/Guards.test.ts": 0,
    };
    expect(pendingFindings(recorded, listed, tracked)).to.deep.equal([]);
  });

  it("fails a skipped suite outside the list", function () {
    const recorded = {
      "test/p/Proofs.test.js": 12,
      "test/r/Guards.test.ts": 24,
    };
    expect(pendingFindings(recorded, listed, tracked)).to.deep.equal([
      "test/r/Guards.test.ts: 24 pending, coverage-pending.json lists 0 (a skipped suite?)",
    ]);
  });

  it("fails a listed suite that no longer skips, and a listed file not tracked", function () {
    const recorded = { "test/p/Proofs.test.js": 3 };
    expect(
      pendingFindings(recorded, listed, ["test/r/Guards.test.ts"]),
    ).to.deep.equal([
      "test/p/Proofs.test.js is listed in coverage-pending.json but not tracked",
      "test/p/Proofs.test.js: 3 pending, coverage-pending.json lists 12 (update the list)",
    ]);
  });

  it("lists only tracked files with a positive count", function () {
    const { pending } = require("../../scripts/ci/coverage-pending.json");
    const fs = require("fs");
    for (const [f, n] of Object.entries(pending)) {
      expect(fs.existsSync(f), f).to.equal(true);
      expect(n as number, f).to.be.greaterThan(0);
    }
  });
});
