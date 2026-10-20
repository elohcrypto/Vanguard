import { expect } from "chai";

/**
 * Task 5.11 (review L-2): scripts/ci/audit-ratchet.js ratchets both
 * npm audit's high count (`high`) and the production tree's
 * (`--omit=dev`, `omitDev.high`). A rise fails, a drop is a notice,
 * and a missing count or baseline fails. On fixture counts here.
 */
describe("audit ratchet", function () {
  const { checks } = require("../../scripts/ci/audit-ratchet.js");
  const base = { high: 21, omitDev: { high: 0 } };
  const errors = (b: object, live: object) =>
    checks(b, live).flatMap((r: { errors: string[] }) => r.errors);

  it("passes at the baseline and logs both counts", function () {
    const results = checks(base, { all: 21, omitDev: 0 });
    expect(
      results.flatMap((r: { errors: string[] }) => r.errors),
    ).to.deep.equal([]);
    expect(results.flatMap((r: { log: string[] }) => r.log)).to.deep.equal([
      "high vulnerabilities: 21 (baseline 21)",
      "high vulnerabilities, --omit=dev: 0 (baseline 0)",
    ]);
  });

  it("fails when the production count rises", function () {
    expect(errors(base, { all: 21, omitDev: 1 })).to.deep.equal([
      "High-severity count, --omit=dev rose from 0 to 1.",
    ]);
  });

  it("fails when the full count rises", function () {
    expect(errors(base, { all: 22, omitDev: 0 })).to.deep.equal([
      "High-severity count rose from 21 to 22.",
    ]);
  });

  it("fails a production audit that gave no number", function () {
    expect(errors(base, { all: 21, omitDev: undefined })).to.deep.equal([
      "npm audit, --omit=dev gave no numeric high count: 'undefined'",
    ]);
  });

  it("fails a missing or negative omitDev baseline", function () {
    expect(errors({ high: 21 }, { all: 21, omitDev: 0 })).to.deep.equal([
      "audit-baseline.json omitDev.high is not a count: undefined",
    ]);
    expect(
      errors({ high: 21, omitDev: { high: -1 } }, { all: 21, omitDev: 0 }),
    ).to.deep.equal(["audit-baseline.json omitDev.high is not a count: -1"]);
  });

  it("notices a drop on either count", function () {
    const notices = checks(
      { high: 21, omitDev: { high: 2 } },
      { all: 20, omitDev: 0 },
    ).flatMap((r: { notices: string[] }) => r.notices);
    expect(notices).to.have.length(2);
    expect(notices[1]).to.contain("lower omitDev.high");
  });

  it("the committed baseline gates production at 0", function () {
    const committed = require("../../scripts/ci/audit-baseline.json");
    expect(committed.omitDev.high).to.equal(0);
    expect(Number.isInteger(committed.high)).to.equal(true);
  });
});
