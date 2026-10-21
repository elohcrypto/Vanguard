/**
 * @fileoverview Handover ceremony: the chunked log scan and the facts read
 * from it (plan v2 Task 2F.5 review M-1 to M-3, L-2). Moved out of
 * HandoverPowers.js to keep it under 500 lines: the escrow factory's live
 * role holders, the factories that created trusted escrows, the `fromBlock`
 * sanity check, escrows that still name the deployer as owner, and the
 * per-token trusted contracts and rule administrators (Task 4.1, G5).
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail, issuerLabel } = require("./HandoverChecks");
const { RANGE_ERROR, ARCHIVE_ERROR, textOf } = require("./RpcRetry");

const ZERO = ethers.ZeroAddress;
const FACTORY_OF = ["function factory() view returns (address)"];
const ESCROW_OF = [
  "function owner() view returns (address)",
  "function ownerWallet() view returns (address)",
];

/** Checksummed, de-duplicated, zero dropped. */
function uniq(list) {
  const out = [];
  for (const a of list) {
    if (!a || same(a, ZERO) || out.some((b) => same(a, b))) continue;
    out.push(ethers.getAddress(a));
  }
  return out;
}

/**
 * Every `filter` event of `contract` from o.fromBlock to o.toBlock, or
 * the latest block.
 * Public RPCs cap the eth_getLogs block range, so a range error halves the
 * chunk (floor 100) and retries; any other error is rethrown. Rate limits
 * and dropped connections are retried below, by RpcRetry.js (Task 5.15).
 */
async function scanLogs(contract, filter, o) {
  let chunk = o.logChunk || 5000;
  // Task 4.17: a caller may pin the range's end (o.toBlock).
  const latest = Number.isInteger(o.toBlock)
    ? o.toBlock
    : await ethers.provider.getBlockNumber();
  const found = [];
  for (let b = o.fromBlock || 0; b <= latest;) {
    const to = Math.min(b + chunk - 1, latest);
    try {
      found.push(...(await contract.queryFilter(filter, b, to)));
      b = to + 1;
    } catch (e) {
      // Block-range refusals only; a rate limit is rethrown, not halved.
      if (chunk <= 100 || !RANGE_ERROR.test(e.message)) throw e;
      chunk = Math.max(100, Math.floor(chunk / 2));
    }
  }
  return found;
}

/**
 * Review M-3: the scans start at o.fromBlock, so a block after a scanned
 * contract's deploy misses what was granted before it (agents,
 * governors, trusted contracts, rule administrators, nodes, attestors,
 * proposals). Task 4.13: refused when ANY derived contract already had
 * code at fromBlock - 1; a warning when the RPC cannot serve historical
 * code. `extra` adds [contract|address, label] pairs (the registrars).
 */
async function checkFromBlock(o, log = () => {}, extra = []) {
  const from = Number(o.fromBlock || 0);
  if (from <= 0) return;
  const scanned = [
    ["identityRegistry", "IdentityRegistry"],
    ["complianceRules", "ComplianceRules"],
    ["token", "Token"],
    ["governanceToken", "GovernanceToken"],
    ["investorTypeRegistry", "InvestorTypeRegistry"],
    ["oracleManager", "OracleManager"],
    ["escrowWalletFactory", "EscrowWalletFactory"],
    ["privacyManager", "PrivacyManager"],
    ["zkVerifier", "ZKVerifierIntegrated"],
  ]
    .filter(([k]) => o[k])
    .map(([k, label]) => [o[k], label]);
  const unproven = [];
  for (const [c, label] of [...scanned, ...extra]) {
    const a = await addrOf(c);
    let code;
    try {
      code = await ethers.provider.getCode(a, from - 1);
    } catch (e) {
      unproven.push(`${label} (${e.message.split("\n")[0]})`);
      continue;
    }
    if (code !== "0x") {
      fail(
        `fromBlock ${from} is after the ${label} deploy (it has code at block ${from - 1}): grants and events before it would be missed; use a block before the ${label} deploy`,
      );
    }
  }
  // L-4: every scanned contract must be proven, or nothing is.
  if (unproven.length) {
    fail(
      `fromBlock ${from}: the RPC cannot serve historical code for ${unproven.join("; ")}: use an archive RPC, or a fromBlock the RPC can prove precedes every deploy`,
    );
  }
  void log;
}

/**
 * Task 5.15 (readiness review M-3): every phase reads state at old blocks
 * (checkFromBlock at fromBlock - 1, the voting window's nonces at the
 * snapshot block), so an RPC that keeps only recent state is refused up
 * front, before anything is read or sent. Transient errors are retried
 * below (RpcRetry.js); any failure left is a refusal.
 */
async function requireArchive(o) {
  const at = Math.max(0, Number(o.fromBlock || 0) - 1);
  try {
    await ethers.provider.getBalance(await addrOf(o.deployer), at);
  } catch (e) {
    const why = textOf(e).split("\n")[0].slice(0, 160);
    fail(
      `the RPC cannot serve state at block ${at}${ARCHIVE_ERROR.test(why) ? " (not an archive node)" : ""}: ${why}; every ceremony phase reads historical state from fromBlock on: use an archive RPC, or a node that kept state since before fromBlock (runbook §2, Q18)`,
    );
  }
}

/**
 * Live holders of `role` on `f`, from RoleGranted events plus `proven`
 * candidates read directly; R-413-6: a proven candidate that holds the
 * role must appear in the scan (every grant emits RoleGranted).
 */
async function roleHolders(f, role, o, proven = []) {
  const hits = uniq(
    (await scanLogs(f, f.filters.RoleGranted(role), o)).map((ev) => ev.args[1]),
  );
  const live = [];
  for (const a of uniq([...hits, ...proven])) {
    if (await f.hasRole(role, a)) live.push(a);
  }
  const missed = live.filter(
    (a) => proven.some((p) => same(p, a)) && !hits.some((h) => same(h, a)),
  );
  if (missed.length) {
    fail(
      `EscrowWalletFactory RoleGranted event scan found none of the holders it must see (${missed.join(", ")}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  return live;
}

/** The escrow factory's live DEFAULT_ADMIN_ROLE and ADMIN_ROLE holders. */
async function escrowFactoryRoles(o) {
  const f = await ethers.getContractAt(
    "EscrowWalletFactory",
    await addrOf(o.escrowWalletFactory),
  );
  // Proven candidates: the owner holds DEFAULT_ADMIN_ROLE (granted by
  // event at construction and at every ownership transfer); the deployer
  // (constructor) and ops (step 5) are granted ADMIN_ROLE by event.
  const owner = await f.owner();
  const [dAddr, ops] = await Promise.all([o.deployer, o.ops].map(addrOf));
  return {
    admins: await roleHolders(f, await f.DEFAULT_ADMIN_ROLE(), o, [owner]),
    operators: await roleHolders(f, await f.ADMIN_ROLE(), o, [dAddr, ops]),
  };
}

/**
 * Review M-1, before any transaction: nobody but the deployer (or
 * governance, on a re-run) is a role admin of the escrow factory, and
 * nobody but the deployer and ops manages investors.
 */
async function preflightFactoryRoles(o, dAddr, ops, govAddr) {
  if (!o.escrowWalletFactory) return;
  const { admins, operators } = await escrowFactoryRoles(o);
  const extraAdmins = admins.filter(
    (a) => !same(a, dAddr) && !same(a, govAddr),
  );
  if (extraAdmins.length) {
    fail(
      `EscrowWalletFactory DEFAULT_ADMIN_ROLE held by ${extraAdmins.join(", ")} besides the deployer: it could grant ADMIN_ROLE (investor registration) or revoke ops after the handover; revokeRole(DEFAULT_ADMIN_ROLE, ...) first`,
    );
  }
  const extraOps = operators.filter((a) => !same(a, dAddr) && !same(a, ops));
  if (extraOps.length) {
    fail(
      `EscrowWalletFactory ADMIN_ROLE held by ${extraOps.join(", ")} besides the deployer and ops: revokeRole(ADMIN_ROLE, ...) first`,
    );
  }
}

/** Review M-1, completion: [label, pass] lines for the escrow factory roles. */
async function factoryRoleLines(o, govAddr, ops) {
  if (!o.escrowWalletFactory) return [];
  const { admins, operators } = await escrowFactoryRoles(o);
  return [
    [
      "EscrowWalletFactory DEFAULT_ADMIN_ROLE held only by governance",
      admins.length === 1 && same(admins[0], govAddr),
    ],
    [
      "EscrowWalletFactory ADMIN_ROLE held only by ops",
      operators.every((a) => same(a, ops)),
    ],
  ];
}

/**
 * Review M-2: the escrow factories named by live trusted escrows
 * (MultiSigEscrowWallet.factory()), each with one escrow that names it. A
 * trusted contract without factory() is skipped; RPC errors are rethrown.
 * Trust is per token since Task 4.1 (G5): each TrustedContractAdded(token,
 * account) is checked live on its own token.
 */
async function escrowFactoriesFromChain(o) {
  const out = [];
  for (const { account: a } of await liveTrustedContracts(o)) {
    if ((await ethers.provider.getCode(a)) === "0x") continue;
    let f;
    try {
      f = await (await ethers.getContractAt(FACTORY_OF, a)).factory();
    } catch (e) {
      // No factory(): a revert (or undecodable data), not an RPC failure.
      const noFactory =
        e.code === "CALL_EXCEPTION" ||
        e.code === "BAD_DATA" ||
        /revert/i.test(e.message);
      if (noFactory) continue;
      throw e;
    }
    if (same(f, ZERO) || out.some((x) => same(x.factory, f))) continue;
    out.push({ factory: ethers.getAddress(f), escrow: a });
  }
  return out;
}

/**
 * Every (token, account) pair still trusted in ComplianceRules, from the
 * token-indexed TrustedContractAdded events (Task 4.1, G5), de-duplicated.
 */
async function liveTrustedContracts(o) {
  const rules = o.complianceRules;
  const added = await scanLogs(rules, rules.filters.TrustedContractAdded(), o);
  const out = [];
  for (const ev of added) {
    const [token, account] = [ev.args[0], ev.args[1]];
    if (out.some((x) => same(x.token, token) && same(x.account, account))) {
      continue;
    }
    if (await rules["isTrustedContract(address,address)"](token, account)) {
      out.push({
        token: ethers.getAddress(token),
        account: ethers.getAddress(account),
      });
    }
  }
  // R-413-6: governance is trusted on VGT by event on every deploy path
  // (D21), so a scan that does not find it has not run over the range.
  const vgt = o.governanceToken && (await addrOf(o.governanceToken));
  const gov = o.governance && (await addrOf(o.governance));
  if (
    vgt &&
    gov &&
    (await rules["isTrustedContract(address,address)"](vgt, gov)) &&
    !added.some((ev) => same(ev.args[0], vgt) && same(ev.args[1], gov))
  ) {
    fail(
      `ComplianceRules TrustedContractAdded event scan found none of the holders it must see (governance ${gov} on VGT): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  return out;
}

/**
 * Review D2-1: every issuer the IdentityRegistry trusts for any topic,
 * required or not: [{ issuer, topics, block }] from TrustedIssuerAdded,
 * each topic re-read with isTrustedIssuer, `block` its last such event.
 * R-413-6: every issuer of a required topic was trusted by event, so the
 * scan must have seen it.
 */
async function trustedIssuers(o) {
  const reg = o.identityRegistry;
  const events = await scanLogs(reg, reg.filters.TrustedIssuerAdded(), o);
  const out = [];
  for (const issuer of uniq(events.map((ev) => ev.args[0]))) {
    const mine = events.filter((ev) => same(ev.args[0], issuer));
    const asked = new Set(mine.flatMap((ev) => [...ev.args[1]]));
    const topics = [];
    for (const t of asked)
      if (await reg.isTrustedIssuer(issuer, t)) topics.push(t);
    const block = mine[mine.length - 1].blockNumber;
    if (topics.length) out.push({ issuer, topics, block });
  }
  const missed = [];
  for (const topic of await reg.getClaimTopics()) {
    for (const a of await reg.getTrustedIssuersForClaimTopic(topic))
      if (!out.some((x) => same(x.issuer, a))) missed.push(a);
  }
  if (missed.length) {
    fail(
      `IdentityRegistry TrustedIssuerAdded event scan found none of the holders it must see (${uniq(missed).join(", ")}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  return out;
}

/** D2-1: one line per trusted issuer the scan found, with its topics. */
async function issuerLines(o) {
  const out = [];
  for (const { issuer, topics, block } of o.derived.trustedIssuers) {
    const c = await ethers.getContractAt("ClaimIssuer", issuer);
    out.push([
      `IdentityRegistry trusts ${await issuerLabel(c)} for topic(s) [${topics.join(", ")}] (TrustedIssuerAdded at block ${block})`,
      true,
    ]);
  }
  return out;
}

/**
 * Review L-2, D2-5: warnings for the escrows `factory` created that still
 * serve the deployer: an immutable owner (it can still setPayer on an
 * unfunded one and sweepExcess) or an ownerWallet fixed at creation (the
 * platform fee and the swept excess of every release go to it).
 */
async function deployerEscrows(factory, dAddr, o) {
  const created = await scanLogs(
    factory,
    factory.filters.EscrowWalletCreated(),
    o,
  );
  const [owned, paid] = [[], []];
  for (const a of uniq(created.map((ev) => ev.args[1]))) {
    const w = await ethers.getContractAt(ESCROW_OF, a);
    if (same(await w.owner(), dAddr)) owned.push(a);
    if (same(await w.ownerWallet(), dAddr)) paid.push(a);
  }
  const out = [];
  if (owned.length)
    out.push(
      `escrow(s) ${owned.join(", ")} were created before the handover and keep the deployer as owner (immutable): it can still setPayer on an unfunded one and sweepExcess; settle or sweep them`,
    );
  if (paid.length)
    out.push(
      `escrow(s) ${paid.join(", ")} keep the deployer as ownerWallet (fixed at creation): the platform fee and the swept excess of every release go to the deployer; settle or sweep them`,
    );
  return out;
}

/**
 * Review B-L2: every live ComplianceRules rule administrator, per token
 * (Task 4.1, G5), from RuleAdministratorUpdated(token, account, _) events
 * plus `extra` (the deployer) on every token the events or `o` name.
 * Returns [{ token, account }]. A rule administrator of a token can set or
 * clear its jurisdiction rule, which also lapses every private
 * jurisdiction record (Task 3.8).
 */
async function liveRuleAdministrators(o, extra = [], mustSee = []) {
  const rules = o.complianceRules;
  const events = await scanLogs(
    rules,
    rules.filters.RuleAdministratorUpdated(),
    o,
  );
  // R-413-6: a live holder granted by event must appear in the scan.
  const missed = [];
  for (const [t, a] of mustSee) {
    if (!(await rules.ruleAdministrators(t, a))) continue;
    if (!events.some((ev) => same(ev.args[0], t) && same(ev.args[1], a)))
      missed.push([t, a]);
  }
  if (missed.length) {
    fail(
      `ComplianceRules RuleAdministratorUpdated event scan found none of the holders it must see (${missed.map(([t, a]) => `${a} on ${t}`).join(", ")}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  const named = [];
  for (const c of [o.token, o.governanceToken])
    if (c) named.push(await addrOf(c));
  const tokens = uniq([...named, ...events.map((ev) => ev.args[0])]);
  const pairs = events.map((ev) => [ev.args[0], ev.args[1]]);
  for (const t of tokens) for (const a of extra) pairs.push([t, a]);
  const live = [];
  for (const [token, account] of pairs) {
    if (live.some((x) => same(x.token, token) && same(x.account, account))) {
      continue;
    }
    if (await rules.ruleAdministrators(token, account)) {
      live.push({
        token: ethers.getAddress(token),
        account: ethers.getAddress(account),
      });
    }
  }
  return live;
}

module.exports = {
  uniq,
  trustedIssuers,
  issuerLines,
  liveRuleAdministrators,
  liveTrustedContracts,
  scanLogs,
  checkFromBlock,
  requireArchive,
  roleHolders,
  preflightFactoryRoles,
  factoryRoleLines,
  escrowFactoriesFromChain,
  deployerEscrows,
};
