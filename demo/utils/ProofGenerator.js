/**
 * @fileoverview Zero-knowledge proof generation utilities
 * @module ProofGenerator
 * @description Initialises the real ZK proof generator (scripts/
 * generate-real-proofs.js) the demo shares in state.realProofGenerator, and
 * tracks proof generation times. The demo has no mock proofs (Task 3.6).
 *
 * @example
 * const ProofGenerator = require('./utils/ProofGenerator');
 * const generator = new ProofGenerator(state);
 * await generator.initializeRealProofGenerator();
 */

/**
 * @class ProofGenerator
 * @description Holds the real proof generator for privacy-preserving compliance.
 */
class ProofGenerator {
  /**
   * Create a ProofGenerator
   * @param {Object} state - DemoState instance
   */
  constructor(state) {
    /**
     * @property {Object} state - Reference to DemoState
     * @private
     */
    this.state = state;
  }

  /**
   * Initialize real proof generator
   *
   * @returns {Promise<void>}
   *
   * @example
   * await generator.initializeRealProofGenerator();
   */
  async initializeRealProofGenerator() {
    if (!this.state.realProofGenerator) {
      console.log("🔧 Initializing RealProofGenerator...");
      const path = require("path");
      const { RealProofGenerator } = require(
        path.join(__dirname, "../../scripts/generate-real-proofs.js"),
      );
      this.state.realProofGenerator = new RealProofGenerator();
      await this.state.realProofGenerator.initialize();
      console.log("✅ RealProofGenerator initialized");
    }
  }

  /**
   * Track proof generation time
   *
   * @param {string} proofType - Type of proof
   * @param {number} timeMs - Time in milliseconds
   *
   * @example
   * generator.trackProofGenerationTime('whitelist', 1500);
   */
  trackProofGenerationTime(proofType, timeMs) {
    if (!this.state.proofGenerationTimes.has(proofType)) {
      this.state.proofGenerationTimes.set(proofType, []);
    }
    this.state.proofGenerationTimes.get(proofType).push(timeMs);
  }

  /**
   * Get average proof generation time
   *
   * @param {string} proofType - Type of proof
   * @returns {number} Average time in milliseconds
   *
   * @example
   * const avgTime = generator.getAverageProofGenerationTime('whitelist');
   * console.log(`Average: ${avgTime}ms`);
   */
  getAverageProofGenerationTime(proofType) {
    const times = this.state.proofGenerationTimes.get(proofType);
    if (!times || times.length === 0) return 0;
    return times.reduce((a, b) => a + b, 0) / times.length;
  }
}

module.exports = ProofGenerator;
