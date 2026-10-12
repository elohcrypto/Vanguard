/**
 * @fileoverview Handover ceremony, plan v2 Task 4.17 (review B BF-3): the
 * voting window. Between the preflight and the completion check the
 * deployer still owns every contract (governance accepts by vote), so an
 * action that leaves no live role (add itself as agent, mint, remove
 * itself; a temporary registry agent that registers or freezes) passes
 * an end-state comparison. The ceremony therefore records the hash of
 * every transaction it sends after the preflight (a recording signer),
 * and completion scans, from the preflight block to one pinned end
 * block, every grant (agents, guardians, officers, governors, exemptions,
 * authorized tokens, registrars, trusted contracts, escrow roles and
 * investors, nodes and emergency designations, attestors, the list
 * operator, issuer keys), mint, burn, recovery, identity registration,
 * removal or country change, investor-type assignment, freeze, root
 * publication and rule-administrator event. Each must come from a
 * ceremony transaction, from ops, from a vote (a transaction to
 * governance that executed a proposal) or, for a trusted contract, from
 * a call to a registrar of that token, or it is refused, even when the
 * power it granted was revoked since. The deployer's own transactions
 * are bounded by its nonce: every one since the preflight block must be
 * a recorded ceremony transaction (review B-1). The scan proves itself (R-413-6):
 * every watched event in the ceremony's own receipts must be found, so
 * an RPC or range that returns nothing fails instead of passing clean.
 */

const { ethers } = require("hardhat");
const { addrOf, same } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");

const ZERO = ethers.ZeroAddress;
const EXTRA_ABI = [
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event InvestorRegistered(address indexed investor, address indexed walletAddress)",
  "event IssuerKeyAdded(bytes32 indexed key, uint256 indexed purpose)",
  "event ProposalExecuted(uint256 indexed proposalId)",
];
const EXTRA = new ethers.Interface(EXTRA_ABI);

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
  const add = (c, label, name, ...args) => {
    if (!c) return;
    if (!c.filters[name]) throw new Error(`Handover: ${label}: no ${name}`);
    out.push([c, `${label} ${name}`, c.filters[name](...args)]);
  };
  const at = async (x) => ethers.getContractAt(EXTRA_ABI, await addrOf(x));
  for (const [c, l] of [
    [o.token, "VSC"],
    [o.governanceToken, "VGT"],
  ]) {
    for (const e of [
      "AgentAdded",
      "GuardianUpdated",
      "AddressFrozen",
      "TokensFrozen",
      "TokensUnfrozen",
      "RecoverySuccess",
    ])
      add(c, l, e);
    out.push([c, `${l} mint`, c.filters.Transfer(ZERO)]);
    out.push([c, `${l} burn`, c.filters.Transfer(null, ZERO)]);
  }
  for (const e of [
    "AgentAdded",
    "IdentityStored",
    "IdentityModified",
    "IdentityRemoved",
    "CountryUpdated",
  ])
    add(o.identityRegistry, "IdentityRegistry", e);
  for (const e of [
    "ComplianceOfficerUpdated",
    "GovernorUpdated",
    "InvestorLimitExemptionUpdated",
    "TokenAuthorized",
    "InvestorTypeAssigned",
    "InvestorTypeUpgraded",
    "InvestorTypeDowngraded",
  ])
    add(o.investorTypeRegistry, "InvestorTypeRegistry", e);
  for (const e of [
    "RuleAdministratorUpdated",
    "TrustedContractAdded",
    "TrustedRegistrarSet",
  ])
    add(o.complianceRules, "ComplianceRules", e);
  if (o.escrowWalletFactory) {
    const f = await at(o.escrowWalletFactory);
    add(f, "EscrowWalletFactory", "RoleGranted");
    add(f, "EscrowWalletFactory", "InvestorRegistered");
  }
  add(o.oracleManager, "OracleManager", "OracleRegistered");
  add(o.oracleManager, "OracleManager", "EmergencyOracleSet");
  for (const e of [
    "TrustedAttestorSet",
    "ListOperatorUpdated",
    "WhitelistRootPublished",
  ])
    add(o.privacyManager, "PrivacyManager", e);
  for (const issuer of o.issuers || [])
    add(await at(issuer), `issuer ${await addrOf(issuer)}`, "IssuerKeyAdded");
  return out;
}

/** True when `log` (address, topics) matches `c` and `filter`. */
async function matches(log, c, filter) {
  if (!same(log.address, await addrOf(c))) return false;
  const want = await filter.getTopicFilter();
  return want.every(
    (t, i) =>
      t === null ||
      (log.topics[i] || "").toLowerCase() === String(t).toLowerCase(),
  );
}

/** Receipt of `h` (cached), refusing a transaction the RPC cannot serve. */
async function receiptOf(cache, h) {
  if (!cache.has(h)) {
    const [tx, rc] = await Promise.all([
      ethers.provider.getTransaction(h),
      ethers.provider.getTransactionReceipt(h),
    ]);
    if (!tx || !rc) {
      throw new Error(
        `Handover: transaction ${h} is unknown to the RPC: nothing can be concluded about the voting window`,
      );
    }
    cache.set(h, { tx, rc });
  }
  return cache.get(h);
}

/**
 * A call to a registrar of `token` at the event's block: the last
 * TrustedRegistrarSet for (token, to) at or before it named a code hash.
 */
function registrarCall(sets, token, to, block) {
  const last = sets
    .filter(
      (e) =>
        same(e.args[0], token) && same(e.args[1], to) && e.blockNumber <= block,
    )
    .at(-1);
  return Boolean(last) && last.args[2] !== ethers.ZeroHash;
}

/**
 * Completion lines: [label, pass][]. `snap` is the preflight snapshot;
 * its `block` and `ceremonyTxs` come from handoverDeployerPowers.
 */
async function windowLines(o, snap) {
  if (!snap) return [];
  if (
    !Number.isInteger(snap.block) ||
    !Number.isInteger(snap.nonce) ||
    !Array.isArray(snap.ceremonyTxs) ||
    snap.ceremonyTxs.length === 0
  ) {
    return [
      [
        "the preflight snapshot records no preflight block, deployer nonce and ceremony transactions: activity in the voting window cannot be attributed (re-run the full phase)",
        false,
      ],
    ];
  }
  const ours = new Set(snap.ceremonyTxs.map((h) => h.toLowerCase()));
  const [ops, gov] = await Promise.all([o.ops, o.governance].map(addrOf));
  const rules = o.complianceRules;
  const end = await ethers.provider.getBlockNumber();
  const regSets = await scanLogs(rules, rules.filters.TrustedRegistrarSet(), {
    ...o,
    toBlock: end,
  });
  const scope = { ...o, fromBlock: snap.block + 1, toBlock: end };
  const executed = EXTRA.getEvent("ProposalExecuted").topicHash;
  const cache = new Map();
  const kinds = await watched(o);
  const found = new Set();
  const lines = [];
  for (const [c, label, filter] of kinds) {
    for (const ev of await scanLogs(c, filter, scope)) {
      const h = ev.transactionHash.toLowerCase();
      found.add(`${h}:${ev.index}`);
      if (ours.has(h)) continue;
      const { tx, rc } = await receiptOf(cache, h);
      const to = tx.to || ZERO;
      // Governance signs nothing itself; a dev node impersonating it
      // stands for a vote (R-417-4).
      if (same(tx.from, ops) || same(tx.from, gov)) continue;
      const vote =
        same(to, gov) &&
        rc.logs.some((l) => same(l.address, gov) && l.topics[0] === executed);
      if (vote) continue;
      if (
        label === "ComplianceRules TrustedContractAdded" &&
        registrarCall(regSets, ev.args[0], to, ev.blockNumber)
      )
        continue;
      lines.push([
        `${label} at block ${ev.blockNumber} sent by ${tx.from} (tx ${ev.transactionHash}) after the preflight: neither the ceremony, ops nor a vote; a power used in the voting window is refused even if revoked since`,
        false,
      ]);
    }
  }
  // R-413-6: every watched event in the ceremony's own receipts must be
  // in the scan, or the scan (range, chunk, RPC) proves nothing.
  const missed = [];
  let mustSee = 0;
  const dAddr = await addrOf(o.deployer);
  for (const h of ours) {
    const { tx, rc } = await receiptOf(cache, h);
    if (rc.blockNumber <= snap.block || rc.blockNumber > end) {
      missed.push(`${h} (block ${rc.blockNumber} outside the window)`);
      continue;
    }
    if (!same(tx.from, dAddr)) {
      missed.push(`${h} (sent by ${tx.from}, not the deployer)`);
      continue;
    }
    for (const log of rc.logs) {
      let hit = false;
      for (const [c, , filter] of kinds) {
        if (await matches(log, c, filter)) hit = true;
      }
      if (!hit) continue;
      mustSee++;
      if (!found.has(`${h}:${log.index}`)) missed.push(`${h}#${log.index}`);
    }
  }
  // Review B-1: whatever the deployer did leaves a nonce. Every one of
  // its transactions since the preflight must be a ceremony transaction
  // (settings with no watched event included: setCompliance and back).
  // A VGT holder's own vote (create, vote, execute, settle, refund, and
  // the VGT approval that pays for it) is
  // the one thing the deployer may do in the window besides the ceremony:
  // a transaction to governance that emitted a voting event.
  const g = o.governance;
  const votes = new Set();
  for (const e of [
    "ProposalCreated",
    "VoteCast",
    "ProposalExecuted",
    "ProposalExecutionFailed",
    "ProposalRejected",
    "ProposalCancelled",
    "RefundClaimed",
  ]) {
    for (const ev of await scanLogs(g, g.filters[e](), scope)) {
      const h = ev.transactionHash.toLowerCase();
      if (ours.has(h) || votes.has(h)) continue;
      const { tx } = await receiptOf(cache, h);
      if (same(tx.from, dAddr) && same(tx.to || ZERO, gov)) votes.add(h);
    }
  }
  // Paying the vote: the deployer's VGT approve(governance), as a
  // proposer's or voter's (demo option 83d proposes as wallet 0).
  const vgt = o.governanceToken;
  const APPROVE = vgt.interface.getFunction("approve").selector;
  for (const ev of await scanLogs(
    vgt,
    vgt.filters.Approval(dAddr, gov),
    scope,
  )) {
    const h = ev.transactionHash.toLowerCase();
    if (ours.has(h) || votes.has(h)) continue;
    const { tx } = await receiptOf(cache, h);
    if (same(tx.to || ZERO, await addrOf(vgt)) && tx.data.startsWith(APPROVE))
      votes.add(h);
  }
  const sent =
    (await ethers.provider.getTransactionCount(dAddr, end)) - snap.nonce;
  if (sent !== ours.size + votes.size) {
    lines.push([
      `deployer sent ${sent - ours.size - votes.size} transaction(s) in the voting window that the ceremony did not send (${sent} since the preflight block ${snap.block}: ${ours.size} recorded, ${votes.size} votes)`,
      false,
    ]);
  }
  if (missed.length) {
    lines.push([
      `voting-window event scan found none of the ceremony events it must see (${missed.join(", ")}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
      false,
    ]);
  }
  if (!lines.length) {
    lines.push([
      `every grant, mint, identity registration, freeze and rule-administrator event since the preflight (blocks ${snap.block + 1}-${end}, ${found.size} events, ${mustSee} of them the ceremony's) came from the ceremony, ops or a vote`,
      true,
    ]);
  }
  return lines;
}

module.exports = { recordingSigner, windowLines };
