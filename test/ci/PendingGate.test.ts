import { expect } from "chai";

/**
 * Task 5.17 (deep review H-1; slice A review L-1): the coverage runs'
 * pending gate (scripts/ci/mocha-log.js pending). A pending test is
 * allowed only under a suite whose title carries a marker of
 * test/helpers/zkProofs.js (describeProofs' reason, describeUnlessCoverage's
 * "skipped under coverage:"); any other fails, naming its file. On
 * fixture suite trees and records here.
 */
describe("mocha-log pending", function () {
  const { pendingFindings } = require("../../scripts/ci/mocha-log.js");
  const { MARKERS, REASON } = require("../helpers/zkProofs");

  it("passes marked pending tests only", function () {
    const recorded = {
      "test/p/Proofs.test.js": { marked: 12, unmarked: 0 },
      "test/r/Guards.test.ts": { marked: 0, unmarked: 0 },
    };
    expect(pendingFindings(recorded)).to.deep.equal([]);
  });

  it("fails a skipped suite outside a marked one, naming the file", function () {
    const recorded = {
      "test/p/Proofs.test.js": { marked: 12, unmarked: 0 },
      "test/r/Guards.test.ts": { marked: 0, unmarked: 24 },
    };
    expect(pendingFindings(recorded)).to.deep.equal([
      "test/r/Guards.test.ts: 24 pending test(s) outside a describeProofs / describeUnlessCoverage suite (a skipped suite?)",
    ]);
  });

  it("the markers are the helpers' own titles", function () {
    expect(MARKERS).to.deep.equal([REASON, "skipped under coverage:"]);
    const { describeUnlessCoverage } = require("../helpers/zkProofs");
    expect(describeUnlessCoverage.toString()).to.contain("COVERAGE_SKIP");
  });
});
