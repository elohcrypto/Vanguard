/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13: one root, governance.
 *
 * Every contract the ceremony hands over or relies on is derived from
 * `governance` (its bound targets and its VGT), from the tokens, from
 * ComplianceRules, from the OnchainIDFactory and from the demo identity;
 * a config that still names one of them makes an assertion, refused when
 * it differs from the derived address. Four contracts are unreachable
 * from governance until step 3 binds them (an unbound OnchainIDFactory,
 * an escrow factory that is no registrar and created no trusted escrow,
 * an unwired privacy pair, a KeyManager nothing pins): those a config may
 * still name, and the derivation says so (R-413-2). The link checks
 * (A1 H2/H3, D56) refuse a chain whose contracts point at anything but
 * the derived set.
 */

const { ethers } = require("hardhat");
const { ACCEPTANCE_PLAN, addrOf, same, fail } = require("./HandoverChecks");
const { escrowFactoriesFromChain, checkFromBlock } = require("./HandoverScans");
const { liveRegistrars } = require("./HandoverRegistrars");
const { wiredPrivacy } = require("./HandoverPrivacy");
const { pinChecks, codeHashRefusal } = require("./HandoverCodeHash");

const ZERO = ethers.ZeroAddress;
const ARTIFACT = {
  token: "Token",
  governanceToken: "GovernanceToken",
  identityRegistry: "IdentityRegistry",
  complianceRules: "ComplianceRules",
  oracleManager: "OracleManager",
  investorTypeRegistry: "InvestorTypeRegistry",
  dynamicListManager: "DynamicListManager",
  escrowWalletFactory: "EscrowWalletFactory",
  onchainIDFactory: "OnchainIDFactory",
  privacyManager: "PrivacyManager",
  zkVerifier: "ZKVerifierIntegrated",
  keyManager: "KeyManager",
};
const LABEL = Object.fromEntries(ACCEPTANCE_PLAN.map((e) => [e.key, e.label]));
LABEL.keyManager = "KeyManager";
const nz = (a) => (a && !same(a, ZERO) ? ethers.getAddress(a) : null);
const RM_ABI = ["function recoveryManager() view returns (address)"];

/**
 * One derived address with its provenance. Two sources that disagree
 * refuse (strict) or are recorded in `issues` with the first source kept
 * (the completion check never throws).
 */
function pick(key, found, issues) {
  const hits = found.filter(([, a]) => a);
  const [first] = hits;
  const other = first && hits.find(([, a]) => !same(a, first[1]));
  if (other) {
    const msg = `${LABEL[key]}: ${first[0]} is ${first[1]}, but ${other[0]} is ${other[1]}: one ${LABEL[key]} per deployment; fix the chain before the ceremony`;
    if (!issues) fail(msg);
    issues.push(msg);
  }
  return first ? { addr: first[1], how: first[0] } : null;
}

/**
 * { key: { addr, how } } for every contract reachable from governance,
 * read-only. `o` needs `governance`; `complianceRules`/`token` are taken
 * from the derivation itself for the registrar and privacy scans.
 */
async function deriveContracts(o, issues = null) {
  const gov =
    typeof o.governance === "string"
      ? await ethers.getContractAt("VanguardGovernance", o.governance)
      : o.governance;
  const bound = async (t, name) => [
    `governance.boundTarget(${t}) (${name})`,
    nz(await gov.boundTarget(t)),
  ];
  const d = {};
  const core = [
    ["token", await bound(3, "TokenParameters")],
    [
      "governanceToken",
      ["governance.governanceToken()", nz(await gov.governanceToken())],
    ],
    ["identityRegistry", await bound(7, "IdentityRegistryParameters")],
    ["complianceRules", await bound(1, "ComplianceRules")],
    ["oracleManager", await bound(2, "OracleParameters")],
  ];
  for (const [key, [how, addr]] of core) {
    if (!addr) {
      fail(
        `governance is not bound to ${LABEL[key]} (${how} is zero): governance must be deployed after ${LABEL[key]}; redeploy it`,
      );
    }
    d[key] = { addr, how };
  }
  const pk = (key, found) => pick(key, found, issues);
  d.investorTypeRegistry = pk("investorTypeRegistry", [
    await bound(0, "InvestorTypeConfig"),
  ]);
  d.dynamicListManager = pk("dynamicListManager", [
    ["governance.dynamicListManager()", nz(await gov.dynamicListManager())],
  ]);
  const at = (key) => ethers.getContractAt(ARTIFACT[key], d[key].addr);
  const scanCtx = {
    ...o,
    complianceRules: await at("complianceRules"),
    token: await at("token"),
    governanceToken: await at("governanceToken"),
    identityRegistry: await at("identityRegistry"),
    oracleManager: await at("oracleManager"),
  };
  // R-413-6: no scan before fromBlock is proven to precede the core.
  await checkFromBlock(scanCtx, () => {});
  const vsc = d.token.addr;
  const escrows = await escrowFactoriesFromChain(scanCtx);
  const bound9 = await bound(9, "EscrowFactoryParameters");
  const escrowRegistrars = (
    await liveRegistrars(scanCtx, [
      bound9[1],
      ...escrows.map((e) => e.factory),
      o.escrowWalletFactory,
    ])
  ).filter((r) => same(r.token, vsc) && r.wallet === "MultiSigEscrowWallet");
  d.escrowWalletFactory = pk("escrowWalletFactory", [
    bound9,
    ...escrowRegistrars.map((r) => [
      "the ComplianceRules registrar for MultiSigEscrowWallet on VSC",
      r.registrar,
    ]),
    ...escrows.map((e) => [`trusted escrow ${e.escrow} factory()`, e.factory]),
  ]);
  d.onchainIDFactory = pk("onchainIDFactory", [
    await bound(10, "IdentityFactoryParameters"),
  ]);
  const boundPm = await bound(11, "PrivacyParameters");
  const privacy = await wiredPrivacy(scanCtx, boundPm[1]);
  if (privacy.conflict && !issues) fail(privacy.conflict);
  if (privacy.conflict) issues.push(privacy.conflict);
  const wired = privacy.wired.find((w) => !same(w.pm, ZERO));
  d.privacyManager = pk("privacyManager", [
    boundPm,
    [`ComplianceRules.privacyManager(${wired?.label})`, wired?.pm],
  ]);
  const pmZk = d.privacyManager
    ? nz(await (await at("privacyManager")).zkVerifier())
    : null;
  d.zkVerifier = pk("zkVerifier", [
    [`PrivacyManager ${d.privacyManager?.addr} zkVerifier()`, pmZk],
    await bound(12, "VerifierParameters"),
  ]);
  const km = [];
  // The factory the config names counts before step 3 binds it (R-413-2).
  const facAddr =
    d.onchainIDFactory?.addr ||
    (o.onchainIDFactory ? await addrOf(o.onchainIDFactory) : null);
  // R-411-20 (Task 5.2): recoveryManager() is read only from a factory
  // whose code is the compiled OnchainIDFactory; a tampered one is
  // refused here by name (planPins pins it again at preflight/completion).
  const [facPin] = facAddr
    ? await pinChecks([
        { label: "OnchainIDFactory", addr: facAddr, name: "OnchainIDFactory" },
      ])
    : [];
  if (facPin && !facPin.ok) {
    const msg = `${codeHashRefusal(facPin)}; its recoveryManager() is not read`;
    if (!issues) fail(msg);
    issues.push(msg);
  } else if (facAddr) {
    const f = await ethers.getContractAt(RM_ABI, facAddr);
    km.push([
      `OnchainIDFactory ${facAddr} recoveryManager()`,
      nz(await f.recoveryManager().catch(() => null)),
    ]);
  }
  const idAddr = o.keyManagerIdentity && (await addrOf(o.keyManagerIdentity));
  if (idAddr && (await ethers.provider.getCode(idAddr)) !== "0x") {
    const id = await ethers.getContractAt(RM_ABI, idAddr);
    km.push([
      `keyManagerIdentity ${idAddr} recoveryManager()`,
      nz(await id.recoveryManager().catch(() => null)),
    ]);
  }
  d.keyManager = pk("keyManager", km);
  return d;
}

/**
 * `o` with every derivable contract filled in (ethers contracts) and
 * `derivedFrom` ({ key: how }). A given address that differs from the
 * derived one is refused (strict, the ceremony) or recorded in
 * `derivationIssues` (the completion check, which never throws). A key
 * the chain cannot derive yet keeps what the config names, with a line.
 */
async function withDerivedContracts(o, log = () => {}, { strict = true } = {}) {
  const issues = [];
  const d = await deriveContracts(o, strict ? null : issues);
  const out = { ...o, derivedFrom: {}, derivationIssues: issues };
  // R-413-12: absent key = derive; address = assertion; null = assertion
  // of absence, refused when the chain derives one and a residual warning
  // (never "holds no power") when it is underivable.
  out.nullAbsent = [];
  for (const key of Object.keys(ARTIFACT)) {
    const isNull = key in o && o[key] === null;
    const given = o[key] == null ? null : await addrOf(o[key]);
    const derived = d[key];
    if (derived) out.derivedFrom[key] = derived.how;
    if (isNull && derived) {
      const msg = `config "${key}" is null (asserts none), but ${derived.how} is ${derived.addr}: the ceremony derives every contract from governance; drop the key or fix the chain`;
      if (strict) fail(msg);
      out.derivationIssues.push(msg);
    }
    if (isNull && !derived) out.nullAbsent.push(key);
    if (given && derived && !same(given, derived.addr)) {
      const msg = `config "${key}" names ${given}, but ${derived.how} is ${derived.addr}: the ceremony derives every contract from governance; drop the key or fix the chain`;
      if (strict) fail(msg);
      out.derivationIssues.push(msg);
    }
    if (given && !derived) {
      out.derivedFrom[key] =
        "the config (not reachable from governance before step 3 binds it)";
      if (strict && key !== "investorTypeRegistry") {
        log(`   ℹ️  ${LABEL[key]} ${given}: ${out.derivedFrom[key]}`);
      }
      continue;
    }
    if (derived && (!given || !same(given, derived.addr))) {
      out[key] = await ethers.getContractAt(ARTIFACT[key], derived.addr);
    }
  }
  out.governance =
    typeof o.governance === "string"
      ? await ethers.getContractAt("VanguardGovernance", o.governance)
      : o.governance;
  return out;
}

/**
 * The link checks (A1 H2/H3, M1, D56): [{ label, ok, fix }] for every
 * pointer between the derived contracts. Read after withDerivedContracts.
 */
async function linkChecks(o) {
  const a = async (k) => (o[k] ? addrOf(o[k]) : null);
  const [vsc, vgt, reg, rules, om] = await Promise.all(
    [
      "token",
      "governanceToken",
      "identityRegistry",
      "complianceRules",
      "oracleManager",
    ].map(a),
  );
  const itr = await a("investorTypeRegistry");
  const out = [];
  const link = (label, got, want, fix) =>
    out.push({ label: `${label}: ${want}`, ok: same(got, want), got, fix });
  link(
    "Token identityRegistry()",
    await o.token.identityRegistry(),
    reg,
    "the Token owner must setIdentityRegistry(the plan registry)",
  );
  link(
    "GovernanceToken identityRegistry()",
    await o.governanceToken.identityRegistry(),
    reg,
    "the GovernanceToken owner must setIdentityRegistry(the plan registry)",
  );
  link(
    "governance identityRegistry()",
    await o.governance.identityRegistry(),
    reg,
    "redeploy governance against the plan registry",
  );
  for (const [label, t] of [
    ["VSC", vsc],
    ["VGT", vgt],
  ]) {
    link(
      `ComplianceRules tokenIdentityRegistry(${label})`,
      await o.complianceRules.tokenIdentityRegistry(t),
      reg,
      `the ComplianceRules owner must setTokenIdentityRegistry(${label}, the plan registry)`,
    );
  }
  link(
    "IdentityRegistry getComplianceRules()",
    await o.identityRegistry.getComplianceRules(),
    rules,
    "the IdentityRegistry owner must setComplianceRules(the plan rules, VSC)",
  );
  const vscItr = await o.token.investorTypeRegistry();
  const okItr = same(vscItr, ZERO) || (itr && same(vscItr, itr));
  out.push({
    label: `Token investorTypeRegistry() is ${itr ? `none or ${itr}` : "none"} (the registry governance is bound to)`,
    ok: Boolean(okItr),
    got: vscItr,
    fix: itr
      ? `the Token enforces InvestorTypeRegistry ${vscItr}, which governance is not bound to (boundTarget(0) = ${itr}): its owner could halt VSC (authorizeToken(VSC, false)) or cap every holder after the handover; point the Token at ${itr} (setInvestorTypeRegistry) or redeploy governance after ${vscItr}`
      : `the Token enforces InvestorTypeRegistry ${vscItr}, which governance is not bound to: redeploy governance after it`,
  });
  if (okItr && itr && same(vscItr, itr)) {
    out.push({
      label: `InvestorTypeRegistry authorizes VSC (isTokenAuthorized)`,
      ok: await o.investorTypeRegistry.isTokenAuthorized(vsc),
      fix: "every VSC mint and transfer reverts until the registry owner calls authorizeToken(VSC, true)",
    });
  }
  const vgtItr = await o.governanceToken.investorTypeRegistry();
  out.push({
    label: "GovernanceToken has no investorTypeRegistry (D56)",
    ok: same(vgtItr, ZERO),
    got: vgtItr,
    fix: `a registry on VGT (${vgtItr}) lets its owner cooldown or cap every voter's fee transfer; Token.setInvestorTypeRegistry refuses zero, so redeploy VGT and governance`,
  });
  const vgtWl = await o.complianceRules.whitelistOracle(vgt);
  out.push({
    label: "no whitelist oracle bound to GovernanceToken (D56)",
    ok: same(vgtWl, ZERO),
    got: vgtWl,
    fix: `a whitelist oracle on VGT (${vgtWl}) makes its owner (ops) the electorate's gatekeeper; the ComplianceRules owner must setWhitelistOracle(VGT, 0) first`,
  });
  for (const oracle of o.oracles || []) {
    const oa = await addrOf(oracle);
    const served = await (
      await ethers.getContractAt(
        ["function oracleManager() view returns (address)"],
        oa,
      )
    )
      .oracleManager()
      .catch(() => ZERO);
    link(
      `oracle ${oa} oracleManager()`,
      served,
      om,
      `the oracle answers to OracleManager ${served}, not the plan manager: its verdicts come from nodes governance never registered; unbind it (setWhitelistOracle/setBlacklistOracle) or redeploy it for ${om}`,
    );
  }
  if (o.escrowWalletFactory) {
    const f = o.escrowWalletFactory;
    link(
      "EscrowWalletFactory vscToken()",
      await f.vscToken(),
      vsc,
      "redeploy the escrow factory for VSC",
    );
    link(
      "EscrowWalletFactory identityRegistry()",
      await f.identityRegistry(),
      reg,
      "its owner must setIdentityRegistry(the plan registry)",
    );
    link(
      "EscrowWalletFactory complianceRules()",
      await f.complianceRules(),
      rules,
      "its owner must setComplianceRules(the plan rules)",
    );
  }
  return out;
}

/** Preflight: refuse the first failing link. */
async function preflightLinks(o) {
  for (const c of await linkChecks(o)) {
    if (!c.ok) fail(`${c.label}; found ${c.got ?? "false"}: ${c.fix}`);
  }
}

/** Completion lines: [label, pass][]. */
async function linkLines(o) {
  return (await linkChecks(o)).map((c) => [c.label, c.ok]);
}

module.exports = {
  ARTIFACT,
  LABEL,
  deriveContracts,
  withDerivedContracts,
  linkChecks,
  preflightLinks,
  linkLines,
};
