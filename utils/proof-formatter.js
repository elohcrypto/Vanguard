/**
 * @title ProofFormatter
 * @dev Formats a snarkjs PLONK proof for the PlonkVerifier contracts. The
 *      stack is PLONK for all five circuits since Task 3.7; the Groth16
 *      helpers (pi_a/pi_b/pi_c shapes) are gone with Groth16.
 */
class ProofFormatter {
  /**
   * Format a snarkjs PLONK proof for a snarkjs PlonkVerifier
   * (`verifyProof(uint256[24], uint256[N])`).
   * @param {Object} proof - snarkjs plonk proof object
   * @param {Array} publicSignals - Public signals array
   * @returns {Promise<{proof: string[], publicSignals: string[]}>}
   *          24 proof words and the signals, as decimal strings
   */
  static async formatPlonkForSolidity(proof, publicSignals) {
    const snarkjs = require("snarkjs");
    const calldata = await snarkjs.plonk.exportSolidityCallData(
      proof,
      publicSignals,
    );
    // snarkjs 0.7.x emits "[24 words][signals]" with no separator.
    const [words, signals] = JSON.parse(
      `[${calldata.replace(/\]\s*,?\s*\[/, "],[")}]`,
    );
    if (words.length !== 24) {
      throw new Error(
        `PLONK calldata has ${words.length} proof words, expected 24`,
      );
    }
    return {
      proof: words.map((w) => BigInt(w).toString()),
      publicSignals: signals.map((s) => BigInt(s).toString()),
    };
  }
}

module.exports = { ProofFormatter };
