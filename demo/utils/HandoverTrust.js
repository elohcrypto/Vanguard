/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13 (B G-4, G-10; A1 M2):
 * who may be a ComplianceRules trusted contract, and what a registrar is.
 *
 * A trusted contract skips its own identity, whitelist and cap checks on
 * its token forever, so every live (token, account) pair must be one of:
 * governance on VGT (D21); a wallet a LIVE registrar of that token
 * created (an EscrowWalletCreated / MultiSigWalletCreated event on the
 * registrar, and the account's code hash is the hash the registrar may
 * trust); or an account the config acknowledges in `extraTrusted`
 * (empty on a first handover). Anything else is refused before step 1
 * and fails completion (R-413-4). Every live registrar, and every
 * InvestorTypeRegistry officer that is a contract, must carry the
 * compiled InvestorRequestManager or EscrowWalletFactory code
 * (immutables masked) and point at the plan: an InvestorRequestManager's
 * immutable bank must be ops (A1 M2), its token VSC, its registries the
 * plan's. Ownership of those contracts is HandoverRegistrars.js.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { uniq, scanLogs, liveTrustedContracts } = require("./HandoverScans");
const { liveRegistrars } = require("./HandoverRegistrars");
const { liveOfficers } = require("./HandoverRoles");
const { pinChecks } = require("./HandoverCodeHash");

const CREATED = {
  MultiSigEscrowWallet: ["EscrowWalletFactory", "EscrowWalletCreated"],
  MultiSigWallet: ["InvestorRequestManager", "MultiSigWalletCreated"],
};
const IRM_ABI = [
  "function bank() view returns (address)",
  "function token() view returns (address)",
  "function investorRegistry() view returns (address)",
  "function identityRegistry() view returns (address)",
];

/** Wallets `registrar` (trusting `wallet` code) created, from its events. */
async function registrarWallets(registrar, wallet, o) {
  const [artifact, event] = CREATED[wallet] || [];
  if (!artifact) return [];
  const c = await ethers.getContractAt(artifact, registrar);
  const evs = await scanLogs(c, c.filters[event](), o);
  return uniq(evs.map((ev) => ev.args[1]));
}

/**
 * { trusted, registrars, created: { registrar: [wallets] }, custody:
 * [{ addr, kind }] } where custody lists every registrar and every
 * officer contract with the artifact its code matches (null: neither).
 */
async function trustFacts(o) {
  const registrars = await liveRegistrars(o);
  const created = {};
  for (const r of registrars) {
    created[r.registrar] = await registrarWallets(r.registrar, r.wallet, o);
  }
  const custody = registrars.map((r) => r.registrar);
  const reg = o.investorTypeRegistry;
  if (reg) {
    for (const a of await liveOfficers(reg, o)) {
      if ((await ethers.provider.getCode(a)) !== "0x") custody.push(a);
    }
  }
  const kinds = [];
  for (const addr of uniq(custody)) {
    let kind = null;
    for (const name of ["InvestorRequestManager", "EscrowWalletFactory"]) {
      const [pin] = await pinChecks([{ label: name, addr, name }]);
      if (pin.ok) kind = name;
    }
    kinds.push({ addr, kind });
  }
  return {
    trusted: await liveTrustedContracts(o),
    registrars,
    created,
    custody: kinds,
  };
}

/**
 * [{ label, ok, fix, strays }] for the trusted contracts, the registrar
 * and officer-contract code, and the InvestorRequestManager immutables.
 */
async function trustChecks(o, f = null) {
  f = f || (await trustFacts(o));
  const [vsc, vgt, govAddr, ops, reg] = await Promise.all(
    [o.token, o.governanceToken, o.governance, o.ops, o.identityRegistry].map(
      addrOf,
    ),
  );
  const itr = o.investorTypeRegistry
    ? await addrOf(o.investorTypeRegistry)
    : null;
  const ack = await Promise.all((o.extraTrusted || []).map(addrOf));
  const out = [];
  const strays = [];
  for (const { token, account } of f.trusted) {
    if (same(token, vgt) && same(account, govAddr)) continue;
    if (ack.some((a) => same(a, account))) continue;
    let byRegistrar = false;
    for (const r of f.registrars) {
      if (!same(r.token, token)) continue;
      if (!f.created[r.registrar].some((w) => same(w, account))) continue;
      const code = ethers.keccak256(await ethers.provider.getCode(account));
      if (code === r.hash) byRegistrar = true;
    }
    if (!byRegistrar) strays.push({ token, account });
  }
  out.push({
    label: `every trusted contract is governance on VGT, a wallet a live registrar created, or acknowledged (${f.trusted.length} live, ${ack.length} acknowledged)`,
    ok: strays.length === 0,
    fix: `trusted contract(s) ${strays.map((s) => `${s.account} on ${same(s.token, vsc) ? "VSC" : same(s.token, vgt) ? "VGT" : s.token}`).join(", ")} were not created by a live registrar and are not acknowledged in extraTrusted: a trusted contract skips every identity, whitelist and cap check on its token; the ComplianceRules owner must removeTrustedContract(token, account) first, or the config must acknowledge each in "extraTrusted"`,
    strays: strays.map((s) => ({
      what: `ComplianceRules trusted contract ${s.account} on ${s.token}`,
      on: o.complianceRules,
      fn: "removeTrustedContract",
      args: [s.token, s.account],
    })),
  });
  for (const { addr, kind } of f.custody) {
    out.push({
      label: `registrar / officer contract ${addr} code matches the compiled ${kind || "InvestorRequestManager or EscrowWalletFactory"}`,
      ok: Boolean(kind),
      fix: `${addr} is a ComplianceRules registrar or InvestorTypeRegistry officer whose runtime code is neither the compiled InvestorRequestManager nor EscrowWalletFactory: it could trust or type any account; clear it (setTrustedRegistrar(token, registrar, 0) / setComplianceOfficer(it, false)) before the handover`,
      strays: [],
    });
    if (kind !== "InvestorRequestManager") continue;
    const m = await ethers.getContractAt(IRM_ABI, addr);
    const links = [
      [
        "bank",
        await m.bank(),
        ops,
        "ops (A1 M2: the bank co-signs every custody wallet and approves investor types)",
      ],
      ["token", await m.token(), vsc, "VSC"],
      [
        "investorRegistry",
        await m.investorRegistry(),
        itr,
        "the plan InvestorTypeRegistry",
      ],
      [
        "identityRegistry",
        await m.identityRegistry(),
        reg,
        "the plan IdentityRegistry",
      ],
    ];
    for (const [name, got, want, what] of links) {
      const ok = Boolean(want) && same(got, want);
      out.push({
        label: `InvestorRequestManager ${addr} ${name}() is ${what}: ${want}`,
        ok,
        fix: `InvestorRequestManager ${addr} ${name}() is ${got}, not ${what} (${want}); it is immutable: redeploy the manager, clear its registrar and officer roles, and recreate its wallets`,
        strays: [],
      });
    }
  }
  return out;
}

/** Read-only, before the first transaction: refuse the first finding. */
async function preflightTrust(o) {
  for (const c of await trustChecks(o)) if (!c.ok) fail(c.fix);
}

/** Completion lines: [label, pass][]. */
async function trustLines(o) {
  return (await trustChecks(o)).map((c) => [c.label, c.ok]);
}

/** The strays a ComplianceRules owner call removes. */
async function trustStrays(o) {
  const out = [];
  for (const c of await trustChecks(o)) out.push(...c.strays);
  return out;
}

module.exports = {
  registrarWallets,
  trustFacts,
  trustChecks,
  preflightTrust,
  trustLines,
  trustStrays,
};
