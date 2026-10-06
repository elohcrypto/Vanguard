/**
 * Privacy options of the demo against the chain (plan v2 Task 4.7 and its
 * review fixes M1, M3, L3), a leg of scripts/demo-smoke-privacy.js, run
 * after its 42 -> 1 flow and 42 -> 3 attestation:
 *   - option 49 before and after 42 -> 6: each of the eight checks equals
 *     an independent chain read (true, false or not run), and the "ALL
 *     EIGHT" line prints exactly when all eight hold;
 *   - option 42 -> 6 for carol: the four records hold on chain, the banner
 *     names VSC's real whitelist mode, and "GATING" never prints;
 *   - option 42 -> 1 in secure mode: no "PASSED", no "production", and the
 *     verification line equals IdentityRegistry.isVerified.
 */

const { ethers } = require("hardhat");
const { CIRCUITS } = require("./zk/attest");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const MODES = ["OracleOnly", "ZkOnly", "Either"];
const CAROL = 8;

/** Run `fn` with console.log captured; returns [result, lines]. */
async function captured(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return [await fn(), lines];
  } finally {
    console.log = real;
  }
}

function privacyModule(state, answers = []) {
  const PrivacyModule = require("../demo/modules/PrivacyModule");
  const ProofGenerator = require("../demo/utils/ProofGenerator");
  const queue = [...answers];
  return new PrivacyModule(
    state,
    null,
    async () => (queue.length ? queue.shift() : ""),
    new ProofGenerator(state),
  );
}

/** The eight answers option 49 must give, read independently. */
async function expectedChecks(state) {
  const zk = state.getContract("zkVerifierIntegrated");
  const pm = state.getContract("privacyManager");
  const vsc = await state.getContract("digitalToken").getAddress();
  const v = await zk.getVerifierAddresses();
  let five = true;
  for (const a of [...v, await zk.blacklistVerifier()])
    if ((await ethers.provider.getCode(a)) === "0x") five = false;
  let bound = 0;
  let live = 0;
  let mapped = true;
  for (const s of state.signers) {
    const b = await pm.whitelistBindings(s.address);
    if (b.version === 0n) continue;
    bound++;
    if (await pm.hasValidWhitelistProof(s.address)) live++;
    if (!same(await pm.nullifierWallet(b.version, b.nullifier), s.address))
      mapped = false;
  }
  let records = true;
  for (const c of ["jurisdiction", "accreditation", "compliance"]) {
    let any = false;
    for (const s of state.signers)
      if ((await pm.getUserProofInfo(s.address, CIRCUITS[c].id)).isValid)
        any = true;
    if (!any) records = false;
  }
  const expiry = await zk.proofCacheExpiry();
  return [
    !(await zk.testingMode()),
    five,
    same(await pm.zkVerifier(), await zk.getAddress()),
    same(
      await state.getContract("complianceRules").privacyManager(vsc),
      await pm.getAddress(),
    ),
    live ? true : bound ? false : null,
    records ? true : null,
    expiry >= 3600n && expiry <= 7n * 86400n,
    bound ? mapped : null,
  ];
}

async function option49(state, failures, label) {
  const [checks, lines] = await captured(() =>
    privacyModule(state).testIntegration(),
  );
  if (!checks || checks.length !== 8) {
    failures.push(`option 49 (${label}) returned ${checks?.length} checks`);
    return;
  }
  const want = await expectedChecks(state);
  want.forEach((w, i) => {
    if (checks[i].ok !== w)
      failures.push(
        `option 49 (${label}) check ${i + 1} (${checks[i].name}) = ${checks[i].ok}, chain says ${w}`,
      );
  });
  const all = checks.every((c) => c.ok === true);
  if (all !== lines.some((l) => /ALL EIGHT PRIVACY CHECKS HOLD/.test(l)))
    failures.push(`option 49 (${label}) success line disagrees (all ${all})`);
  if (lines.some((l) => /PASSED|production/i.test(l)))
    failures.push(`option 49 (${label}) prints PASSED / production`);
  const held = checks.filter((c) => c.ok === true).length;
  console.log(
    `   option 49 ${label}: 8 of 8 compared with the chain, ${held} hold`,
  );
}

async function option42to6(state, failures) {
  const { runAllProofs } = require("../demo/utils/PrivacyBatchFlow");
  const carol = state.signers[CAROL];
  const [res, lines] = await captured(() =>
    runAllProofs({ state, generator: state.realProofGenerator, user: carol }),
  );
  const pm = state.getContract("privacyManager");
  const chain = await pm.validateAllPrivateCompliance(carol.address);
  if (!res || chain.some((x) => !x))
    failures.push(`42 -> 6: validateAllPrivateCompliance(carol) = ${chain}`);
  if (lines.some((l) => /GATING/.test(l)))
    failures.push('42 -> 6 prints "GATING"');
  const vsc = await state.getContract("digitalToken").getAddress();
  const mode =
    MODES[
      Number(await state.getContract("complianceRules").whitelistMode(vsc))
    ];
  if (
    !lines.some(
      (l) =>
        l.includes(`ALL FOUR PRIVATE RECORDS HOLD`) &&
        l.includes(`(now ${mode})`),
    )
  )
    failures.push(`42 -> 6 banner does not name VSC's mode ${mode}`);
  console.log(`   42 -> 6 for carol: four records hold, banner names ${mode}`);
}

async function option42to1Secure(state, failures) {
  // Security mode 3, default whitelist.
  const [, lines] = await captured(() =>
    privacyModule(state, ["3", "yes"]).submitWhitelistMembershipProof(),
  );
  if (lines.some((l) => /PASSED|production/i.test(l)))
    failures.push("42 -> 1 secure mode prints PASSED / production");
  const idReg = state.getContract("identityRegistry");
  const v = await idReg.isVerified(state.signers[1].address);
  if (!lines.some((l) => l.includes(`IdentityRegistry.isVerified: ${v}`)))
    failures.push(`42 -> 1 secure mode does not print isVerified ${v}`);
  console.log(`   42 -> 1 secure mode: isVerified ${v} printed as read`);
}

async function runPrivacyOptionsSmoke(state, failures) {
  const n0 = failures.length;
  await option49(state, failures, "before 42 -> 6");
  await option42to6(state, failures);
  await option49(state, failures, "after 42 -> 6");
  await option42to1Secure(state, failures);
  if (failures.length === n0)
    console.log("✅ Privacy options 42 -> 1, 42 -> 6, 49 match the chain.");
}

module.exports = { runPrivacyOptionsSmoke };
