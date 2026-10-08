/**
 * @fileoverview Recovery as the defence against a rogue MANAGEMENT key and
 * a stolen owner key (plan v2 Task 4.11, D38 = c): option 12's recovery part
 * (no prompts, a drill identity) and option 5 -> 2 (the selected identity).
 *
 * A rogue MANAGEMENT key is planted (a fresh key whose wallet nobody uses:
 * it stands for a stolen key). The owner sets up two agents; one opens a
 * candidate for the recovered wallet's key and both approve. From that
 * approval the rogue key and the owner cannot cancel, re-seat or withdraw
 * KeyManager (each refusal is read from the chain). RECOVERY_TIMELOCK
 * (48h) after the approval the candidate executes: every other MANAGEMENT
 * key is evicted. OWNER_TRANSFER_TIMELOCK (7 days) after the approval the
 * recovered wallet is proposed as owner and accepts. On a dev node the
 * flow jumps each timelock; elsewhere it prints when the step opens and the
 * option to come back to (same session: `run` keeps the drill's keys).
 */

const { ethers } = require("hardhat");
const { keyOf, who, same, passTimelock } = require("./KeyLifecycleFlow");

const MANAGEMENT = 1;
const short = (k) => `${k.slice(0, 10)}…${k.slice(-6)}`;
const now = async () =>
  BigInt((await ethers.provider.getBlock("latest")).timestamp);

/** The revert reason of `fn(args)` sent by `from`, or null if accepted. */
async function refusal(contract, fn, args, from) {
  const data = contract.interface.encodeFunctionData(fn, args);
  try {
    await ethers.provider.call({ from, to: await contract.getAddress(), data });
    return null;
  } catch (e) {
    const raw = e.data ?? e.error?.data ?? e.info?.error?.data;
    if (!e.reason && typeof raw === "string" && raw.length > 2) {
      try {
        return contract.interface.parseError(raw).name;
      } catch {
        /* fall through */
      }
    }
    const why = (e.reason ?? e.shortMessage ?? String(e.message)).split(
      "\n",
    )[0];
    const m = /reverted with (?:reason string|custom error) '(.*)'$/.exec(why);
    return m ? m[1] : why;
  }
}

/** Prints an expected refusal (⛔) or a real failure (❌); true if refused. */
async function expectRefused(label, contract, fn, args, from) {
  const why = await refusal(contract, fn, args, from);
  if (why) console.log(`   ⛔ ${label}: refused (${why})`);
  else console.log(`   ❌ ${label}: ACCEPTED, recovery is not protected`);
  return Boolean(why);
}

/** The drill identity: `run.identity`, `opts.identity`, or a new OnchainID. */
async function drillIdentity(state, owner, opts, run) {
  if (!run.identity && opts.identity) run.identity = opts.identity;
  if (!run.identity) {
    const F = await ethers.getContractFactory("OnchainID", owner);
    const id = await F.deploy(owner.address);
    await id.waitForDeployment();
    run.identity = await id.getAddress();
    console.log(
      `   🆔 Drill identity ${run.identity}, owner ${who(state, owner.address)} (deployed for the drill, not in the registry)`,
    );
  }
  return (await ethers.getContractAt("OnchainID", run.identity)).connect(owner);
}

/**
 * Owner steps: pin KeyManager as the recovery manager (once), authorize it,
 * plant the rogue key, seat the agents. A re-seat of seated agents waits
 * 48h (R-411-16): jumped on a dev node, else printed. False: not ready.
 */
async function prepare(state, km, id, owner, agents, run, back) {
  const kmAddr = await km.getAddress();
  const pinned = await id.recoveryManager();
  if (pinned === ethers.ZeroAddress) {
    await (await id.pinRecoveryManager(kmAddr)).wait();
    console.log(
      `   📌 pinRecoveryManager(KeyManager) by the owner (once, never changeable)`,
    );
  } else if (!same(pinned, kmAddr)) {
    console.log(
      `   ❌ recoveryManager() is ${pinned}, not this KeyManager: no recovery here`,
    );
    return false;
  }
  console.log(
    `   📌 recoveryManager() = KeyManager ${await id.recoveryManager()}`,
  );
  if (!(await id.authorizedManagers(kmAddr))) {
    await (await id.authorizeManager(kmAddr)).wait();
    console.log(`   ✅ authorizeManager(KeyManager ${kmAddr}) by the owner`);
  }
  if (!run.rogue) {
    run.rogue = ethers.Wallet.createRandom().address;
    await (await id.addKey(keyOf(run.rogue), MANAGEMENT, 1)).wait();
    console.log(
      `   😈 Rogue MANAGEMENT key planted: ${short(keyOf(run.rogue))} (wallet ${run.rogue}, stands for a stolen key)`,
    );
  }
  const list = agents.map((a) => a.address);
  const rec = await km.getKeyRecovery(run.identity);
  const seated =
    rec.recoveryAgents.join() === list.join() && rec.threshold === 2n;
  if (seated && !rec.completed) {
    console.log(`   🛡️  agents already seated (2-of-2):`);
  } else {
    let p = await km.getPendingRecoverySetup(run.identity);
    if (p.effectiveAt === 0n || p.agents.join() !== list.join()) {
      await (
        await km.connect(owner).setupKeyRecovery(run.identity, list, 2)
      ).wait();
      p = await km.getPendingRecoverySetup(run.identity);
    }
    if (p.effectiveAt > 0n) {
      console.log(
        "   ⏳ setupKeyRecovery re-seats seated agents: pending 48h,",
      );
      console.log("      the seated agents may veto it (R-411-16)");
      if (!(await passTimelock(p.effectiveAt, "re-seat timelock (48h)", back)))
        return false;
      await (
        await km.connect(owner).applyKeyRecoverySetup(run.identity)
      ).wait();
      console.log("   ✅ applyKeyRecoverySetup: the new agents are seated");
    }
    console.log(`   🛡️  setupKeyRecovery by the owner: 2-of-2 agents`);
  }
  for (const a of list) console.log(`      agent ${who(state, a)}`);
  return true;
}

/** Opens (if needed) and approves the candidate; returns the approval. */
async function approve(state, km, agents, run) {
  const idAddr = run.identity;
  let c = await km.getRecoveryCandidate(idAddr, run.key);
  if (c.initiatedAt === 0n) {
    await (
      await km.connect(agents[0]).initiateKeyRecovery(idAddr, run.key)
    ).wait();
    console.log(
      `   🚨 initiateKeyRecovery by ${who(state, agents[0].address)}: key ${short(run.key)}`,
    );
  }
  for (const a of agents) {
    if (await km.hasApprovedRecovery(idAddr, run.key, a.address)) continue;
    const rc = await (
      await km.connect(a).approveKeyRecovery(idAddr, run.key)
    ).wait();
    console.log(`   👍 approveKeyRecovery by ${who(state, a.address)}`);
    for (const log of rc.logs) {
      const ev = km.interface.parseLog(log);
      if (ev?.name !== "KeyRecoveryApproved") continue;
      const at = (t) => new Date(Number(t) * 1000).toISOString();
      console.log(`   🔒 KeyRecoveryApproved (receipt): execution from`);
      console.log(`      ${at(ev.args.executionTime)} (48h), owner transfer`);
      console.log(`      from ${at(ev.args.ownerTransferTime)} (7 days)`);
    }
  }
  return km.getRecoveryApproval(idAddr);
}

/** The refusals an approved recovery stands against (chain answers). */
async function showRefusals(km, id, owner, run) {
  const idAddr = run.identity;
  const out = [];
  console.log("   Who can stop it now (each asked of the chain):");
  const ask = async (label, c, fn, args, from) =>
    out.push(await expectRefused(label, c, fn, args, from));
  await ask(
    "rogue key cancels",
    km,
    "cancelKeyRecovery",
    [idAddr, run.key],
    run.rogue,
  );
  await ask(
    "rogue key re-seats the agents",
    km,
    "setupKeyRecovery",
    [idAddr, [run.rogue], 1],
    run.rogue,
  );
  await ask(
    "owner cancels",
    km,
    "cancelKeyRecovery",
    [idAddr, run.key],
    owner.address,
  );
  await ask(
    "owner re-seats the agents",
    km,
    "setupKeyRecovery",
    [idAddr, [owner.address], 1],
    owner.address,
  );
  await ask(
    "owner withdraws KeyManager",
    id,
    "deauthorizeManager",
    [await km.getAddress()],
    owner.address,
  );
  return out.every(Boolean);
}

/**
 * Runs (or resumes) the drill. opts: { km, owner, recovered, agents (2),
 * back, run (persisted), identity? }. Returns { done, ... } with the facts.
 */
async function runRecoveryDrill(state, opts) {
  const { km, owner, recovered, agents, back } = opts;
  const run = opts.run;
  run.key = keyOf(recovered.address);
  const id = await drillIdentity(state, owner, opts, run);
  const idAddr = run.identity;
  const rec = await km.getKeyRecovery(idAddr);
  const executed = rec.completed && rec.lastKey === run.key;
  let a = await km.getRecoveryApproval(idAddr);
  if (!executed && !(a.key === run.key && a.locked)) {
    if (!(await prepare(state, km, id, owner, agents, run, back)))
      return { ...run, done: false, executed: false };
    a = await approve(state, km, agents, run);
  }
  if (!executed) {
    run.refused = await showRefusals(km, id, owner, run);
    if ((await now()) < a.executionTime)
      await expectRefused(
        "execution before 48h",
        km,
        "executeKeyRecovery",
        [idAddr, run.key],
        agents[0].address,
      );
    if (!(await passTimelock(a.executionTime, "recovery timelock (48h)", back)))
      return { ...run, done: false, executed: false };
    const rc = await (
      await km.connect(agents[0]).executeKeyRecovery(idAddr, run.key)
    ).wait();
    run.evicted = [];
    for (const log of rc.logs) {
      const ev = km.interface.parseLog(log);
      if (ev?.name === "KeyRecoveryKeyEvicted") run.evicted.push(ev.args[1]);
    }
    console.log(
      `   ✅ executeKeyRecovery (receipt): ${run.evicted.length} MANAGEMENT keys evicted`,
    );
    for (const k of run.evicted) {
      const tag =
        k === keyOf(run.rogue)
          ? "rogue"
          : k === keyOf(owner.address)
            ? "the owner's key"
            : "other";
      console.log(`      🧹 ${short(k)} (${tag})`);
    }
  }
  const mgmt = await id.getKeysByPurpose(MANAGEMENT);
  run.rogueGone = !(await id.keyHasPurpose(keyOf(run.rogue), MANAGEMENT));
  run.onlyRecovered = mgmt.length === 1 && mgmt[0] === run.key;
  console.log(
    `   ${run.rogueGone ? "✅" : "❌"} keyHasPurpose(rogue, MANAGEMENT) = ${!run.rogueGone}; MANAGEMENT keys now: ${mgmt.map(short).join(", ")}`,
  );
  return moveOwner(state, km, id, owner, recovered, agents, back, run);
}

/** The second timelock: propose the recovered wallet, which accepts. */
async function moveOwner(state, km, id, owner, recovered, agents, back, run) {
  const idAddr = run.identity;
  if (!same(await id.owner(), recovered.address)) {
    const a = await km.getRecoveryApproval(idAddr);
    if ((await now()) < a.ownerTransferTime)
      await expectRefused(
        "owner transfer before 7 days",
        km,
        "executeOwnerTransfer",
        [idAddr, recovered.address],
        agents[0].address,
      );
    if (
      !(await passTimelock(
        a.ownerTransferTime,
        "owner-transfer timelock (7 days)",
        back,
      ))
    )
      return { ...run, done: false, executed: true, ownerMoved: false };
    await (
      await km
        .connect(agents[0])
        .executeOwnerTransfer(idAddr, recovered.address)
    ).wait();
    console.log(
      `   📨 executeOwnerTransfer: pendingOwner() = ${who(state, await id.pendingOwner())}`,
    );
    run.oldOwnerRefused = await expectRefused(
      "the old owner accepts",
      id,
      "acceptOwnership",
      [],
      owner.address,
    );
    await (await id.connect(recovered).acceptOwnership()).wait();
  }
  run.ownerMoved = same(await id.owner(), recovered.address);
  console.log(
    `   ${run.ownerMoved ? "✅" : "❌"} owner() = ${who(state, await id.owner())}`,
  );
  run.oldOwnerLocked = await expectRefused(
    "the old owner re-transfers",
    id,
    "transferOwnership",
    [owner.address],
    owner.address,
  );
  return { ...run, done: run.ownerMoved, executed: true };
}

module.exports = { runRecoveryDrill, refusal };
