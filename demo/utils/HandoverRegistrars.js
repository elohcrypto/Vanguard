/**
 * @fileoverview Handover ceremony, plan v2 Task 4.3: ComplianceRules
 * trusted-contract registrars.
 *
 * A registrar (InvestorRequestManager, EscrowWalletFactory) may trust, on
 * its token, any account whose runtime code hash is the one the owner
 * registered for it; the trusted path then skips that account's identity,
 * whitelist and caps (Phase 3 review invariant 7). So the ceremony lists
 * every live registrar with its code hash, from the TrustedRegistrarSet
 * events, and refuses in preflight a registrar without code or one whose
 * hash is not the compiled MultiSigWallet or MultiSigEscrowWallet (the same
 * pattern as the KeyManager and privacy pins).
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");
const { expectedHash } = require("./HandoverCodeHash");

const WALLETS = ["MultiSigWallet", "MultiSigEscrowWallet"];

/** { hash: artifact name } for the wallets a registrar may trust. */
async function compiledWallets() {
  const out = {};
  for (const name of WALLETS) out[await expectedHash(name)] = name;
  return out;
}

/**
 * Every live (token, registrar) with its registered code hash, the
 * compiled wallet it matches (null: none) and whether it has code.
 */
async function liveRegistrars(o, candidates = []) {
  const rules = o.complianceRules;
  // A ceremony without ComplianceRules is a config error (review N1).
  if (!rules) fail("no ComplianceRules in the handover config");
  const known = await compiledWallets();
  const events = await scanLogs(rules, rules.filters.TrustedRegistrarSet(), o);
  // R-413-6 (M-3): `candidates` (the derived escrow factory, every officer
  // contract, every trusted contract's factory()) are read directly on
  // VSC and VGT; a live registrar found only that way proves the scan
  // missed it, and the ceremony refuses rather than trusting the scan.
  const hits = events.map((ev) => [ev.args[0], ev.args[1]]);
  const pairs = [...hits];
  for (const c of candidates) {
    for (const t of [o.token, o.governanceToken]) {
      if (t && c) pairs.push([await addrOf(t), await addrOf(c)]);
    }
  }
  const out = [];
  for (const [token, registrar] of pairs) {
    if (out.some((x) => same(x.token, token) && same(x.registrar, registrar)))
      continue;
    const hash = await rules.trustedRegistrars(token, registrar);
    if (hash === ethers.ZeroHash) continue;
    out.push({
      token: ethers.getAddress(token),
      registrar: ethers.getAddress(registrar),
      hash,
      wallet: known[hash] || null,
      hasCode: (await ethers.provider.getCode(registrar)) !== "0x",
    });
  }
  const missed = out.filter(
    (r) => !hits.some(([t, a]) => same(t, r.token) && same(a, r.registrar)),
  );
  if (missed.length) {
    fail(
      `ComplianceRules TrustedRegistrarSet event scan found none of the holders it must see (${missed.map((r) => `${r.registrar} on ${r.token}`).join(", ")}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  return out;
}

/** Read-only, before the first transaction. */
async function preflightRegistrars(o) {
  for (const r of await liveRegistrars(o)) {
    if (!r.hasCode) {
      fail(
        `ComplianceRules registrar ${r.registrar} on token ${r.token} has no code: clear it with setTrustedRegistrar(token, registrar, 0) before the handover`,
      );
    }
    if (!r.wallet) {
      fail(
        `ComplianceRules registrar ${r.registrar} on token ${r.token} may trust code hash ${r.hash}, which is not the compiled MultiSigWallet or MultiSigEscrowWallet: clear it, or register the compiled hash, before the handover`,
      );
    }
  }
}

/** Completion lines: [label, pass][], one per live registrar. */
async function registrarLines(o) {
  return (await liveRegistrars(o)).map((r) => [
    `ComplianceRules registrar ${r.registrar} on token ${r.token} trusts only code hash ${r.hash}${r.wallet ? ` (the compiled ${r.wallet})` : " (NOT a compiled wallet)"}`,
    r.hasCode && Boolean(r.wallet),
  ]);
}

/**
 * Review L1: the contracts holding trust or type power, every live
 * registrar and every live InvestorTypeRegistry compliance officer that is
 * a contract (governance itself excepted), must be owned by ops or
 * governance: a deployer-owned InvestorRequestManager would let the
 * deployer assign investor types and create trusted wallets after the
 * handover. One line; it names each offender.
 */
async function custodyOwnerLines(o, dAddr, ops, govAddr) {
  const owned = [];
  for (const r of await liveRegistrars(o)) owned.push(r.registrar);
  const reg = o.investorTypeRegistry;
  if (reg) {
    const evs = await scanLogs(reg, reg.filters.ComplianceOfficerUpdated(), o);
    for (const ev of evs) {
      const a = ev.args[0];
      if (same(a, govAddr) || owned.some((x) => same(x, a))) continue;
      if ((await ethers.provider.getCode(a)) === "0x") continue;
      if (await reg.isComplianceOfficer(a)) owned.push(ethers.getAddress(a));
    }
  }
  const bad = [];
  for (const a of owned) {
    const c = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      a,
    );
    const owner = await c.owner().catch(() => null);
    if (!owner || !(same(owner, ops) || same(owner, govAddr)))
      bad.push(`${a} (owner ${owner ?? "unreadable"})`);
    // Task 5.1 (Q7): a pending nominee other than ops or governance could
    // take the contract after the handover (no pendingOwner: one-step).
    const pending = await (
      await ethers.getContractAt(
        ["function pendingOwner() view returns (address)"],
        a,
      )
    )
      .pendingOwner()
      .catch(() => ethers.ZeroAddress);
    if (![ethers.ZeroAddress, ops, govAddr].some((x) => same(pending, x)))
      bad.push(`${a} (pending owner ${pending})`);
  }
  return [
    [
      bad.length
        ? `registrar / compliance-officer contracts not owned by ops or governance: ${bad.join(", ")}`
        : `every ComplianceRules registrar and compliance-officer contract (${owned.length}) is owned by ops or governance, not the deployer ${dAddr}`,
      bad.length === 0,
    ],
  ];
}

module.exports = {
  liveRegistrars,
  preflightRegistrars,
  registrarLines,
  custodyOwnerLines,
};
