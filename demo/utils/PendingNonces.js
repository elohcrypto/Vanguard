/**
 * @fileoverview Task 5.17 slice C (deep review M-3): never race a run's
 * own transactions still in the mempool.
 *
 * The ceremony and post-ceremony CLIs decide what to send from state read
 * at `latest` (an open proposal to adopt, a vote already cast) and pin
 * each nonce from `pending`. A re-run started while the killed run's last
 * createProposal or castVote is still unmined (a 12 s window after every
 * send on Sepolia) sees neither: it proposed a second identical proposal
 * (the orphan stays Active, its creation fee locked) or sent a fresh
 * approve and then failed castVote "Already voted". So before reading
 * what to send, every sender's pending nonce must equal its mined one:
 * `awaitSettledNonces` waits for that, bounded, and refuses after the
 * timeout naming each sender still pending.
 */

const { ethers } = require("hardhat");

/** Seconds to wait (HANDOVER_PENDING_WAIT_S, default 900: 75 Sepolia blocks). */
const waitSeconds = () => Number(process.env.HANDOVER_PENDING_WAIT_S || 900);

/** [{ address, pending, latest }] for each of `addresses` with pending > latest. */
async function inFlight(addresses) {
  const out = [];
  for (const a of addresses) {
    const count = async (tag) =>
      Number(await ethers.provider.send("eth_getTransactionCount", [a, tag]));
    const latest = await count("latest");
    const pending = await count("pending");
    if (pending > latest) out.push({ address: a, pending, latest });
  }
  return out;
}

/**
 * Wait until no sender in `senders` (signers or addresses) has a
 * transaction pending; throws after `timeoutS` naming those still pending.
 * `what` says which step waits (in the log line and the error).
 */
async function awaitSettledNonces(senders, what, opts = {}) {
  const log = opts.log ?? console.log;
  const timeoutS = opts.timeoutS ?? waitSeconds();
  const pollMs = opts.pollMs ?? 2000;
  const addresses = [];
  for (const s of senders) {
    if (!s) continue;
    const a = ethers.getAddress(
      typeof s === "string" ? s : await s.getAddress(),
    );
    if (!addresses.includes(a)) addresses.push(a);
  }
  const t0 = Date.now();
  let told = false;
  for (;;) {
    const busy = await inFlight(addresses);
    if (!busy.length) return;
    const list = busy
      .map((b) => `${b.address} (nonce ${b.latest}..${b.pending - 1})`)
      .join(", ");
    if ((Date.now() - t0) / 1000 >= timeoutS) {
      throw new Error(
        `${what}: transactions still pending after ${timeoutS} s from ${list}; refusing to read the chain and send beside them (a re-run would duplicate them). Stuck at too low a fee? The production signer sends each again with higher fees: ${busy.map((b) => `node scripts/production/signer.js bump ${b.address} ${b.latest} [port]`).join("; ")}; then re-run`,
      );
    }
    if (!told) {
      log(
        `   ⏳ ${what}: waiting for pending transactions to mine first: ${list} (up to ${timeoutS} s)`,
      );
      told = true;
    }
    await new Promise((ok) => setTimeout(ok, pollMs));
  }
}

module.exports = { awaitSettledNonces, inFlight };
