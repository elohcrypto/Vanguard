// The CI coverage step runs with ZK_PROOFS=0: it instruments contracts, and
// the real-proof suites (PLONK proving, ~9 s per proof) would only add
// time there. The test step keeps proving everything (ci.yml).
const REASON =
  "real proofs are covered by the test step; coverage instruments contracts";

/** `describe`, or `describe.skip` with the reason when ZK_PROOFS=0. */
function describeProofs(title, fn) {
  if (process.env.ZK_PROOFS === "0") {
    return describe.skip(`${title} (${REASON})`, fn);
  }
  return describe(title, fn);
}

/**
 * True inside `hardhat coverage` (solidity-coverage 0.8 sets this flag on
 * the HRE before the tests run). Instrumented bytecode costs more gas, so
 * an absolute gas bound measured on the real build is not a property of
 * the instrumented one: the gas tests measure and print under coverage,
 * and assert the bound only on the real build (Task 4.15, C L1).
 */
function underCoverage() {
  return require("hardhat").__SOLIDITY_COVERAGE_RUNNING === true;
}

/**
 * `describe`, or `describe.skip` with `reason` in the title under
 * coverage: for a suite that cannot run instrumented (it prints why; a
 * silent skip would hide a dropped suite).
 */
function describeUnlessCoverage(title, reason, fn) {
  if (underCoverage()) {
    return describe.skip(`${title} (skipped under coverage: ${reason})`, fn);
  }
  return describe(title, fn);
}

module.exports = {
  describeProofs,
  describeUnlessCoverage,
  underCoverage,
  REASON,
};
