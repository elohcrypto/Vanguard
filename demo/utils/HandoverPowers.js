/**
 * @fileoverview Handover ceremony, plan v2 Task 2F.5 (M4, L2; D25 b): the
 * deployer's power set derived from chain state rather than from the config,
 * the preflight checks built on it (the config covers it, separation of
 * duties, InvestorTypeRegistry side-governance), the factory and issuer
 * steps. The chunked log scan and the facts read from it are in
 * HandoverScans.js.
 */

const { ethers } = require("hardhat");
const {
  ACCEPTANCE_PLAN,
  addrOf,
  same,
  keyOf,
  hasLiveKey,
  issuerLabel,
  listManagerOf,
  fail,
} = require("./HandoverChecks");
const {
  uniq,
  scanLogs,
  checkFromBlock,
  preflightFactoryRoles,
  escrowFactoriesFromChain,
} = require("./HandoverScans");
const { wiredPrivacy } = require("./HandoverPrivacy");

const ZERO = ethers.ZeroAddress;
const MANAGEMENT_KEY = 1;
const CLAIM_SIGNER_KEY = 3;
const ECDSA_TYPE = 1;
const KEY_NAME = {
  [MANAGEMENT_KEY]: "MANAGEMENT",
  [CLAIM_SIGNER_KEY]: "CLAIM_SIGNER",
};
// Whitelist/Blacklist oracles have listManager() (ConsensusOracle is the
// manager's ownerless engine since 4.4 and is no oracle here).
const ORACLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address)",
  "function listManager() view returns (address)",
  "function setListManager(address)",
];
/** The plan entries governance binds at step 3 (factories, privacy contracts). */
const FACTORY_PLAN = ACCEPTANCE_PLAN.filter((e) => e.bind);

const check = (cond, msg) => cond || fail(msg);
const send = async (p) => (await p).wait();

/**
 * The contracts that hold power over holders, read from chain: oracles
 * bound in ComplianceRules for VSC and VGT, the registry's trusted issuers
 * per required topic, each oracle's listManager, the DynamicListManager
 * governance is bound to, the contracts bound to types 9-12 (factories,
 * PrivacyManager, ZKVerifierIntegrated; `bound`), the PrivacyManager
 * ComplianceRules wires (`privacy`, which `factories` takes when type 11 is
 * unbound), and the escrow factories that created trusted escrows (M-2).
 */
async function derivePowers(o) {
  const rules = o.complianceRules;
  const oracles = [];
  for (const t of [await addrOf(o.token), await addrOf(o.governanceToken)]) {
    oracles.push(
      await rules.whitelistOracle(t),
      await rules.blacklistOracle(t),
    );
  }
  const reg = o.identityRegistry;
  const issuers = [];
  for (const topic of await reg.getClaimTopics()) {
    issuers.push(...(await reg.getTrustedIssuersForClaimTopic(topic)));
  }
  const listManagers = [];
  for (const a of uniq(oracles)) {
    const lm = await listManagerOf(await ethers.getContractAt(ORACLE_ABI, a));
    if (lm && !same(lm, ZERO))
      listManagers.push({ oracle: a, listManager: lm });
  }
  const dlm = await o.governance.dynamicListManager();
  const bound = {};
  for (const e of FACTORY_PLAN) {
    const a = await o.governance.boundTarget(e.proposalType);
    bound[e.key] = same(a, ZERO) ? null : a;
  }
  // Task 3.4 (R-3R-15): or the one ComplianceRules wires, not yet bound.
  const privacy = await wiredPrivacy(o, bound.privacyManager);
  const factories = { ...bound, privacyManager: privacy.privacyManager };
  return {
    oracles: uniq(oracles),
    issuers: uniq(issuers),
    listManagers,
    dynamicListManager: same(dlm, ZERO) ? null : dlm,
    factories,
    bound,
    privacy,
    escrowFactories: await escrowFactoriesFromChain(o),
  };
}

/**
 * `o` with `oracles` and `issuers` covering the derived set, recorded as
 * `o.derived`. Strict (the ceremony): refuses, before any transaction, a
 * config whose arrays omit a derived contract, or that does not name a
 * DynamicListManager or factory governance is bound to; warns on extras. A
 * config without the arrays takes the derived set. Not strict (the
 * completion check): the union, so every derived contract is checked.
 */
async function withDerivedPowers(o, log = () => {}, { strict = true } = {}) {
  const d = await derivePowers(o);
  const out = { ...o, derived: d };
  const kinds = [
    ["oracles", ORACLE_ABI, "an oracle ComplianceRules binds to VSC or VGT"],
    ["issuers", "ClaimIssuer", "a trusted issuer of the IdentityRegistry"],
  ];
  for (const [key, abi, what] of kinds) {
    const given = o[key] || [];
    const addrs = await Promise.all(given.map(addrOf));
    const missing = d[key].filter((a) => !addrs.some((g) => same(g, a)));
    if (o[key] != null && strict && missing.length) {
      fail(
        `config "${key}" omits ${missing.join(", ")} (${what}): the deployer would keep it; list every one, or leave "${key}" out to use the set read from chain`,
      );
    }
    for (const g of addrs) {
      if (strict && !d[key].some((a) => same(a, g))) {
        log(
          `   ⚠️  ${key.slice(0, -1)} ${g} is not bound on chain; handed over anyway`,
        );
      }
    }
    const extra = await Promise.all(
      missing.map((a) => ethers.getContractAt(abi, a)),
    );
    out[key] = [...given, ...extra];
  }
  if (!strict) return out;
  if (d.privacy.conflict) fail(d.privacy.conflict);
  const named = [
    ["dynamicListManager", "DynamicListManager", d.dynamicListManager],
    ...FACTORY_PLAN.map((e) => [e.key, e.label, d.factories[e.key]]),
  ];
  for (const [key, label, bound] of named) {
    const given = o[key] && (await addrOf(o[key]));
    if (bound && !(given && same(given, bound))) {
      const why =
        (key === "privacyManager" && d.privacy.wiredBy) ||
        `governance is bound to ${label} ${bound}`;
      const names = given ? ` (it names ${given})` : "";
      fail(`${why}, which the config does not name${names}: add "${key}"`);
    }
  }
  // Review M-2: a null key cannot hide a factory a trusted escrow names.
  const escrowNamed =
    o.escrowWalletFactory && (await addrOf(o.escrowWalletFactory));
  for (const { factory, escrow } of d.escrowFactories) {
    if (escrowNamed && same(escrowNamed, factory)) continue;
    fail(
      `trusted escrow ${escrow} was created by EscrowWalletFactory ${factory}, which the config does not name: add "escrowWalletFactory"`,
    );
  }
  await checkFromBlock(o, log);
  return out;
}

/** Registry agents once step 5 ran: today's (from logs) minus the deployer, plus ops. */
async function registryAgentsAfter(o, dAddr, ops) {
  const reg = o.identityRegistry;
  const seen = uniq(
    (await scanLogs(reg, reg.filters.AgentAdded(), o)).map((ev) => ev.args[0]),
  );
  const live = [];
  for (const a of seen) if (await reg.isAgent(a)) live.push(a);
  return uniq([...live.filter((a) => !same(a, dAddr)), ops]);
}

/** "<agent> owns" (or similar) when a registry agent controls `issuer`; else null. */
async function agentRoleOn(issuer, agents) {
  const owner = await issuer.owner();
  const pending = await issuer.pendingOwner();
  for (const a of agents) {
    if (same(owner, a)) return `${a} owns`;
    if (same(pending, a)) return `${a} is the pending owner of`;
    const k = await issuer.issuerKeys(keyOf(a));
    const purpose = Number(k.purpose);
    if (k.key !== ethers.ZeroHash && !k.revoked && KEY_NAME[purpose]) {
      return `${a} holds a live ${KEY_NAME[purpose]} key on`;
    }
  }
  return null;
}

/** InvestorTypeRegistry governors today (from logs). */
async function registryGovernors(o, reg) {
  const seen = uniq(
    (await scanLogs(reg, reg.filters.GovernorUpdated(), o)).map(
      (ev) => ev.args[0],
    ),
  );
  const live = [];
  for (const g of seen) if (await reg.isGovernor(g)) live.push(g);
  return live;
}

/** Proposal ids of `reg` that could still execute. */
async function openRegistryProposals(reg) {
  const open = [];
  const n = Number(await reg.proposalCount());
  for (let i = 1; i <= n; i++) if (await reg.isProposalOpen(i)) open.push(i);
  return open;
}

/**
 * issuerAdmin (D25 b): required when the registry trusts any issuer, and a
 * key of its own. Runs before HandoverChecks.preflight; needs `o` from
 * withDerivedPowers.
 */
async function checkIssuerAdmin(o) {
  const issuers = o.issuers || [];
  const admin = o.issuerAdmin ? await addrOf(o.issuerAdmin) : null;
  if (issuers.length && !admin) {
    fail(
      `issuerAdmin is required: ${issuers.length} trusted issuer(s); configure a wallet that is not ops, the guardian, the deployer or governance (D25 b)`,
    );
  }
  if (!admin) return;
  for (const [name, who] of [
    ["deployer", o.deployer],
    ["ops", o.ops],
    ["guardian", o.guardian],
    ["governance", o.governance],
  ]) {
    if (same(admin, await addrOf(who))) {
      fail(
        `issuerAdmin ${admin} is the ${name}: separation of duties (D25 b) needs a separate issuer key`,
      );
    }
  }
}

/**
 * The rest of the 2F.5 preflight, read-only, after HandoverChecks.preflight:
 * oracle list managers, factory binding, separation of duties and the
 * registry's side-governance (L2). Needs `o` from withDerivedPowers.
 */
async function preflightPowers(o, { governanceOwned }) {
  const d = o.derived;
  const dAddr = await addrOf(o.deployer);
  const ops = await addrOf(o.ops);
  const govAddr = await addrOf(o.governance);
  const issuers = o.issuers || [];
  const admin = o.issuerAdmin ? await addrOf(o.issuerAdmin) : null;
  for (const { oracle, listManager } of d.listManagers) {
    if (same(listManager, dAddr)) continue; // step 2 moves it
    if (d.dynamicListManager && same(listManager, d.dynamicListManager))
      continue;
    fail(
      `oracle ${oracle} listManager is ${listManager}, not the DynamicListManager governance is bound to: whoever controls it writes lists outside governance; its owner must setListManager(DynamicListManager or 0) first`,
    );
  }
  for (const e of FACTORY_PLAN) {
    if (!o[e.key]) continue;
    const a = await addrOf(o[e.key]);
    if (same(d.bound[e.key] || ZERO, a)) continue;
    if (governanceOwned.has("governance")) {
      fail(
        `governance owns itself but is not bound to ${e.label} ${a}: nominate it, then bind it by a SystemParameters vote (${e.bind})`,
      );
    }
  }
  await preflightFactoryRoles(o, dAddr, ops, govAddr);
  // D25 (b): no key both registers identities and attests them.
  const agents = await registryAgentsAfter(o, dAddr, ops);
  for (const issuer of issuers) {
    const label = await issuerLabel(issuer);
    const role = await agentRoleOn(issuer, agents);
    if (role) {
      fail(
        `IdentityRegistry agent ${role} ${label}: one key would both register identities and attest them (D25 b); move the issuer role to issuerAdmin or remove the agent`,
      );
    }
    const handed =
      same(await issuer.owner(), dAddr) || (await hasLiveKey(issuer, dAddr));
    if (handed && agents.some((a) => same(a, admin))) {
      fail(
        `issuerAdmin ${admin} is an IdentityRegistry agent and would own ${label} (D25 b)`,
      );
    }
  }
  // L2: nothing planted in the registry's own proposal system survives.
  const reg = o.investorTypeRegistry;
  if (reg) {
    const open = await openRegistryProposals(reg);
    if (open.length) {
      fail(
        `InvestorTypeRegistry proposal(s) #${open.join(", #")} still open: its owner must cancelProposal them before the ceremony (L2)`,
      );
    }
    const others = (await registryGovernors(o, reg)).filter(
      (g) => !same(g, dAddr) && !same(g, govAddr),
    );
    if (others.length) {
      fail(
        `InvestorTypeRegistry governor(s) ${others.join(", ")} besides the deployer: its owner must setGovernor(g, false, 0) first (L2)`,
      );
    }
  }
}

async function hasLiveManagementKey(issuer, wallet) {
  const k = await issuer.issuerKeys(keyOf(wallet));
  return (
    k.key !== ethers.ZeroHash &&
    Number(k.purpose) === MANAGEMENT_KEY &&
    !k.revoked
  );
}

/**
 * Step 1 tail: every issuer the deployer holds goes to issuerAdmin (owner,
 * live MANAGEMENT_KEY), then the deployer's key is revoked. Never ops: ops
 * is a registry agent (D25 b).
 */
async function handOverIssuers({ o, d, dAddr, ok, log }) {
  for (const issuer of o.issuers || []) {
    const label = await issuerLabel(issuer);
    const isOwner = same(await issuer.owner(), dAddr);
    const hasKey = await hasLiveKey(issuer, dAddr);
    if (!isOwner && !hasKey) {
      log(`   ℹ️  deployer holds no key on ${label}: nothing to hand over`);
      continue;
    }
    const admin = await addrOf(o.issuerAdmin);
    if (!(await hasLiveManagementKey(issuer, admin))) {
      await send(
        issuer
          .connect(d)
          .addIssuerKey(keyOf(admin), MANAGEMENT_KEY, ECDSA_TYPE),
      );
    }
    // Ownership nominates then accepts, before the deployer key is revoked:
    // onlyManagementKey also admits the owner, so the owner is the
    // last-resort manager once issuerAdmin has accepted.
    await send(issuer.connect(d).transferOwnership(admin));
    check(
      same(await issuer.pendingOwner(), admin),
      `${label} pendingOwner is not issuerAdmin`,
    );
    await send(issuer.connect(o.issuerAdmin).acceptOwnership());
    check(
      same(await issuer.owner(), admin),
      `${label} owner is not issuerAdmin`,
    );
    check(
      await hasLiveManagementKey(issuer, admin),
      `issuerAdmin holds no live MANAGEMENT_KEY on ${label}; refusing to revoke the deployer key`,
    );
    if (hasKey)
      await send(issuer.connect(o.issuerAdmin).revokeIssuerKey(keyOf(dAddr)));
    check(
      !(await hasLiveKey(issuer, dAddr)),
      `deployer key still live on ${label}`,
    );
    ok(
      `${label}: owner issuerAdmin ${admin}, its MANAGEMENT_KEY live, deployer key revoked`,
    );
  }
}

/** Step 3 for a factory just nominated: bind its proposal type to it. */
async function bindFactory({ o, d, ok }, e) {
  const a = await addrOf(o[e.key]);
  if (same(await o.governance.boundTarget(e.proposalType), a)) return;
  await send(o.governance.connect(d)[e.bind](a));
  check(
    same(await o.governance.boundTarget(e.proposalType), a),
    `${e.label} is not bound to ${e.typeName}`,
  );
  ok(`${e.label}: bound to ${e.typeName} (governance.${e.bind})`);
}

/**
 * Step 5 on the factories: ops takes the escrow factory's ADMIN_ROLE
 * (investor management) and the deployer renounces it; DEFAULT_ADMIN_ROLE
 * follows ownership to governance at step 4. A factory not given is skipped
 * with a line.
 */
async function factorySteps({ o, d, dAddr, ok, log }) {
  for (const e of FACTORY_PLAN) {
    if (!o[e.key])
      log(
        `   ℹ️  ${e.label} not given: left out of this handover (not deployed)`,
      );
  }
  const f = o.escrowWalletFactory;
  if (!f) return;
  const ops = await addrOf(o.ops);
  const ADMIN = await f.ADMIN_ROLE();
  if (!(await f.hasRole(ADMIN, ops))) {
    if (await f.hasRole(await f.DEFAULT_ADMIN_ROLE(), dAddr)) {
      await send(f.connect(d).grantRole(ADMIN, ops));
      check(
        await f.hasRole(ADMIN, ops),
        "ops did not get EscrowWalletFactory ADMIN_ROLE",
      );
      ok(`EscrowWalletFactory ADMIN_ROLE: ops ${ops}`);
    } else {
      log(
        "   ⚠️  EscrowWalletFactory: governance must grant ops ADMIN_ROLE by an EscrowFactoryParameters vote",
      );
    }
  }
  if (await f.hasRole(ADMIN, dAddr)) {
    await send(f.connect(d).renounceRole(ADMIN, dAddr));
    check(
      !(await f.hasRole(ADMIN, dAddr)),
      "deployer still holds EscrowWalletFactory ADMIN_ROLE",
    );
    ok("deployer renounced EscrowWalletFactory ADMIN_ROLE");
  }
}

module.exports = {
  ORACLE_ABI,
  FACTORY_PLAN,
  uniq,
  scanLogs,
  derivePowers,
  withDerivedPowers,
  checkIssuerAdmin,
  preflightPowers,
  registryAgentsAfter,
  agentRoleOn,
  registryGovernors,
  openRegistryProposals,
  handOverIssuers,
  bindFactory,
  factorySteps,
};
