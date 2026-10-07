/**
 * @fileoverview Escrow option 73: the complete workflow, no prompts
 * @module EscrowWorkflowFlow
 * @description Runs the escrow sequence the escrow smoke performs, through
 * the module's own options: 62 register the investor, 63 create an escrow,
 * 64 fund it, 65 submit the shipment proof, 73b close the dispute window
 * (dev node only), 68 the payee signs, 69 the investor releases, 71 the
 * status. Each prompt is answered from the list the option prints (the
 * answer is shown with 🤖); each step's verdict is a chain read (isInvestor,
 * amount, funded, shipmentProof, block time, getWalletStatus). A step that
 * does not hold stops the run with a counted summary (plan v2 Task 4.8).
 */

"use strict";

const { ethers } = require("hardhat");
const { displaySection, displaySuccess } = require("./DisplayHelpers");
const { canJumpTime } = require("./ChainTime");

/** Escrow amount in VSC; the payer pays it plus 5% fees. */
const AMOUNT = "10";
const STEPS = 8;
const STATES = ["Active", "Released", "Refunded", "Disputed"];

/** The index of the first printed "N. text" line whose text matches. */
function pick(lines, match) {
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\. (.*)$/);
    if (m && match(m[2])) return m[1];
  }
  return null;
}

/** Answers for the prompts of options 62-71, from what they print. */
function answerer(ctx) {
  return (q, lines) => {
    if (/Select investor/.test(q))
      return pick(lines, (t) => t.includes(ctx.investor));
    if (/Select payer/.test(q))
      return pick(lines, (t) => t.includes(ctx.payer.slice(0, 10)));
    if (/Select payee/.test(q))
      return pick(lines, (t) => t.includes(ctx.payee.slice(0, 10)));
    if (/payment amount/.test(q)) return AMOUNT;
    if (/Select wallet/.test(q))
      return pick(lines, (t) => t.startsWith(`Payment ID ${ctx.paymentId} `));
    if (/time travel\?/.test(q)) return "y";
    if (/Investor decision/.test(q)) return "1";
    return null;
  };
}

/**
 * Run `fn` with mod.promptUser answered by `answer(question, lines printed
 * since the last question)`. Output still reaches the screen.
 */
async function scripted(mod, answer, fn) {
  const realPrompt = mod.promptUser;
  const realLog = console.log;
  let lines = [];
  console.log = (...a) => {
    lines.push(a.join(" "));
    realLog(...a);
  };
  mod.promptUser = async (q) => {
    const a = answer(q, lines);
    lines = [];
    realLog(`   🤖 ${q.trim()} ${a === null ? "(no answer)" : a}`);
    if (a === null) throw new Error(`no scripted answer for "${q.trim()}"`);
    return a;
  };
  try {
    return await fn();
  } finally {
    mod.promptUser = realPrompt;
    console.log = realLog;
  }
}

/** Investor, payer and payee for the run, chosen from chain balances. */
async function pickActors(state) {
  const investors = Array.from(state.investors?.values?.() ?? []);
  if (investors.length === 0) return { why: "no investor yet (option 23)" };
  const investor = investors[0].user || investors[0].address;
  const token = state.getContract("digitalToken");
  const users = Array.from(state.normalUsers?.values?.() ?? []).filter(
    (u) => u.tokenEligible && u.address !== investor,
  );
  const need = (ethers.parseEther(AMOUNT) * 105n) / 100n;
  let payer = null;
  let best = -1n;
  for (const u of users) {
    const bal = await token.balanceOf(u.address);
    if (bal >= need && bal > best) [payer, best] = [u.address, bal];
  }
  if (!payer)
    return {
      why: `no compliant user (option 24) holds ${ethers.formatEther(need)} VSC to pay`,
    };
  const payee = users.find((u) => u.address !== payer)?.address;
  if (!payee) return { why: "a second compliant user is needed as payee" };
  return { investor, payer, payee };
}

/** Option 73: run 62 -> 63 -> 64 -> 65 -> 73b -> 68 -> 69 -> 71. */
async function runCompleteWorkflow(mod) {
  displaySection("DEMO: COMPLETE ENHANCED ESCROW WORKFLOW", "🧪");
  console.log(
    "Options 62 -> 63 -> 64 -> 65 -> 73b -> 68 -> 69 -> 71, answered",
  );
  console.log("automatically; every verdict is read from chain.");
  const state = mod.state;
  const factory = state.getContract("escrowFactory");
  if (!factory) {
    console.log("ℹ️  Enhanced Escrow not deployed: run option 61 first");
    return { done: 0 };
  }
  const actors = await pickActors(state);
  if (actors.why) {
    console.log(`ℹ️  Cannot start: ${actors.why}`);
    return { done: 0 };
  }
  const ctx = { ...actors, paymentId: null };
  const answer = answerer(ctx);
  console.log(`   Investor ${ctx.investor}`);
  console.log(`   Payer ${ctx.payer}, payee ${ctx.payee}, ${AMOUNT} VSC`);

  let done = 0;
  let wallet = null;
  const stop = (step, why) => {
    console.log(`\n❌ Option 73 stopped at step ${done + 1} (${step}): ${why}`);
    console.log(`📊 Option 73: ${done} of ${STEPS} steps done (chain)`);
    return { done, paymentId: ctx.paymentId };
  };
  const ok = (step, fact) => {
    done++;
    console.log(`\n✅ Step ${done}/${STEPS} ${step}: ${fact} (chain)`);
  };

  // 62. Register the investor, unless the demo already did.
  if (!state.registeredInvestors?.has(ctx.investor)) {
    await scripted(mod, answer, () => mod.registerInvestor());
  }
  if (!(await factory.isInvestor(ctx.investor)))
    return stop("62 register", "factory.isInvestor is false");
  ok("62 register", "factory.isInvestor true");

  // 63. Create the escrow; the new record is the one the run follows.
  const before = new Set(state.enhancedEscrowWallets?.keys?.() ?? []);
  await scripted(mod, answer, () => mod.createEscrowWallet());
  const created = Array.from(state.enhancedEscrowWallets?.entries?.() ?? [])
    .filter(([k]) => !before.has(k))
    .map(([, w]) => w);
  if (created.length !== 1) return stop("63 create", "no new escrow recorded");
  ctx.paymentId = created[0].paymentId;
  wallet = await ethers.getContractAt(
    "MultiSigEscrowWallet",
    created[0].walletAddress || created[0].address,
  );
  if ((await wallet.amount()) !== ethers.parseEther(AMOUNT))
    return stop("63 create", "the escrow's amount() is not the amount asked");
  ok("63 create", `escrow #${ctx.paymentId} at ${wallet.target}`);

  // 64. Fund.
  await scripted(mod, answer, () => mod.fundEscrowWallet());
  if (!(await wallet.funded())) return stop("64 fund", "funded() is false");
  ok("64 fund", "funded() true");

  // 65. Shipment proof.
  await scripted(mod, answer, () => mod.submitShipmentProof());
  const proof = await wallet.shipmentProof();
  if (proof.submittedAt === 0n)
    return stop("65 proof", "shipmentProof().submittedAt is 0");
  ok("65 proof", "shipment proof recorded");

  // 73b. Close the dispute window (dev node); elsewhere it closes by itself.
  const closes = proof.submittedAt + (await wallet.DISPUTE_WINDOW());
  if (!(await canJumpTime())) {
    const at = new Date(Number(closes) * 1000).toISOString();
    console.log(`\nℹ️  The dispute window closes at ${at} (chain); this`);
    console.log("   network cannot jump time: run 68, 69 and 71 after it.");
    console.log(`📊 Option 73: ${done} of ${STEPS} steps done (chain)`);
    return { done, paymentId: ctx.paymentId };
  }
  await scripted(mod, answer, () => mod.timeTravel14Days());
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  if (now <= closes) return stop("73b window", "the window is still open");
  ok("73b window", "block time past submittedAt + DISPUTE_WINDOW");

  // 68. Payee signs; 69. investor releases.
  await scripted(mod, answer, () => mod.payeeSignRelease());
  if (!(await wallet.getWalletStatus()).payeeHasSigned)
    return stop("68 payee", "getWalletStatus().payeeHasSigned is false");
  ok("68 payee", "payee signed");
  await scripted(mod, answer, () => mod.investorSignRelease());
  const status = await wallet.getWalletStatus();
  const name = STATES[Number(status.currentState)];
  if (name !== "Released") return stop("69 investor", `state is ${name}`);
  ok("69 investor", "state Released, funds paid to the payee");

  // 71. Status, for the record.
  await scripted(mod, answer, () => mod.viewEscrowStatus());
  ok("71 status", `escrow #${ctx.paymentId} ${name}`);
  displaySuccess(`Option 73: ${done} of ${STEPS} steps done (chain)`);
  return { done, paymentId: ctx.paymentId };
}

module.exports = { runCompleteWorkflow, pick, answerer };
