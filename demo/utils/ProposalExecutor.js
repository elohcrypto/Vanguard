/**
 * @fileoverview Option 78's sender (plan v2 Task 5.6b). executeProposal
 * is permissionless, and the ceremony attributes a node to the sender of
 * its registering transaction (HandoverNodes.nodeFacts, D50), so a voted
 * registration executed by wallet 0 reads "registered by the deployer".
 * Option 78 therefore executes from the proposal's proposer, else from a
 * wallet that voted on it, when the demo holds that key; after the
 * ceremony (governance owns VSC) never from wallet 0, the deployer, which
 * sends nothing once the ceremony is over (runbook section 5). Only when
 * no proposer or voter key qualifies does it ask for a wallet index, so
 * a drive's `78:<id>:y` still answers every prompt. The VoteCast lookup
 * reads in chunks (HandoverScans.scanLogs, the ceremony's logChunk).
 *
 * Option 76 (round 2, R-56-5): before the ceremony wallet 0 may propose;
 * after it the first eligible wallet but 0 proposes (deployerBarred), and
 * a flow with no eligible wallet asks (askWallet refuses 0).
 */

const { ethers } = require("hardhat");
const { scanLogs } = require("./HandoverScans");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const OWNER_ABI = ["function owner() view returns (address)"];

/** True once governance owns VSC (TokenParameters' bound target). */
async function ceremonyDone(gov) {
  const vsc = await gov.boundTarget(3).catch(() => ethers.ZeroAddress);
  if (same(vsc, ethers.ZeroAddress)) return false;
  const t = await ethers.getContractAt(OWNER_ABI, vsc);
  return same(
    await t.owner().catch(() => ethers.ZeroAddress),
    await gov.getAddress(),
  );
}

/**
 * { signer, why } to execute proposal `id` from, or { refused } when
 * the operator names no usable wallet.
 */
async function executorFor(mod, gov, id) {
  const signers = mod.state.signers || [];
  const deployer = signers[0];
  const after = await ceremonyDone(gov);
  const ours = (a) => signers.find((s) => same(s.address, a));
  const usable = (s) =>
    Boolean(s) && !(after && deployer && same(s.address, deployer.address));
  const [p] = await gov.getProposal(id);
  const proposer = ours(p.proposer);
  if (usable(proposer)) return { signer: proposer, why: "the proposer" };
  const scope = {
    fromBlock: mod.state.deployStartBlock || 0,
    logChunk: mod.state.logChunk,
  };
  for (const ev of await scanLogs(gov, gov.filters.VoteCast(id), scope)) {
    const v = ours(ev.args.voter);
    if (usable(v)) return { signer: v, why: "a voter on it" };
  }
  if (!after && deployer) {
    return { signer: deployer, why: "wallet 0, before the ceremony" };
  }
  return askWallet(mod.promptUser, signers, "Execute");
}

/** Prompt for a wallet index, refusing 0 (the deployer). */
async function askWallet(prompt, signers, verb) {
  const ans = await prompt(
    `${verb} from wallet index (not 0: the deployer sends nothing after the ceremony): `,
  );
  const i = Number(ans);
  if (!Number.isInteger(i) || i < 1 || !signers[i]) {
    return {
      refused: `wallet "${ans}" is not a wallet index 1-${signers.length - 1}`,
    };
  }
  return { signer: signers[i], why: `wallet ${i}` };
}

/** True when wallet 0 may not send: the ceremony is over (R-56-5). */
async function deployerBarred(state) {
  const gov = state.getContract("vanguardGovernance");
  return Boolean(gov) && (await ceremonyDone(gov));
}

module.exports = { executorFor, ceremonyDone, askWallet, deployerBarred };
