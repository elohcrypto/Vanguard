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
const { same, fail } = require("./HandoverChecks");
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
async function liveRegistrars(o) {
  const rules = o.complianceRules;
  if (!rules) return [];
  const known = await compiledWallets();
  const events = await scanLogs(rules, rules.filters.TrustedRegistrarSet(), o);
  const out = [];
  for (const ev of events) {
    const [token, registrar] = [ev.args[0], ev.args[1]];
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

module.exports = { liveRegistrars, preflightRegistrars, registrarLines };
