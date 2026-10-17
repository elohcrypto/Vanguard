/**
 * @fileoverview The issuer admin's claim signers in the day-2 audit (plan
 * v2 Task 5.15, owner Q17 = A; readiness review M-2). A Safe issuer admin
 * cannot sign claims, so after the ceremony it adds EOA CLAIM_SIGNER keys
 * (scripts/production/claimSigners.ts). The completion requires every
 * live issuer key to be the issuer admin's; the audit also accepts a key
 * of an address the config lists in "claimSigners", and only when all of
 * these hold on the issuer that carries it:
 *  - it is a CLAIM_SIGNER key (purpose 3), never MANAGEMENT;
 *  - its latest IssuerKeyAdded comes after the IssuerKeyRevoked of the
 *    deployer's key (so the issuer admin added it after the ceremony; a
 *    key the deployer added, or any added before, still fails);
 *  - the address is no voter or proposer (the D25 b line beside it
 *    refuses the deployer, roles, governance, agents and nodes).
 * The ceremony's own completion accepts none. A listed address no trusted
 * issuer accepts this way is a failing line (a stale acknowledgement).
 */

const { addrOf, same, keyOf } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");

const CLAIM_SIGNER_KEY = 3;

/** Position of an event in the chain, comparable. */
const at = (e) => e.blockNumber * 1e6 + e.index;

/**
 * { accepted: Map(issuerAddr -> Set(keyHash)), lines: [[label, ok]] } for
 * o.claimSigners on the issuers of `f` (HandoverRoles.roleFacts). Empty
 * outside the audit.
 */
async function claimSignerFacts(o, f) {
  const accepted = new Map();
  const lines = [];
  const listed = o.audit ? o.claimSigners || [] : [];
  if (!listed.length) return { accepted, lines };
  const voters = await Promise.all((o.voterWallets || []).map(addrOf));
  const dKey = keyOf(f.dAddr);
  for (const s of listed) {
    const where = [];
    const k = keyOf(s);
    const isVoter = voters.some((v) => same(v, s));
    for (const i of f.issuers) {
      const live = i.keys.find(
        (x) => x.hash === k && x.purpose === CLAIM_SIGNER_KEY,
      );
      if (!live || isVoter) continue;
      const c = i.issuer;
      const [added] = (await scanLogs(c, c.filters.IssuerKeyAdded(k), o)).slice(
        -1,
      );
      const revoked = await scanLogs(c, c.filters.IssuerKeyRevoked(dKey), o);
      if (added && revoked.length && at(added) > at(revoked[0])) {
        const a = await addrOf(c);
        if (!accepted.has(a)) accepted.set(a, new Set());
        accepted.get(a).add(k);
        where.push(i.label);
      }
    }
    lines.push([
      where.length
        ? `claimSigners ${s}: a CLAIM_SIGNER key the issuer admin added after the ceremony on ${where.join(", ")}`
        : `claimSigners lists ${s}, which no trusted issuer holds as a CLAIM_SIGNER key added after the deployer's key was revoked${isVoter ? " (it is a voter)" : ""}: remove it from the config, or add the key by the issuer admin's batch (scripts/production/claimSigners.ts)`,
      where.length > 0,
    ]);
  }
  return { accepted, lines };
}

module.exports = { claimSignerFacts };
