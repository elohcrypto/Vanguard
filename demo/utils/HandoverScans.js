/**
 * @fileoverview Handover ceremony: the chunked log scan and the facts read
 * from it (plan v2 Task 2F.5 review M-1 to M-3, L-2). Moved out of
 * HandoverPowers.js to keep it under 500 lines: the escrow factory's live
 * role holders, the factories that created trusted escrows, the `fromBlock`
 * sanity check, escrows that still name the deployer as owner, and the
 * per-token trusted contracts and rule administrators (Task 4.1, G5).
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { RANGE_ERROR } = require("./RpcRetry");

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

module.exports = {
  uniq,
  liveRuleAdministrators,
  liveTrustedContracts,
  scanLogs,
  checkFromBlock,
  roleHolders,
  preflightFactoryRoles,
  factoryRoleLines,
  escrowFactoriesFromChain,
  deployerEscrows,
};
