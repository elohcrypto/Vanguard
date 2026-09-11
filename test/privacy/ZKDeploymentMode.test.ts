import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The demo must not deploy a mock verifier while calling it real.
 *
 * demo/modules/PrivacyModule.js deployed ZKVerifierIntegrated with
 * testingMode = true under the log line "Real ZK Verifiers". In that mode every
 * verify* function skips Groth16 and returns true for any non-zero public
 * signal, so an all-zero proof was accepted. testingMode is immutable, so the
 * deployed instance could never be corrected without redeploying.
 */
describe("ZK deployment mode", function () {
  it("rejects a garbage proof when testingMode is off", async function () {
    const v = await (await ethers.getContractFactory("ZKVerifierIntegrated")).deploy(false);
    const ok = await v.verifyWhitelistMembership.staticCall(
      [0, 0], [[0, 0], [0, 0]], [0, 0], [1]
    );
    expect(ok, "a zero proof must not verify").to.be.false;
  });

  it("accepts a garbage proof when testingMode is on (why it must not be the default)", async function () {
    const v = await (await ethers.getContractFactory("ZKVerifierIntegrated")).deploy(true);
    const ok = await v.verifyWhitelistMembership.staticCall(
      [0, 0], [[0, 0], [0, 0]], [0, 0], [1]
    );
    expect(ok, "testingMode is a mock and must never be the production default").to.be.true;
  });

  it("the demo does not hardcode testingMode on", async function () {
    const src = require("fs").readFileSync("demo/modules/PrivacyModule.js", "utf8");
    const m = src.match(/ZKVerifierIntegratedFactory\.deploy\(([^)]*)\)/);
    expect(m, "ZKVerifierIntegrated deployment not found").to.not.be.null;
    expect(m![1].trim(), "must not be a hardcoded true").to.not.equal("true");
  });

  it("the demo labels mock mode honestly", async function () {
    const src = require("fs").readFileSync("demo/modules/PrivacyModule.js", "utf8");
    // The old log said "Real ZK Verifiers" while deploying the mock. Whatever
    // the wording, it must be derived from the flag, not asserted blindly.
    const claimsRealUnconditionally =
      /Real ZK Verifiers/.test(src) && !/testingMode|zkTestingMode|MOCK/i.test(src);
    expect(claimsRealUnconditionally, "log must reflect the actual mode").to.be.false;
  });
});
