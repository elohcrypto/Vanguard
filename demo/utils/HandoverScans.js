/**
 * @fileoverview Handover ceremony: the chunked log scan and the facts read
 * from it (plan v2 Task 2F.5 review M-1 to M-3, L-2). Moved out of
 * HandoverPowers.js to keep it under 500 lines: the escrow factory's live
 * role holders, the factories that created trusted escrows, the `fromBlock`
 * sanity check, and escrows that still name the deployer as owner.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");

const ZERO = ethers.ZeroAddress;
const FACTORY_OF = ["function factory() view returns (address)"];
const OWNER_OF = ["function owner() view returns (address)"];

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
 * Every `filter` event of `contract` from o.fromBlock to the latest block.
 * Public RPCs cap the eth_getLogs block range, so a range error halves the
 * chunk (floor 100) and retries; any other error is rethrown.
 */
async function scanLogs(contract, filter, o) {
  let chunk = o.logChunk || 5000;
  const latest = await ethers.provider.getBlockNumber();
  const found = [];
  for (let b = o.fromBlock || 0; b <= latest;) {
    const to = Math.min(b + chunk - 1, latest);
    try {
      found.push(...(await contract.queryFilter(filter, b, to)));
      b = to + 1;
    } catch (e) {
      // Block-range refusals only; a rate limit is rethrown, not halved.
      const rangeError =
        /block range|range too large|exceeds.*(range|limit)|too many (blocks|results)|query returned more than/i;
      if (chunk <= 100 || !rangeError.test(e.message)) throw e;
      chunk = Math.max(100, Math.floor(chunk / 2));
    }
  }
  return found;
}

/**
 * Review M-3: the scans start at o.fromBlock, so a block after the
 * IdentityRegistry deploy misses agents (and governors, trusted contracts)
 * added before it. Refused when the registry already had code at
 * fromBlock - 1; a warning when the RPC cannot serve historical code.
 */
async function checkFromBlock(o, log = () => {}) {
  const from = Number(o.fromBlock || 0);
  if (from <= 0 || !o.identityRegistry) return;
  const reg = await addrOf(o.identityRegistry);
  let code;
  try {
    code = await ethers.provider.getCode(reg, from - 1);
  } catch (e) {
    log(
      `   ⚠️  fromBlock ${from}: the RPC cannot serve historical code (${e.message.split("\n")[0]}); make sure it is a block before the IdentityRegistry deploy`,
    );
    return;
  }
  if (code !== "0x") {
    fail(
      `fromBlock ${from} is after the IdentityRegistry deploy (it has code at block ${from - 1}): agents, governors and trusted contracts added earlier would be missed; use a block before the IdentityRegistry deploy`,
    );
  }
}

/** Live holders of `role` on `f`, from RoleGranted events. */
async function roleHolders(f, role, o) {
  const seen = uniq(
    (await scanLogs(f, f.filters.RoleGranted(role), o)).map((ev) => ev.args[1]),
  );
  const live = [];
  for (const a of seen) if (await f.hasRole(role, a)) live.push(a);
  return live;
}

/** The escrow factory's live DEFAULT_ADMIN_ROLE and ADMIN_ROLE holders. */
async function escrowFactoryRoles(o) {
  const f = await ethers.getContractAt(
    "EscrowWalletFactory",
    await addrOf(o.escrowWalletFactory),
  );
  return {
    admins: await roleHolders(f, await f.DEFAULT_ADMIN_ROLE(), o),
    operators: await roleHolders(f, await f.ADMIN_ROLE(), o),
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
 */
async function escrowFactoriesFromChain(o) {
  const rules = o.complianceRules;
  const added = await scanLogs(rules, rules.filters.TrustedContractAdded(), o);
  const out = [];
  for (const a of uniq(added.map((ev) => ev.args[0]))) {
    if (!(await rules.isTrustedContract(a))) continue;
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
 * Review L-2: escrows `factory` created whose immutable owner is the
 * deployer (created before the handover). It can still setPayer on an
 * unfunded one and sweepExcess.
 */
async function deployerEscrows(factory, dAddr, o) {
  const created = await scanLogs(
    factory,
    factory.filters.EscrowWalletCreated(),
    o,
  );
  const out = [];
  for (const a of uniq(created.map((ev) => ev.args[1]))) {
    const w = await ethers.getContractAt(OWNER_OF, a);
    if (same(await w.owner(), dAddr)) out.push(a);
  }
  return out;
}

/**
 * Review B-L2: every live ComplianceRules rule administrator, from
 * RuleAdministratorUpdated events plus the owners the constructor and
 * transfers named (the constructor authorizes its owner without the event)
 * and `extra` (the deployer). A rule administrator can set or clear any
 * token's jurisdiction rule, which also lapses every private jurisdiction
 * record (Task 3.8).
 */
async function liveRuleAdministrators(o, extra = []) {
  const rules = o.complianceRules;
  const admins = await scanLogs(
    rules,
    rules.filters.RuleAdministratorUpdated(),
    o,
  );
  const owners = await scanLogs(rules, rules.filters.OwnershipTransferred(), o);
  const live = [];
  for (const a of uniq([
    ...admins.map((ev) => ev.args[0]),
    ...owners.map((ev) => ev.args[1]),
    ...extra,
  ])) {
    if (await rules.ruleAdministrators(a)) live.push(a);
  }
  return live;
}

module.exports = {
  uniq,
  liveRuleAdministrators,
  scanLogs,
  checkFromBlock,
  roleHolders,
  preflightFactoryRoles,
  factoryRoleLines,
  escrowFactoriesFromChain,
  deployerEscrows,
};
