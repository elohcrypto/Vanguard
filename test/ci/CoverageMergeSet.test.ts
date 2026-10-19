import { expect } from "chai";

/**
 * Task 5.17 slice A (deep review M-7): scripts/ci/coverage-merge.js
 * expects the tracked contracts minus .solcover.js skips, and refuses a
 * skip that reaches a contract the guard table covers, on fixtures.
 */
describe("coverage-merge: the instrumented set", function () {
  const {
    expectedContracts,
    setFindings,
  } = require("../../scripts/ci/coverage-merge.js");
  const tracked = [
    "contracts/governance/VanguardGovernance.sol",
    "contracts/oracle/WhitelistOracle.sol",
    "contracts/test/mocks/MockToken.sol",
    "contracts/privacy/verifiers/WhitelistVerifier.sol",
  ];
  const production = (f: string) =>
    !/^contracts\/(test|privacy\/verifiers)\//.test(f);

  it("expects the tracked contracts minus the skipped doubles and verifiers", function () {
    const { want, errors } = expectedContracts(
      tracked,
      ["test", "mocks", "privacy/verifiers"],
      production,
    );
    expect(errors).to.deep.equal([]);
    expect(want).to.deep.equal([
      "contracts/governance/VanguardGovernance.sol",
      "contracts/oracle/WhitelistOracle.sol",
    ]);
    expect(setFindings(want, want)).to.deep.equal([]);
  });

  it("fails a contract dropped from the instrumented set", function () {
    const { want } = expectedContracts(tracked, ["test"], production);
    const got = want.filter((f: string) => !f.includes("Governance"));
    expect(setFindings(got, want)).to.include(
      "contracts/governance/VanguardGovernance.sol not instrumented",
    );
  });

  it("fails a skipFiles entry that drops a covered contract (review M-7)", function () {
    const { want, errors } = expectedContracts(
      tracked,
      ["test", "governance"],
      production,
    );
    expect(want).to.not.include("contracts/governance/VanguardGovernance.sol");
    expect(errors).to.deep.equal([
      ".solcover.js skipFiles drops contracts/governance/VanguardGovernance.sol, a covered contract",
    ]);
  });
});
