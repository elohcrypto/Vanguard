/**
 * @fileoverview Handover ceremony, plan v2 Task 5.13 (Q11 = B): the calls
 * ops and the issuer admin make in the ceremony, as steps with an
 * on-chain effect (demo/utils/RoleCalls.js). A signer-held role sends
 * them in the full phase as before. For an external role (a multisig)
 * the full phase queues them; scripts/handover.ts writes the batch files
 * after the snapshot and stops before any vote; HANDOVER_PHASE=accept
 * rebuilds the steps from the snapshot (its digest guards them) and
 * proves every effect before the first vote:
 *   - list oracle: ops acceptOwnership; owner ops, no pending owner;
 *   - issuer: issuer admin acceptOwnership; owner admin, no pending owner;
 *   - issuer: issuer admin revokeIssuerKey(deployer key); the deployer's
 *     key not live, the admin's MANAGEMENT_KEY live.
 * Anything else the multisig did on these contracts that the ceremony can
 * see is refused there or at completion (an issuer key added in the
 * voting window, an oracle moved on; HandoverRoleCalls.test.ts).
 */

const fs = require("fs");
const { ethers } = require("hardhat");
const { addrOf, same, keyOf, hasLiveKey } = require("./HandoverChecks");
const { acceptStatus, compiledName, callOf } = require("./RoleCalls");

const MANAGEMENT_KEY = 1;
const ORACLE_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
];

/** List oracle: ops accepts the ownership the deployer nominated it for. */
async function oracleAccept(o, oracle) {
  const [dAddr, ops, a] = await Promise.all(
    [o.deployer, o.ops, oracle].map(addrOf),
  );
  return {
    kind: "oracleAccept",
    id: "handover.oracle.accept",
    role: o.ops,
    roleLabel: "ops",
    contract: oracle,
    name: await compiledName(
      a,
      ["WhitelistOracle", "BlacklistOracle"],
      "list oracle",
    ),
    fn: "acceptOwnership",
    args: [],
    purpose:
      "ops takes the list oracle the deployer nominated it for (step 2; Ownable2Step)",
    status: () => acceptStatus(oracle, dAddr, ops, "ops"),
  };
}

/** Issuer: the issuer admin accepts the ownership it was nominated for. */
async function issuerAccept(o, issuer) {
  const [dAddr, admin, a] = await Promise.all(
    [o.deployer, o.issuerAdmin, issuer].map(addrOf),
  );
  return {
    kind: "issuerAccept",
    id: "handover.issuer.accept",
    role: o.issuerAdmin,
    roleLabel: "issuerAdmin",
    contract: issuer,
    name: await compiledName(a, ["ClaimIssuer"], "issuer"),
    fn: "acceptOwnership",
    args: [],
    purpose:
      "the issuer admin takes the trusted issuer the deployer nominated it for (step 1; D25 b)",
    status: () => acceptStatus(issuer, dAddr, admin, "the issuer admin"),
  };
}

/** Issuer: the issuer admin revokes the deployer's key. */
async function issuerRevoke(o, issuer) {
  const [dAddr, admin, a] = await Promise.all(
    [o.deployer, o.issuerAdmin, issuer].map(addrOf),
  );
  return {
    kind: "issuerRevoke",
    id: "handover.issuer.revoke",
    role: o.issuerAdmin,
    roleLabel: "issuerAdmin",
    contract: issuer,
    name: await compiledName(a, ["ClaimIssuer"], "issuer"),
    fn: "revokeIssuerKey",
    args: [keyOf(dAddr)],
    purpose: `the issuer admin revokes the deployer's key (${dAddr}) after taking the issuer (step 1)`,
    status: async () => {
      const k = await issuer.issuerKeys(keyOf(admin));
      if (Number(k.purpose) !== MANAGEMENT_KEY || k.revoked)
        return "the issuer admin's MANAGEMENT_KEY is not live: another key was revoked";
      return (await hasLiveKey(issuer, dAddr)) ? "pending" : "done";
    },
  };
}

const BUILD = { oracleAccept, issuerAccept, issuerRevoke };

/** Queue `step`'s call for the snapshot and the batch file. */
async function queueRoleCall(ctx, step) {
  ctx.report.roleCalls.push({ kind: step.kind, to: (await callOf(step)).to });
  ctx.log(
    `   ⏸️  ${step.roleLabel} is external: ${step.name} ${await addrOf(step.contract)}.${step.fn} exported for its owners`,
  );
}

/** The steps a snapshot's roleCalls name, rebuilt from chain addresses. */
async function stepsFromSnapshot(o, entries = []) {
  const steps = [];
  for (const e of entries) {
    if (!BUILD[e.kind])
      throw new Error(`snapshot: unknown role call ${e.kind}`);
    const c = await (e.kind === "oracleAccept"
      ? ethers.getContractAt(ORACLE_ABI, e.to)
      : ethers.getContractAt("ClaimIssuer", e.to));
    steps.push(await BUILD[e.kind](o, c));
  }
  return steps;
}

/**
 * The full phase on a run that paused for role calls (Task 5.13): its
 * deployer steps are done, so a re-run would send them again. Refused
 * before any send; the resume is HANDOVER_PHASE=accept.
 */
function refuseFullRerun(snapshotPath, governance) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  } catch {
    return; // no (readable) snapshot: a first run
  }
  const calls = prev?.snapshot?.roleCalls;
  if (!calls?.length || !same(String(prev.governance), governance)) return;
  throw new Error(
    `${snapshotPath}: the full phase already ran the deployer's steps and paused for ${calls.length} role transaction(s); a full re-run would send them again. Execute the batch files, then run HANDOVER_PHASE=accept`,
  );
}

module.exports = {
  refuseFullRerun,
  oracleAccept,
  issuerAccept,
  issuerRevoke,
  queueRoleCall,
  stepsFromSnapshot,
};
