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

module.exports = { describeProofs, REASON };
