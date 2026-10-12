/**
 * @fileoverview Handover ceremony, plan v2 Task 4.17 (review B BF-1,
 * BF-2): the escrow factory's investors and fee wallet.
 *
 * INVESTOR_ROLE with an active registration creates escrows that
 * ComplianceRules trusts on VSC and signs their releases, so it is a
 * power: the deployer may hold it before the ceremony (step 5 deactivates
 * its registration, or revokes a bare grant, while it still manages the
 * factory) and never after; a holder without an active registration (a
 * bare grantRole: inert, but a stray) is refused. The factory's fee
 * wallet (ownerWallet) follows the D54 rule: ops or a wallet the config
 * lists in feeWallets (the operator's explicit acknowledgement), never
 * the deployer; step 5 moves a deployer fee wallet to ops (R-417-2 as
 * replaced: an exemption is no acknowledgement, the deployer grants it).
 * An escrow ComplianceRules trusts whose investor (its arbiter:
 * signAsInvestor, resolveDispute, manualRefund) is the deployer is
 * refused: settle it before the ceremony (review B-5).
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const {
  roleHolders,
  scanLogs,
  uniq,
  liveTrustedContracts,
} = require("./HandoverScans");

/** The factory, its INVESTOR_ROLE holders and its active investors. */
async function escrowFacts(o) {
  if (!o.escrowWalletFactory) return null;
  const f = await ethers.getContractAt(
    "EscrowWalletFactory",
    await addrOf(o.escrowWalletFactory),
  );
  const [dAddr, ops] = await Promise.all([o.deployer, o.ops].map(addrOf));
  const role = await f.INVESTOR_ROLE();
  const holders = await roleHolders(f, role, o, [dAddr]);
  const regs = uniq(
    (await scanLogs(f, f.filters.InvestorRegistered(), o)).map(
      (ev) => ev.args[0],
    ),
  );
  const active = [];
  for (const a of uniq([...regs, dAddr])) {
    if ((await f.getInvestorProfile(a)).isActive) active.push(a);
  }
  // R-413-6: every registration emits InvestorRegistered.
  if (active.some((a) => !regs.some((r) => same(r, a)))) {
    fail(
      `EscrowWalletFactory InvestorRegistered event scan found none of the holders it must see (${dAddr}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  const fee = [ops, ...(await Promise.all((o.feeWallets || []).map(addrOf)))];
  return { f, dAddr, ops, role, holders, active, fee };
}

const has = (xs, a) => xs.some((x) => same(x, a));

/** Trusted contracts whose investor() is the deployer (escrows). */
async function deployerArbitrates(o, dAddr) {
  const out = [];
  for (const { account } of await liveTrustedContracts(o)) {
    if (out.some((a) => same(a, account))) continue;
    if ((await ethers.provider.getCode(account)) === "0x") continue;
    const w = await ethers.getContractAt(
      ["function investor() view returns (address)"],
      account,
    );
    let investor;
    try {
      investor = await w.investor();
    } catch (e) {
      // No investor(): not an escrow (a revert or undecodable data).
      const none =
        e.code === "CALL_EXCEPTION" ||
        e.code === "BAD_DATA" ||
        /revert/i.test(e.message);
      if (none) continue;
      throw e;
    }
    if (same(investor, dAddr)) out.push(account);
  }
  return out;
}

/** [{ label, ok, fix }]; `pre`: before step 5, the deployer's are allowed. */
async function escrowChecks(o, pre) {
  const e = await escrowFacts(o);
  if (!e) return [];
  const { f, dAddr, holders, active, fee } = e;
  const bare = holders.filter((a) => !has(active, a) && !same(a, dAddr));
  const dHolds = has(holders, dAddr) || has(active, dAddr);
  const manages =
    (await f.hasRole(await f.ADMIN_ROLE(), dAddr)) &&
    (await f.hasRole(await f.DEFAULT_ADMIN_ROLE(), dAddr));
  const wallet = await f.ownerWallet();
  const feeOk = same(wallet, dAddr)
    ? pre && same(await f.owner(), dAddr)
    : has(fee, wallet);
  const arbitrated = await deployerArbitrates(o, dAddr);
  return [
    {
      label: `no escrow ComplianceRules trusts is arbitrated by the deployer`,
      ok: arbitrated.length === 0,
      fix: arbitrated
        .map(
          (x) =>
            `the deployer arbitrates escrow ${x}: settle it before the ceremony (as investor it signs releases and refunds and resolves disputes of an escrow ComplianceRules trusts on VSC)`,
        )
        .join("; "),
    },
    {
      label: `EscrowWalletFactory INVESTOR_ROLE held only by active registered investors (${active.length})`,
      ok: bare.length === 0,
      fix: `EscrowWalletFactory INVESTOR_ROLE held by ${bare.join(", ")} without an active registration: a stray grant; revokeRole(INVESTOR_ROLE, ...) first`,
    },
    {
      label: pre
        ? "the deployer's EscrowWalletFactory investor role, if any, is one step 5 can remove"
        : "deployer holds no EscrowWalletFactory INVESTOR_ROLE and no active registration",
      ok: !dHolds || (pre && manages),
      fix: `the deployer ${dAddr} holds EscrowWalletFactory INVESTOR_ROLE or an active registration${pre ? " but no longer manages the factory" : ""}: it creates escrows ComplianceRules trusts on VSC and signs their releases; ${pre ? "governance must deactivateInvestor(deployer) by vote first" : "deactivateInvestor(deployer)"}`,
    },
    {
      label: `EscrowWalletFactory fee wallet ${wallet} is ops or listed in feeWallets, never the deployer (D54)${pre ? "; the deployer's moves to ops in step 5" : ""}`,
      ok: feeOk,
      fix: `EscrowWalletFactory ownerWallet is ${wallet}: platform fees would flow to ${same(wallet, dAddr) ? "the deployer" : "a key the ceremony does not hand over"}; the factory owner must setOwnerWallet(ops) first, or list it in "feeWallets"`,
    },
  ];
}

/** Read-only, before the first transaction. */
async function preflightEscrow(o) {
  for (const c of await escrowChecks(o, true)) if (!c.ok) fail(c.fix);
}

/**
 * Step 5, while the deployer still manages the factory: its registration
 * is deactivated (a bare grant revoked) and a deployer fee wallet moves
 * to ops.
 */
async function escrowSteps({ o, d, ok }) {
  const e = await escrowFacts(o);
  if (!e) return;
  const { f, dAddr, ops, role } = e;
  if ((await f.getInvestorProfile(dAddr)).isActive) {
    await (await f.connect(d).deactivateInvestor(dAddr)).wait();
    ok("deployer's EscrowWalletFactory investor registration deactivated");
  }
  if (await f.hasRole(role, dAddr)) {
    await (await f.connect(d).revokeRole(role, dAddr)).wait();
    ok("deployer's EscrowWalletFactory INVESTOR_ROLE revoked");
  }
  if (await f.hasRole(role, dAddr))
    fail("deployer still holds EscrowWalletFactory INVESTOR_ROLE");
  if (same(await f.ownerWallet(), dAddr)) {
    await (await f.connect(d).setOwnerWallet(ops)).wait();
    if (!same(await f.ownerWallet(), ops))
      fail("EscrowWalletFactory ownerWallet did not move to ops");
    ok(`EscrowWalletFactory fee wallet: ops ${ops} (D54)`);
  }
}

/** Completion lines: [label, pass][]. */
async function escrowLines(o) {
  return (await escrowChecks(o, false)).map((c) => [c.label, c.ok]);
}

module.exports = { preflightEscrow, escrowSteps, escrowLines };
