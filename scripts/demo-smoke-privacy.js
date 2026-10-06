/**
 * Privacy section of scripts/demo-smoke.js (plan v2 Task 3.6): the privacy
 * pair option 1 deploys, wired by option 21, and the ZK allow list on the
 * live VSC, driven through the same code as demo option 42 -> 1
 * (demo/utils/WhitelistBinderFlow.js, demo/utils/WhitelistLiveFlow.js) and
 * the scripts/zk library, and one attestation proof (Task 3.7b) through the
 * code of option 42 -> 3 (demo/utils/AttestationFlow.js). Every assertion
 * reads the chain.
 *
 * checkPrivacyWiring runs right after the deploy; runPrivacySmoke after the
 * escrow smoke and before the handover, which hands the pair to governance.
 */

const { ethers } = require("hardhat");
const ProofGenerator = require("../demo/utils/ProofGenerator");
const {
  demoWhitelist,
  proveForDemoUser,
  publishAndBind,
} = require("../demo/utils/WhitelistBinderFlow");
const { runLiveWhitelistFlow } = require("../demo/utils/WhitelistLiveFlow");
const {
  DEFAULT_MINIMUM_ACCREDITATION,
  DEFAULT_COMPLIANCE,
  runAttestationFlow,
} = require("../demo/utils/AttestationFlow");
const { CIRCUITS } = require("./zk/attest");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const ALICE = 6; // the wallets demo-smoke.js onboarded for the vote (6-8)
const BOB = 7;
const CAROL = 8;

/** Option 1 deployed the pair, option 21 wired it, the mode is unchanged. */
async function checkPrivacyWiring(state, failures) {
  const rules = state.getContract("complianceRules");
  const token = state.getContract("digitalToken");
  const pm = state.getContract("privacyManager");
  const zk = state.getContract("zkVerifierIntegrated");
  if (!pm || !zk) {
    failures.push(
      "3.6: option 1 did not deploy PrivacyManager and its verifier",
    );
    return;
  }
  const vsc = await token.getAddress();
  const pmAddr = await pm.getAddress();
  const wired = await rules.privacyManager(vsc);
  if (!same(wired, pmAddr)) {
    failures.push(
      `3.6: rules.privacyManager(VSC) = ${wired}, expected ${pmAddr}`,
    );
  }
  const mode = Number(await rules.whitelistMode(vsc));
  if (mode !== 0) {
    failures.push(
      `3.6: whitelistMode(VSC) = ${mode} after deploy, expected 0 (OracleOnly)`,
    );
  }
  if (await zk.testingMode()) {
    failures.push("3.6: the demo deployed a testingMode verifier");
  }
  if (!same(await pm.zkVerifier(), await zk.getAddress())) {
    failures.push("3.6: PrivacyManager does not use the deployed verifier");
  }
  if (state.getContract("zkVerifier") !== zk) {
    failures.push(
      "3.6: state key zkVerifier is not the zkVerifierIntegrated alias",
    );
  }
  // Task 3.7b: option 1 trusts the demo issuer key and sets the policies.
  for (const [name, c] of Object.entries(CIRCUITS)) {
    if ((await pm.trustedAttestorCount(c.id)) < 1n) {
      failures.push(`3.7b: no trusted attestor for ${name} after deploy`);
    }
  }
  if ((await pm.minimumAccreditation()) !== DEFAULT_MINIMUM_ACCREDITATION) {
    failures.push("3.7b: minimumAccreditation is not the demo default");
  }
  const comp = (await pm.currentPolicy(CIRCUITS.compliance.id)).map(BigInt);
  if (comp.join() !== DEFAULT_COMPLIANCE.join()) {
    failures.push(`3.7b: compliance policy is [${comp}], not the demo default`);
  }
  // Task 3.8: one jurisdiction source. Option 21 points PrivacyManager at
  // ComplianceRules' rule for VSC and gives every allowed code a bit, in
  // the rule's order, so the mask is all of them.
  if (!same(await pm.complianceRules(), await rules.getAddress())) {
    failures.push("3.8: PrivacyManager.complianceRules() is not the demo's");
  }
  if (!same(await pm.policyToken(), vsc)) {
    failures.push("3.8: PrivacyManager.policyToken() is not VSC");
  }
  const [, allowed] = await rules.getJurisdictionRule(vsc);
  const [codes, bits] = await pm.getActiveJurisdictions();
  const n = BigInt(allowed.length);
  if (
    n === 0n ||
    codes.map(String).join() !== allowed.map(String).join() ||
    (await pm.allowedJurisdictionMask()) !== (1n << n) - 1n
  ) {
    failures.push(
      `3.8: active jurisdictions [${codes}] (bits [${bits}]) are not VSC's allow list [${allowed}]`,
    );
  }
  if ((await pm.jurisdictionBit(840)) !== 1n) {
    failures.push("3.8: US (840) does not hold bit 1");
  }
}

/**
 * snarkjs keeps its bn128 curve (worker threads) alive after a proof, which
 * keeps the smoke's process from exiting; end it once the proofs are done.
 */
async function releaseProver() {
  const ff = require(
    require.resolve("ffjavascript", { paths: [require.resolve("snarkjs")] }),
  );
  await (await ff.buildBn128()).terminate();
}

/** Steps (a) to (e) of option 42 -> 1 on VSC, then the chain read back. */
async function runPrivacySmoke(state, failures) {
  try {
    await privacyFlow(state, failures);
  } finally {
    await releaseProver();
  }
}

async function privacyFlow(state, failures) {
  const s = state.signers;
  const [alice, bob, carol] = [ALICE, BOB, CAROL].map((i) => s[i]);
  const token = state.getContract("digitalToken");
  const rules = state.getContract("complianceRules");
  const pm = state.getContract("privacyManager");
  const vsc = await token.getAddress();
  const amount = ethers.parseEther("10");

  await new ProofGenerator(state).initializeRealProofGenerator();
  // Onboarding as in option 42 -> 1: alice and bob hand in commitments,
  // the owner publishes the root, alice proves and binds her wallet.
  const listed = [alice, bob];
  const { rootFile } = await demoWhitelist(state, listed);
  const calldata = await proveForDemoUser(state, alice, rootFile);
  await publishAndBind({
    state,
    privacyManager: pm,
    user: alice,
    proof: calldata.proof,
    signals: calldata.signals,
  });

  const bobBefore = await token.balanceOf(bob.address);
  const failed = failures.length;
  const fail = (m) => failures.push(`3.6: ${m}`);
  // (d) read from chain in that state: the recipient re-bound under the
  // rotated root, the sender did not, so only the sender is refused.
  const onRotated = async () => {
    if (!(await pm.hasValidWhitelistProof(bob.address)))
      fail("(d) the kept recipient is not bound under the rotated root");
    if (await pm.hasValidWhitelistProof(alice.address))
      fail("(d) the removed sender is still bound");
    if (await token.canTransfer(alice.address, bob.address, amount))
      fail("(d) canTransfer(alice -> bob) is true after the rotation");
  };
  const lines = [];
  let r = null;
  try {
    r = await runLiveWhitelistFlow({
      state,
      sender: alice,
      listed,
      rootFile,
      outsider: carol,
      amount,
      log: (...a) => lines.push(a.join(" ")),
      onRotated,
    });
  } catch (e) {
    failures.push(
      `3.6: live whitelist flow threw: ${e.message.split("\n")[0]}`,
    );
  }
  for (const l of lines) console.log(l);
  if (!r) {
    failures.push("3.6: live whitelist flow stopped on a precondition");
    return;
  }

  const mode = Number(await rules.whitelistMode(vsc));
  if (mode !== 2)
    fail(`whitelistMode(VSC) = ${mode} after the flow, expected 2 (Either)`);
  const moved = (await token.balanceOf(bob.address)) - bobBefore;
  if (!r.transferred)
    fail("(b) the bound wallet's transfer did not go through");
  if (moved !== 2n * amount) {
    fail(
      `bob received ${ethers.formatEther(moved)} VSC, expected ${ethers.formatEther(2n * amount)} (b + e)`,
    );
  }
  if (!r.outsiderRefused)
    fail("(c) an unbound verified wallet was not refused");
  if (await token.canTransfer(alice.address, carol.address, amount)) {
    fail("(c) canTransfer(alice -> carol, unbound) is true");
  }
  if (!r.rotatedRefused)
    fail("(d) after the rotation the bound wallet could still transfer");
  if (!r.senderRemoved)
    fail("(d) the rotated root still admits the sender (it could re-prove)");
  if (!r.reproved) fail("(e) after re-proving the transfer did not go through");
  if (!(await token.canTransfer(alice.address, bob.address, amount))) {
    fail("(e) canTransfer(alice -> bob) is false after re-proving");
  }
  for (const w of [alice, bob]) {
    if (!(await pm.hasValidWhitelistProof(w.address))) {
      fail(`hasValidWhitelistProof(${w.address}) is false after re-proving`);
    }
  }
  if (await pm.hasValidWhitelistProof(carol.address)) {
    fail("carol holds a binding she never proved");
  }
  if (failures.length > failed) return;
  console.log(
    `✅ Privacy smoke: VSC in Either, bound transfer, unbound refused, sender removed and refused, re-proof transfer (root version ${await pm.whitelistVersion()}).`,
  );
  await attestationSmoke(state, failures);
  await require("./demo-smoke-privacy-options").runPrivacyOptionsSmoke(
    state,
    failures,
  );
}

/** Option 42 -> 3 for bob: the demo issuer attests US, bob proves and binds. */
async function attestationSmoke(state, failures) {
  const bob = state.signers[BOB];
  const pm = state.getContract("privacyManager");
  const lines = [];
  let r = null;
  try {
    r = await runAttestationFlow({
      state,
      generator: state.realProofGenerator,
      circuit: "jurisdiction",
      user: bob,
      attributes: { mask: await pm.jurisdictionBit(840) }, // US
      log: (...a) => lines.push(a.join(" ")),
    });
  } catch (e) {
    failures.push(`3.7b: attestation flow threw: ${e.message.split("\n")[0]}`);
  }
  for (const l of lines) console.log(l);
  if (!r) return;
  const id = CIRCUITS.jurisdiction.id;
  const rec = await pm.attestationRecords(bob.address, id);
  if (!r.valid || !(await pm.getUserProofInfo(bob.address, id)).isValid) {
    failures.push("3.7b: bob's jurisdiction record does not read valid");
    return;
  }
  if (rec.policyHash !== (await pm.currentPolicyHash(id))) {
    failures.push("3.7b: bob's record is not under the current policy");
    return;
  }
  // Task 3.10: signed for one year; the record never outlives it.
  const until = state.attestationExpiry?.[`jurisdiction:${bob.address}`];
  if (!until || rec.expiresAt > until) {
    failures.push("3.10: bob's record outlives the attestation's validUntil");
    return;
  }
  const iso = (t) => new Date(Number(t) * 1000).toISOString();
  console.log(
    `✅ Attestation smoke: jurisdiction record bound for ${bob.address} (nullifier ${rec.nullifier}); attestation valid until ${iso(until)}, record expires ${iso(rec.expiresAt)}.`,
  );
}

module.exports = { checkPrivacyWiring, runPrivacySmoke };
