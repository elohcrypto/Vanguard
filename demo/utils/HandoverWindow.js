/**
 * @fileoverview Handover ceremony, plan v2 Task 4.17 (review B BF-3): the
 * voting window. Between the preflight and the completion check the
 * deployer still owns every contract (governance accepts by vote), so an
 * action that leaves no live role (add itself as agent, mint, remove
 * itself; a temporary registry agent that registers or freezes) passes
 * an end-state comparison. The ceremony therefore records the hash of
 * every transaction it sends after the preflight (a recording signer),
 * and completion scans every grant, mint, identity registration, freeze
 * and rule-administrator event after the preflight block: each must come
 * from a ceremony transaction, from ops, from a governance vote
 * (executeProposal) or, for a trusted contract, from a registrar's own
 * call (createMultiSigWallet, createEscrowWallet), or it is refused, even
 * when the power it granted was revoked since.
 */

const { ethers } = require("hardhat");
const { addrOf, same } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");

const ZERO = ethers.ZeroAddress;
const EXECUTE = ethers
  .id("executeProposal(uint256)")
  .slice(0, 10)
  .toLowerCase();
const ROLE_ABI = [
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event InvestorRegistered(address indexed investor, address indexed walletAddress)",
];
const ISSUER_ABI = [
  "event IssuerKeyAdded(bytes32 indexed key, uint256 indexed purpose)",
];

/**
 * `signer` that records the hash of every transaction it sends in
 * `hashes`. Contracts connected to it send through it as usual.
 */
function recordingSigner(signer, hashes) {
  return new Proxy(signer, {
    get(t, p) {
      if (p === "sendTransaction") {
        return async (tx) => {
          const r = await t.sendTransaction(tx);
          hashes.push(r.hash);
          return r;
        };
      }
      if (p === "connect")
        return (pr) => recordingSigner(t.connect(pr), hashes);
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** [contract, label, filter] for every watched event kind. */
async function watched(o) {
  const out = [];
  const add = (c, label, filter) => c && out.push([c, label, filter]);
  for (const [c, l] of [
    [o.token, "VSC"],
    [o.governanceToken, "VGT"],
  ]) {
    add(c, `${l} AgentAdded`, c.filters.AgentAdded());
    add(c, `${l} mint`, c.filters.Transfer(ZERO));
    add(c, `${l} AddressFrozen`, c.filters.AddressFrozen());
    add(c, `${l} TokensFrozen`, c.filters.TokensFrozen());
    add(c, `${l} TokensUnfrozen`, c.filters.TokensUnfrozen());
  }
  const reg = o.identityRegistry;
  add(reg, "IdentityRegistry AgentAdded", reg.filters.AgentAdded());
  add(reg, "IdentityRegistry IdentityStored", reg.filters.IdentityStored());
  add(reg, "IdentityRegistry IdentityModified", reg.filters.IdentityModified());
  const itr = o.investorTypeRegistry;
  if (itr) {
    for (const e of [
      "ComplianceOfficerUpdated",
      "GovernorUpdated",
      "InvestorLimitExemptionUpdated",
      "TokenAuthorized",
    ])
      add(itr, `InvestorTypeRegistry ${e}`, itr.filters[e]());
  }
  const rules = o.complianceRules;
  for (const e of [
    "RuleAdministratorUpdated",
    "TrustedContractAdded",
    "TrustedRegistrarSet",
  ])
    add(rules, `ComplianceRules ${e}`, rules.filters[e]());
  if (o.escrowWalletFactory) {
    const f = await ethers.getContractAt(
      ROLE_ABI,
      await addrOf(o.escrowWalletFactory),
    );
    add(f, "EscrowWalletFactory RoleGranted", f.filters.RoleGranted());
    add(
      f,
      "EscrowWalletFactory InvestorRegistered",
      f.filters.InvestorRegistered(),
    );
  }
  const om = o.oracleManager;
  add(om, "OracleManager OracleRegistered", om.filters.OracleRegistered());
  if (o.privacyManager) {
    const pm = o.privacyManager;
    add(
      pm,
      "PrivacyManager TrustedAttestorSet",
      pm.filters.TrustedAttestorSet(),
    );
    add(
      pm,
      "PrivacyManager ListOperatorUpdated",
      pm.filters.ListOperatorUpdated(),
    );
  }
  for (const issuer of o.issuers || []) {
    const c = await ethers.getContractAt(ISSUER_ABI, await addrOf(issuer));
    add(
      c,
      `issuer ${await addrOf(issuer)} IssuerKeyAdded`,
      c.filters.IssuerKeyAdded(),
    );
  }
  return out;
}

/** The registrars of ComplianceRules (their own calls may add trust). */
async function registrars(o) {
  const rules = o.complianceRules;
  const out = [];
  for (const ev of await scanLogs(
    rules,
    rules.filters.TrustedRegistrarSet(),
    o,
  ))
    out.push(ev.args[1]);
  return out;
}

/**
 * Completion lines: [label, pass][]. `snap` is the preflight snapshot;
 * its `block` and `ceremonyTxs` come from handoverDeployerPowers.
 */
async function windowLines(o, snap) {
  if (!snap) return [];
  if (!Number.isInteger(snap.block) || !Array.isArray(snap.ceremonyTxs)) {
    return [
      [
        "the preflight snapshot records no preflight block and ceremony transactions: activity in the voting window cannot be attributed (re-run the full phase)",
        false,
      ],
    ];
  }
  const ours = new Set(snap.ceremonyTxs.map((h) => h.toLowerCase()));
  const [ops, gov] = await Promise.all([o.ops, o.governance].map(addrOf));
  const regs = await registrars(o);
  const scope = { ...o, fromBlock: snap.block + 1 };
  const lines = [];
  const seen = new Map();
  let n = 0;
  for (const [c, label, filter] of await watched(o)) {
    for (const ev of await scanLogs(c, filter, scope)) {
      n++;
      const h = ev.transactionHash.toLowerCase();
      if (ours.has(h)) continue;
      if (!seen.has(h)) seen.set(h, await ethers.provider.getTransaction(h));
      const tx = seen.get(h);
      const to = tx.to || ZERO;
      // Governance signs nothing itself; a dev node impersonating it
      // stands for a vote (R-417-4).
      if (same(tx.from, ops) || same(tx.from, gov)) continue;
      if (same(to, gov) && tx.data.toLowerCase().startsWith(EXECUTE)) continue;
      if (
        label === "ComplianceRules TrustedContractAdded" &&
        regs.some((r) => same(r, to))
      )
        continue;
      lines.push([
        `${label} at block ${ev.blockNumber} sent by ${tx.from} (tx ${ev.transactionHash}) after the preflight: neither the ceremony, ops nor a vote; a power used in the voting window is refused even if revoked since`,
        false,
      ]);
    }
  }
  if (!lines.length) {
    lines.push([
      `every grant, mint, identity registration, freeze and rule-administrator event since the preflight (block ${snap.block}, ${n} events) came from the ceremony, ops or a vote`,
      true,
    ]);
  }
  return lines;
}

module.exports = { recordingSigner, windowLines };
