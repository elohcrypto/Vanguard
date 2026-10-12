/**
 * @fileoverview Handover ceremony: the read-only completion check. Moved
 * from HandoverChecks.js (plan v2 Task 2F.5) when it grew the chain-derived
 * power set (HandoverPowers.js), the factories, separation of duties, the
 * registry's side-governance and the residue warnings.
 */

const { ethers } = require("hardhat");
const {
  addrOf,
  same,
  hasLiveKey,
  issuerLabel,
  listManagerOf,
  withBoundRegistry,
  liveOnToken,
  planFor,
  vgtWhitelistMode,
  complianceMismatches,
} = require("./HandoverChecks");
const {
  FACTORY_PLAN,
  scanLogs,
  withDerivedPowers,
  registryAgentsAfter,
  agentRoleOn,
  registryGovernors,
  openRegistryProposals,
} = require("./HandoverPowers");
const {
  factoryRoleLines,
  deployerEscrows,
  liveRuleAdministrators,
  liveTrustedContracts,
} = require("./HandoverScans");
const { privacyLines } = require("./HandoverPrivacy");
const { keyManagerLines } = require("./HandoverKeys");
const { registrarLines, custodyOwnerLines } = require("./HandoverRegistrars");
const { holderLines } = require("./HandoverHolders");
const { oracleLines } = require("./HandoverOracles");
const { withDerivedContracts, linkLines } = require("./HandoverDerive");
const { roleLines } = require("./HandoverRoles");
const { trustLines } = require("./HandoverTrust");
const { nodeLines } = require("./HandoverNodes");
const { paramLines } = require("./HandoverParams");
const { snapshotLines, preflightSnapshots } = require("./HandoverSnapshot");
const { escrowLines } = require("./HandoverEscrow");
const { windowLines } = require("./HandoverWindow");

const ZERO = ethers.ZeroAddress;
const EXEMPT_ABI = [
  "function investorLimitExempt(address) view returns (bool)",
];

/**
 * Read-only verification. Returns { ok, failures, checks, warnings,
 * residual }; never pauses. Checks every contract the config names AND
 * every one derived from chain (HandoverPowers.derivePowers), so an
 * omitted oracle or factory cannot pass as "no power". Warnings never fail
 * the check; `residual` lists those that mean a deployer-era key still
 * vouches (review B-L3).
 */
async function assertHandoverComplete(o) {
  // Task 4.13: derived from governance; a config mismatch is a failing line.
  o = await withDerivedContracts(o, () => {}, { strict: false });
  o = await withBoundRegistry(o);
  o = await withDerivedPowers(o, () => {}, { strict: false });
  const dAddr = await addrOf(o.deployer);
  const ops = await addrOf(o.ops);
  const guardian = await addrOf(o.guardian);
  const govAddr = await addrOf(o.governance);
  const checks = [];
  const warnings = [];
  // Warnings that mean the deployer still vouches (review B-L3).
  const residual = [];
  const add = (label, pass) => checks.push({ label, ok: Boolean(pass) });
  // L-7: an R-413-6 proof that throws becomes a failing line here; any
  // other error (RPC) still propagates.
  const lines = async (name, p) => {
    try {
      for (const [label, pass] of await p) add(label, pass);
    } catch (e) {
      if (!/^Handover: /.test(e.message)) throw e;
      add(`${name}: ${e.message.slice(10)}`, false);
    }
  };
  // M-1: no snapshot, no proof the chain stood still since step 1 (this
  // process's own preflight counts; another process must pass it in).
  const snapshot = o.snapshot || preflightSnapshots.get(govAddr.toLowerCase());
  if (!snapshot) {
    add(
      "no preflight snapshot: nothing proves the chain did not change since step 1 (run the full phase, or pass the snapshot the full phase wrote)",
      false,
    );
  }
  // R-413-12: a null key the chain cannot derive is a residual warning.
  for (const key of o.nullAbsent || []) {
    const w = `config "${key}" is null and governance derives none: the deployer keeps it if it exists; name it, or state in the runbook why it does not exist`;
    warnings.push(w);
    residual.push(w);
  }
  for (const issue of o.derivationIssues) add(issue, false);
  if (!o.derivationIssues.length) {
    add(
      `every plan contract is the one governance derives (${Object.keys(o.derivedFrom).length} derived)`,
      true,
    );
  }
  await lines("links", linkLines(o));
  // Task 4.13: exact role sets from the event scans (A1 H1).
  await lines("roles", roleLines(o, warnings));
  if (o.skippedRegistry) {
    add(
      "InvestorTypeRegistry is not live on Token or is owned by governance",
      !(await liveOnToken(o, o.skippedRegistry)) ||
        same(await o.skippedRegistry.owner(), govAddr),
    );
  }

  for (const e of planFor(o)) {
    const c = o[e.key];
    const owned = same(await c.owner(), govAddr);
    if (e.key !== "escrowWalletFactory") {
      add(`${e.label} owned by governance`, owned);
      continue;
    }
    const roles = [await c.ADMIN_ROLE(), await c.DEFAULT_ADMIN_ROLE()];
    let noRole = true;
    for (const r of roles) if (await c.hasRole(r, dAddr)) noRole = false;
    add(
      "EscrowWalletFactory owned by governance, deployer holds no role",
      owned && noRole,
    );
  }
  // Review M-1: no role holder besides governance and ops survives.
  await lines("escrow factory roles", factoryRoleLines(o, govAddr, ops));
  for (const [label, pass] of await privacyLines(
    o,
    dAddr,
    ops,
    govAddr,
    warnings,
    residual,
  )) {
    add(label, pass);
  }
  // Task 4.2: KeyManager holds no power; the demo identity opted in.
  for (const [label, pass] of await keyManagerLines(o, dAddr)) add(label, pass);
  // Task 4.3: every trusted-contract registrar names compiled wallet code.
  await lines("registrars", registrarLines(o));
  await lines("custody owners", custodyOwnerLines(o, dAddr, ops, govAddr));
  // Task 4.16 (D47): every VSC holder listed at its tier, or no oracle.
  await lines("holders", holderLines(o, warnings));
  // Task 4.13: trusted contracts by registrar provenance; registrar code
  // and InvestorRequestManager immutables (B G-4/G-10, A1 M2).
  await lines("trust", trustLines(o, warnings, residual));
  // Task 4.4: the compiled engine serves the manager; ops is the operator.
  for (const [label, pass] of await oracleLines(o, dAddr, ops))
    add(label, pass);
  // Task 4.13: acknowledged nodes, provenance, designations, list oracles.
  await lines("nodes", nodeLines(o, dAddr, warnings, residual));
  // Task 4.13: floors, open proposals, fee sink, attestors, root, pins.
  await lines("parameters", paramLines(o));
  // Task 4.13: re-derived and compared with the preflight snapshot.
  await lines("snapshot", snapshotLines(o, snapshot));
  // Task 4.17: window activity (BF-3); escrow investors, fee wallet (BF-1/2).
  await lines("window", windowLines(o, snapshot));
  await lines("escrow", escrowLines(o));
  // Bound in governance, or the creator of a trusted escrow (review M-2),
  // but not named by the config: still checked.
  const d = o.derived;
  const unnamed = [
    ["dynamicListManager", "DynamicListManager", d.dynamicListManager],
    ...FACTORY_PLAN.map((e) => [e.key, e.label, d.factories[e.key]]),
  ].map(([k, l, a]) => [
    k,
    a,
    `${l} ${a} (${k === "privacyManager" && d.privacy.wiredBy ? "wired in ComplianceRules" : "bound in governance"})`,
  ]);
  for (const { factory, escrow } of d.escrowFactories) {
    unnamed.push([
      "escrowWalletFactory",
      factory,
      `EscrowWalletFactory ${factory} (creator of trusted escrow ${escrow})`,
    ]);
  }
  for (const [key, bound, label] of unnamed) {
    if (!bound || (o[key] && same(await addrOf(o[key]), bound))) continue;
    const c = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      bound,
    );
    add(`${label} owned by governance`, same(await c.owner(), govAddr));
  }
  add("deployer is not a Token agent", !(await o.token.isAgent(dAddr)));
  add(
    "deployer is not a GovernanceToken agent",
    !(await o.governanceToken.isAgent(dAddr)),
  );
  add(
    "deployer is not an IdentityRegistry agent",
    !(await o.identityRegistry.isAgent(dAddr)),
  );
  // Rule administrators are per token since Task 4.1 (G5).
  const vsc = await addrOf(o.token);
  const vgt = await addrOf(o.governanceToken);
  const rules = o.complianceRules;
  add(
    "deployer is not a ComplianceRules rule administrator on VSC or VGT",
    !(await rules.ruleAdministrators(vsc, dAddr)) &&
      !(await rules.ruleAdministrators(vgt, dAddr)),
  );
  // Review B-L2: nor any other key the deployer ever authorized, on any token.
  await lines(
    "rule administrators",
    adminLines(o, dAddr, ops, govAddr, vsc, vgt),
  );
  // Review B-M2: both tokens enforce the ComplianceRules governance owns.
  const mismatches = await complianceMismatches(o);
  add(
    `VSC and VGT enforce ComplianceRules ${await addrOf(o.complianceRules)}`,
    mismatches.length === 0,
  );
  add("ops is a Token agent", await o.token.isAgent(ops));
  add("ops is a GovernanceToken agent", await o.governanceToken.isAgent(ops));
  add(
    "ops is an IdentityRegistry agent",
    await o.identityRegistry.isAgent(ops),
  );
  add("guardian set on Token", same(await o.token.guardian(), guardian));
  add(
    "Token guardian is not the deployer",
    !same(await o.token.guardian(), dAddr),
  );
  if (o.dynamicListManager) {
    add(
      "DynamicListManager governanceContract is governance",
      same(await o.dynamicListManager.governanceContract(), govAddr),
    );
  }
  add(
    "GovernanceToken has no guardian",
    same(await o.governanceToken.guardian(), ZERO),
  );
  add(
    "no blacklist oracle bound to GovernanceToken (D23)",
    same(
      await o.complianceRules.blacklistOracle(await addrOf(o.governanceToken)),
      ZERO,
    ),
  );
  // D33 (a): no ZK whitelist mode on VGT (review B-M1).
  add(
    "GovernanceToken whitelist mode is OracleOnly (D33)",
    (await vgtWhitelistMode(o)) === "OracleOnly",
  );
  add(
    "ComplianceRules records VGT as the governance token (D33 b)",
    same(await rules.governanceToken(), vgt),
  );
  if (o.investorTypeRegistry) {
    const reg = o.investorTypeRegistry;
    add(
      "ops is an InvestorTypeRegistry compliance officer",
      await reg.isComplianceOfficer(ops),
    );
    add(
      "deployer is not an InvestorTypeRegistry compliance officer",
      !(await reg.isComplianceOfficer(dAddr)),
    );
    if (typeof reg.isGovernor === "function") {
      add(
        "deployer is not an InvestorTypeRegistry governor",
        !(await reg.isGovernor(dAddr)),
      );
    }
    // L2: the registry's own proposal system holds nothing executable.
    if (typeof reg.isProposalOpen === "function") {
      await lines(
        "registry governance",
        (async () => {
          const others = (await registryGovernors(o, reg)).filter(
            (g) => !same(g, govAddr),
          );
          const open = await openRegistryProposals(reg);
          return [
            [
              "InvestorTypeRegistry: no governor but governance, no open proposal",
              others.length === 0 && open.length === 0,
            ],
          ];
        })(),
      );
    }
  }
  for (const oracle of o.oracles || []) {
    const a = await oracle.getAddress();
    add(`oracle ${a} owned by ops`, same(await oracle.owner(), ops));
    const lm = await listManagerOf(oracle);
    if (lm)
      add(`oracle ${a} listManager is not the deployer`, !same(lm, dAddr));
  }
  add(
    "deployer is not a trusted contract on VSC or VGT",
    !(await rules["isTrustedContract(address,address)"](vsc, dAddr)) &&
      !(await rules["isTrustedContract(address,address)"](vgt, dAddr)),
  );
  // D21: governance holds VGT fees as a trusted contract, never as an
  // identity (a contract identity's claims lapse and ops could delete it).
  // Trusted on VGT only (G5): on VSC it is an ordinary unverified address.
  add(
    "governance is a trusted contract on VGT",
    await rules["isTrustedContract(address,address)"](vgt, govAddr),
  );
  add(
    "governance has no registry identity",
    same(await o.identityRegistry.identity(govAddr), ZERO),
  );
  // Residue from runs before 2E.1, when a wallet could be trusted. Every
  // live (token, account) pair from the token-indexed events (G5).
  await lines("trusted residue", residueLines(o));
  for (const issuer of o.issuers || []) {
    const label = await issuerLabel(issuer);
    // Review N-5: nor is it the pending owner (a planted nomination).
    add(
      `deployer does not own ${label}`,
      !same(await issuer.owner(), dAddr) &&
        !same(await issuer.pendingOwner(), dAddr),
    );
    add(
      `deployer holds no live key on ${label}`,
      !(await hasLiveKey(issuer, dAddr)),
    );
  }
  // D25 (b): no registry agent owns or signs for a trusted issuer.
  const agents = await registryAgentsAfter(o, dAddr, ops);
  let separate = true;
  for (const issuer of o.issuers || []) {
    if (await agentRoleOn(issuer, agents)) separate = false;
  }
  add(
    "no IdentityRegistry agent owns or holds a key on a trusted issuer (D25 b)",
    separate,
  );

  await residueWarnings(o, dAddr, govAddr, warnings);
  const failures = checks.filter((c) => !c.ok).map((c) => c.label);
  return { ok: failures.length === 0, failures, checks, warnings, residual };
}

/** Review B-L2: rule administrators besides governance and ops, per token. */
async function adminLines(o, dAddr, ops, govAddr, vsc, vgt) {
  // R-413-6: step 1 made governance an administrator of both by event.
  const extra = (
    await liveRuleAdministrators(
      o,
      [dAddr],
      [
        [vsc, govAddr],
        [vgt, govAddr],
      ],
    )
  ).filter(({ account: a }) => !same(a, govAddr) && !same(a, ops));
  const out = extra.map(({ token, account }) => [
    `${account} is still a ComplianceRules rule administrator on ${token} (neither governance nor ops)`,
    false,
  ]);
  if (!extra.length) {
    out.push([
      "no ComplianceRules rule administrator but governance and ops",
      true,
    ]);
  }
  return out;
}

/** Trusted accounts without code (a wallet or an EIP-7702 delegation). */
async function residueLines(o) {
  const out = [];
  for (const { account: a } of await liveTrustedContracts(o)) {
    const code = await ethers.provider.getCode(a);
    const delegated = code.length === 48 && /^0xef0100/i.test(code);
    if (code !== "0x" && !delegated) continue;
    out.push([`trusted address ${a} is a wallet or delegated wallet`, false]);
  }
  if (!out.length) out.push(["every trusted contract has code", true]);
  return out;
}

/**
 * Warnings, not failures: the deployer's leftover VSC and exemption (a
 * treasury artifact), escrows that keep the deployer as owner, and escrow
 * fee wallets that are not exempt on the
 * registry the Token enforces or were registered after the handover
 * (R-2F4-2: after it only an InvestorTypeConfig vote can exempt them).
 */
async function residueWarnings(o, dAddr, govAddr, warnings) {
  const itr = await o.token.investorTypeRegistry();
  const reg = same(itr, ZERO)
    ? null
    : await ethers.getContractAt(EXEMPT_ABI, itr);
  const exempt = async (w) => (reg ? reg.investorLimitExempt(w) : false);
  const bal = await o.token.balanceOf(dAddr);
  const dExempt = await exempt(dAddr);
  if (bal > 0n || dExempt) {
    warnings.push(
      `deployer still holds ${ethers.formatEther(bal)} VSC (investorLimitExempt: ${dExempt}, verified: ${await o.identityRegistry.isVerified(dAddr)}): move it to the treasury; only a vote can remove the exemption now`,
    );
  }
  const fAddr =
    (o.escrowWalletFactory && (await addrOf(o.escrowWalletFactory))) ||
    o.derived.factories.escrowWalletFactory ||
    o.derived.escrowFactories[0]?.factory;
  const f = fAddr && (await ethers.getContractAt("EscrowWalletFactory", fAddr));
  // Review L-2: an escrow's owner is immutable.
  const mine = f ? await deployerEscrows(f, dAddr, o) : [];
  if (mine.length) {
    warnings.push(
      `escrow(s) ${mine.join(", ")} were created before the handover and keep the deployer as owner (immutable): it can still setPayer on an unfunded one and sweepExcess; settle or sweep them`,
    );
  }
  if (!reg) return;
  const fee = [];
  if (f) {
    fee.push([await f.ownerWallet(), "factory ownerWallet"]);
    const handed = await scanLogs(
      f,
      f.filters.OwnershipTransferred(null, govAddr),
      o,
    );
    const at = handed.length ? handed[handed.length - 1].blockNumber : Infinity;
    for (const ev of await scanLogs(f, f.filters.InvestorRegistered(), o)) {
      const p = await f.getInvestorProfile(ev.args[0]);
      if (!p.isActive) continue;
      fee.push([p.walletAddress, `fee wallet of investor ${ev.args[0]}`]);
      if (ev.blockNumber > at) {
        warnings.push(
          `fee wallet ${p.walletAddress} (investor ${ev.args[0]}) was registered after the handover (block ${ev.blockNumber}): confirm its exemption by an InvestorTypeConfig vote`,
        );
      }
    }
  }
  for (const w of o.feeWallets || []) fee.push([w, "config feeWallets"]);
  const done = [];
  for (const [w, why] of fee) {
    if (done.some((x) => same(x, w))) continue;
    done.push(w);
    // A trusted fee wallet (the MultiSigWallet, Task 4.3) has no cap.
    if (
      await o.complianceRules["isTrustedContract(address,address)"](
        await addrOf(o.token),
        w,
      )
    )
      continue;
    if (!(await exempt(w))) {
      warnings.push(
        `escrow fee wallet ${w} (${why}) is not investorLimitExempt on the registry the Token enforces: releases revert once it nears its cap (R-2F4-2)`,
      );
    }
  }
}

module.exports = { assertHandoverComplete };
