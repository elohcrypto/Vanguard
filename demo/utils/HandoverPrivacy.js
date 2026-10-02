/**
 * @fileoverview Handover ceremony, plan v2 Task 3.3 (R-3R-3, R-3R-4): the
 * privacy contracts. PrivacyManager (type 11, PrivacyParameters) and
 * ZKVerifierIntegrated (type 12, VerifierParameters) are ACCEPTANCE_PLAN
 * entries with a bind setter, so HandoverPowers derives them from the bound
 * targets, refuses a bound-but-omitted one and binds both at step 3. This
 * file adds what is specific to them: the verifier PrivacyManager uses must
 * be the one the config names, a testingMode verifier is refused, ops
 * becomes the list operator, and the completion lines.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");

const check = (cond, msg) => cond || fail(msg);

/**
 * Read-only, before the first transaction. PrivacyManager's zkVerifier() is
 * the verifier that decides what a whitelist proof is worth: the config must
 * name it (else the deployer keeps updateVerifier), and no named verifier
 * may be a testingMode one (it accepts any proof with non-zero signals).
 */
async function preflightPrivacy(o) {
  const pm = o.privacyManager;
  const zk = o.zkVerifier;
  if (pm) {
    const used = await pm.zkVerifier();
    if (!(zk && same(await addrOf(zk), used))) {
      fail(
        `PrivacyManager ${await addrOf(pm)} uses ZKVerifierIntegrated ${used}, which the config does not name: set "zkVerifier" to it`,
      );
    }
  }
  if (zk && (await zk.testingMode())) {
    fail(
      `ZKVerifierIntegrated ${await addrOf(zk)} is in testingMode (accepts any proof with non-zero signals): redeploy it with testingMode=false before the handover`,
    );
  }
}

/**
 * Step 5 on PrivacyManager, while the deployer still owns it: ops publishes
 * whitelist roots from now on (governance can too, by a PrivacyParameters
 * vote).
 */
async function privacySteps({ o, d, ok }) {
  const pm = o.privacyManager;
  if (!pm) return;
  const ops = await addrOf(o.ops);
  if (!same(await pm.listOperator(), ops)) {
    await (await pm.connect(d).setListOperator(ops)).wait();
    check(
      same(await pm.listOperator(), ops),
      "PrivacyManager listOperator is not ops",
    );
  }
  ok(`PrivacyManager listOperator: ops ${ops}`);
}

/** Completion lines: [label, pass] for both privacy contracts. */
async function privacyLines(o, dAddr, ops, govAddr) {
  const lines = [];
  const pm = o.privacyManager;
  const pmAddr = pm ? await addrOf(pm) : o.derived?.factories?.privacyManager;
  if (pmAddr) {
    const c = await ethers.getContractAt("PrivacyManager", pmAddr);
    lines.push([
      "PrivacyManager listOperator is ops",
      same(await c.listOperator(), ops),
    ]);
    lines.push([
      "PrivacyManager pendingOwner is not the deployer",
      !same(await c.pendingOwner(), dAddr),
    ]);
    const used = await c.zkVerifier();
    const v = await ethers.getContractAt("ZKVerifierIntegrated", used);
    lines.push([
      `PrivacyManager's verifier ${used} owned by governance`,
      same(await v.owner(), govAddr),
    ]);
  }
  const zk = o.zkVerifier;
  const zkAddr = zk ? await addrOf(zk) : o.derived?.factories?.zkVerifier;
  if (zkAddr) {
    const v = await ethers.getContractAt("ZKVerifierIntegrated", zkAddr);
    lines.push([
      "ZKVerifierIntegrated pendingOwner is not the deployer",
      !same(await v.pendingOwner(), dAddr),
    ]);
    lines.push([
      "ZKVerifierIntegrated is not in testingMode",
      !(await v.testingMode()),
    ]);
  }
  return lines;
}

module.exports = { preflightPrivacy, privacySteps, privacyLines };
