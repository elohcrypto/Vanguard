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
  // M-3: every officer contract and every trusted contract's factory()
  // is a registrar candidate read directly, beside the escrow factory.
  const reg0 = o.investorTypeRegistry;
  const officerContracts = [];
  if (reg0) {
    for (const a of (await liveOfficers(reg0, o)).live) {
      if ((await ethers.provider.getCode(a)) !== "0x") officerContracts.push(a);
    }
  }
  const trusted = await liveTrustedContracts(o);
  const factories = [];
  for (const { account } of trusted) {
    const f = await ethers.getContractAt(
      ["function factory() view returns (address)"],
      account,
    );
    const a = await f.factory().catch(() => null);
    if (a && !same(a, ethers.ZeroAddress)) factories.push(a);
  }
  const registrars = await liveRegistrars(o, [
    o.escrowWalletFactory,
    ...officerContracts,
    ...factories,
  ]);
  const created = {};
  for (const r of registrars) {
    created[r.registrar] = await registrarWallets(r.registrar, r.wallet, o);
  }
  // Task 5.13 (review LOW-3): ops is the officer by the ceremony's step 1,
  // whatever its kind: no custody contract as an officer. It stays a
  // registrar candidate above, and a registrar ops is judged like any.
  const ops = await addrOf(o.ops);
  const custody = [
    ...registrars.map((r) => r.registrar),
    ...officerContracts.filter((a) => !same(a, ops)),
  ];
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
async function trustChecks(o, f = null, pre = false) {
  f = f || (await trustFacts(o));
  const [dAddr, planEscrow] = await Promise.all([
    addrOf(o.deployer),
    o.escrowWalletFactory ? addrOf(o.escrowWalletFactory) : null,
  ]);
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
    // M-2: ownership refused before step 1, not only at completion (the
    // completion line stays in HandoverRegistrars.custodyOwnerLines).
    const owner = await (
      await ethers.getContractAt(
        ["function owner() view returns (address)"],
        addr,
      )
    )
      .owner()
      .catch(() => null);
    // The plan's escrow factory is the deployer's until step 3 hands it over.
    const plan =
      pre &&
      planEscrow &&
      same(addr, planEscrow) &&
      owner &&
      same(owner, dAddr);
    out.push({
      label: `registrar / officer contract ${addr} is owned by ops or governance${pre ? " (the plan's escrow factory: the deployer, until step 3)" : ""}`,
      ok:
        Boolean(plan) ||
        (Boolean(owner) && (same(owner, ops) || same(owner, govAddr))),
      fix: `registrar / officer contract ${addr} is owned by ${owner ?? "nobody readable"}, neither ops nor governance: a deployer-owned InvestorRequestManager assigns investor types and creates trusted wallets after the handover; its owner must transferOwnership(ops) and ops acceptOwnership() first`,
      strays: [],
    });
    // Task 5.1 review L3: a nominee other than ops or governance could
    // accept after the handover. A contract without pendingOwner is
    // one-step: nothing pending. R-56c-9: a named line at completion
    // and in the day-2 audit too, as each list oracle has.
    const pending = await (
      await ethers.getContractAt(
        ["function pendingOwner() view returns (address)"],
        addr,
      )
    )
      .pendingOwner()
      .catch(() => ethers.ZeroAddress);
    out.push({
      label: `registrar / officer contract ${addr} has no pending owner other than ops or governance`,
      ok: [ethers.ZeroAddress, ops, govAddr].some((x) => same(pending, x)),
      fix: `registrar / officer contract ${addr} has pending owner ${pending}, neither ops nor governance: it could accept ownership after the handover; its owner must transferOwnership(${ethers.ZeroAddress}) to cancel the nomination first`,
      strays: [],
    });
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
  for (const c of await trustChecks(o, null, true)) if (!c.ok) fail(c.fix);
}

/** Completion lines: [label, pass][]; L-1: acknowledged accounts warn. */
async function trustLines(o, warnings = [], residual = []) {
  for (const a of o.extraTrusted || []) {
    const w = `trusted contract ${await addrOf(a)} is acknowledged in extraTrusted: it skips every identity, whitelist and cap check on its token by the operator's say-so, not a registrar's`;
    warnings.push(w);
    residual.push(w);
  }
  return (await trustChecks(o)).map((c) => [c.label, c.ok]);
}

/** The strays a ComplianceRules owner call removes. */
async function trustStrays(o) {
  const out = [];
  for (const c of await trustChecks(o, null, true)) out.push(...c.strays);
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
