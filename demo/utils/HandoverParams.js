/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13 (B G-8/G-9, A2 M-B,
 * D54): parameter floors, open proposals, the OnchainIDFactory fee sink,
 * the PrivacyManager attestors and root, the demo identity's pending
 * re-seat, and the code pins of the plan contracts.
 *
 * Governance: minVoterAge at least 7 days (scaled by TIME_SCALE; the
 * setter's own floor is 1 day), both costs above zero, and no Pending,
 * Active or Approved proposal targeting a plan contract (direct reads,
 * 1..proposalCount). Factory: feeRecipient must be the deployer (before
 * step 5, which sets ops) or ops, and deployment not paused.
 * PrivacyManager: every live trusted attestor must be acknowledged in
 * `attestors` (its Ax); the scan is proven by trustedAttestorCount per
 * circuit; the current root's last publisher must be the deployer (a
 * residual warning, HandoverPrivacy.js: the only publisher before the
 * ceremony), ops or governance, proven against whitelistVersion
 * (R-413-8). The demo identity may have no pending re-seat and no
 * pending owner. Investor-type cooldowns and caps are reported.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");
const { planFor } = require("./HandoverChecks");
const {
  pinChecks,
  codeHashLabel,
  codeHashRefusal,
} = require("./HandoverCodeHash");

const ZERO = ethers.ZeroAddress;
const OPEN = [0, 1, 2]; // Pending, Active, Approved
const CIRCUITS = [
  ["jurisdiction", ethers.id("JURISDICTION_PROOF")],
  ["accreditation", ethers.id("ACCREDITATION_PROOF")],
  ["compliance", ethers.id("COMPLIANCE_AGGREGATION")],
];
const TYPES = ["Normal", "Retail", "Accredited", "Institutional"];
const attestorId = (ax, ay) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [ax, ay]),
  );

/** Governance floors and open proposals: [{ label, ok, fix }]. */
async function governanceChecks(o) {
  const g = o.governance;
  const scale = await g.TIME_SCALE();
  const floor = (7n * 86400n) / scale;
  const age = await g.minVoterAge();
  const [pc, vc] = [await g.proposalCreationCost(), await g.votingCost()];
  // Review D2-3: the code pin masks TIME_SCALE (an immutable).
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const out = [
    {
      label: `governance TIME_SCALE ${scale} on chain ${chainId} (above 1 only on the dev chain 31337)`,
      ok: scale === 1n || chainId === 31337n,
      fix: `governance TIME_SCALE is ${scale} on chain ${chainId}: every governance window is ${scale} times shorter than the mainnet schedule; off the dev chain 31337 only TIME_SCALE 1 is accepted: redeploy governance with TIME_SCALE 1`,
    },
    {
      label: `governance minVoterAge ${age}s is at least 7 days / TIME_SCALE (${floor}s)`,
      ok: age >= floor,
      fix: `governance minVoterAge is ${age}s, below 7 days / TIME_SCALE (${floor}s): identities registered just before a vote would count (D25); the governance owner must setMinVoterAge(${floor}) first`,
    },
    {
      label: `governance costs are above zero (proposal ${ethers.formatEther(pc)} VGT, vote ${ethers.formatEther(vc)} VGT)`,
      ok: pc > 0n && vc > 0n,
      fix: "governance proposalCreationCost or votingCost is zero: free proposals and votes; the owner must set both first",
    },
  ];
  const plan = [];
  for (const e of planFor(o)) plan.push([await addrOf(o[e.key]), e.label]);
  const open = [];
  const n = Number(await g.proposalCount());
  for (let id = 1; id <= n; id++) {
    const [p] = await g.getProposal(id);
    if (!OPEN.includes(Number(p.status))) continue;
    const hit = plan.find(([a]) => same(a, p.target));
    if (hit) open.push(`#${id} "${p.title}" -> ${hit[1]}`);
  }
  out.push({
    label: `no open governance proposal targets a plan contract (${n} proposals)`,
    ok: open.length === 0,
    fix: `open governance proposal(s) ${open.join(", ")}: a proposal created before the handover could execute against a contract governance now owns; settle (execute, let it settle and refund, or cancel) them first`,
  });
  return out;
}

/** OnchainIDFactory fee sink and pause: [{ label, ok, fix }]. */
async function factoryChecks(o, pre) {
  const f = o.onchainIDFactory;
  if (!f) return [];
  const [dAddr, ops] = await Promise.all([o.deployer, o.ops].map(addrOf));
  const to = await f.feeRecipient();
  const allowed = pre ? [dAddr, ops] : [ops];
  return [
    {
      label: `OnchainIDFactory feeRecipient is ops ${ops} (D54)${pre ? " or the deployer until step 5" : ""}`,
      ok: allowed.some((a) => same(a, to)),
      fix: `OnchainIDFactory feeRecipient is ${to}, not ${pre ? "the deployer or " : ""}ops: identity fees would flow to a key the ceremony does not hand over; the factory owner must setFeeRecipient(ops) first`,
    },
    {
      label: "OnchainIDFactory deployment is not paused",
      ok: !(await f.deploymentPaused()),
      fix: "OnchainIDFactory deployment is paused: no identity can be created; the factory owner must setDeploymentPaused(false) first",
    },
  ];
}

/**
 * PrivacyManager attestors and root: [{ label, ok, fix }]. A live
 * attestor not in `attestors` fails; a root last published by anyone but
 * the deployer, ops or governance fails.
 */
async function privacyChecks(o) {
  const pm = o.privacyManager;
  if (!pm) return [];
  const [dAddr, ops, govAddr] = await Promise.all(
    [o.deployer, o.ops, o.governance].map(addrOf),
  );
  const ack = (o.attestors || []).map((x) => BigInt(x));
  const evs = await scanLogs(pm, pm.filters.TrustedAttestorSet(), o);
  const last = new Map();
  for (const e of evs) last.set(`${e.args.circuitId}:${e.args.attestor}`, e);
  const live = [];
  for (const e of last.values()) {
    if (await pm.trustedAttestor(e.args.circuitId, e.args.attestor))
      live.push(e);
  }
  const out = [];
  let counted = 0n;
  for (const [, id] of CIRCUITS) counted += await pm.trustedAttestorCount(id);
  out.push({
    label: `PrivacyManager TrustedAttestorSet scan matches trustedAttestorCount (${counted})`,
    ok: BigInt(live.length) === counted,
    fix: `PrivacyManager TrustedAttestorSet event scan found ${live.length} live attestor(s) while trustedAttestorCount sums to ${counted}: fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
  });
  const unack = live.filter((e) => !ack.includes(BigInt(e.args.ax)));
  out.push({
    label: `every trusted attestor is acknowledged in attestors (${live.length} live, ${ack.length} acknowledged)`,
    ok: unack.length === 0,
    fix: `PrivacyManager trusts attestor key(s) ${unack.map((e) => `Ax ${e.args.ax} for ${CIRCUITS.find(([, id]) => id === e.args.circuitId)?.[0] || e.args.circuitId}`).join(", ")} that the config does not acknowledge in "attestors": that key vouches for every private attestation; acknowledge it, or the PrivacyManager owner must setTrustedAttestor(circuit, Ax, Ay, false) first`,
  });
  const version = await pm.whitelistVersion();
  const roots = await scanLogs(pm, pm.filters.WhitelistRootPublished(), o);
  const current = roots.find((r) => r.args.version === version);
  out.push({
    label: `PrivacyManager WhitelistRootPublished scan reaches the current version (${version})`,
    ok: version === 0n || Boolean(current),
    fix: `PrivacyManager whitelistVersion is ${version} but the WhitelistRootPublished scan found no publication of it: fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
  });
  const pub = current && current.args.publisher;
  out.push({
    label:
      "the current whitelist root was published by the deployer (warned), ops or governance",
    ok: !pub || [dAddr, ops, govAddr].some((a) => same(a, pub)),
    fix: `the current whitelist root (version ${version}) was published by ${pub}, neither the deployer, ops nor governance: a key the ceremony does not hand over vouches for every private whitelist binding; ops must republish the root after the handover (it cannot be refused now) and the PrivacyManager owner must setListOperator off that key first`,
  });
  return out;
}

/** The demo identity's pending re-seat and pending owner (A2 M-B). */
async function identityChecks(o) {
  if (!o.keyManagerIdentity || !o.keyManager) return [];
  const id = await addrOf(o.keyManagerIdentity);
  const km = await ethers.getContractAt(
    "KeyManager",
    await addrOf(o.keyManager),
  );
  const [, , effectiveAt] = await km.getPendingRecoverySetup(id);
  const idc = await ethers.getContractAt(
    [
      "function pendingOwner() view returns (address)",
      "function owner() view returns (address)",
    ],
    id,
  );
  const pending = await idc.pendingOwner().catch(() => ZERO);
  // Review R2-2 (Task 4.17): a timelocked rotation or recovery set up
  // before the preflight fires in the window with no deployer transaction.
  const rotations = [];
  for (const ev of await scanLogs(km, km.filters.KeyRotationInitiated(id), o)) {
    const [, oldKey, newKey, purpose] = ev.args;
    const rid = ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bytes32", "uint256"],
      [id, oldKey, newKey, purpose],
    );
    const r = await km.keyRotations(id, rid);
    if (r.initiatedAt > 0n && !r.completed) rotations.push(rid);
  }
  const rec = await km.getKeyRecovery(id);
  const approval = await km.getRecoveryApproval(id);
  const ownerKey = ethers.solidityPackedKeccak256(
    ["address"],
    [await idc.owner().catch(() => ZERO)],
  );
  const recovering =
    (rec.lastKey !== ethers.ZeroHash && !rec.completed) ||
    (approval.key !== ethers.ZeroHash && approval.key !== ownerKey);
  return [
    {
      label: `demo identity ${id} has no pending KeyManager rotation or recovery`,
      ok: rotations.length === 0 && !recovering,
      fix: `demo identity ${id} has ${rotations.length ? `pending KeyManager rotation(s) ${rotations.join(", ")}` : "a pending KeyManager recovery or owner transfer"}: a timelocked action anyone executes would land in the voting window with no deployer transaction; its owner must cancel it (cancelKeyRotation, the agents cancelKeyRecovery) or let it complete first`,
    },
    {
      label: `demo identity ${id} has no pending recovery re-seat`,
      ok: effectiveAt === 0n,
      fix: `demo identity ${id} has a pending recovery re-seat (effective at ${effectiveAt}): agents seated by a previous owner would apply after the handover (A2 M-B); its owner must apply or let the agents veto it first`,
    },
    {
      label: `demo identity ${id} has no pending owner`,
      ok: same(pending, ZERO),
      fix: `demo identity ${id} has pending owner ${pending}: a nomination that would outlive the handover; its owner must cancel it (transferOwnership(0)) or the nominee must accept first`,
    },
  ];
}

/** L-5: validity and cache periods, the factory fee, the claim topics. */
async function periodLines(o) {
  const lines = [];
  if (o.privacyManager) {
    lines.push([
      `PrivacyManager proofValidityPeriod ${await o.privacyManager.proofValidityPeriod()}s`,
      true,
    ]);
  }
  if (o.zkVerifier) {
    const ttl = await o.zkVerifier.proofCacheExpiry().catch(() => null);
    lines.push([
      `ZKVerifierIntegrated proofCacheExpiry ${ttl ?? "?"}s`,
      ttl !== null,
    ]);
  }
  if (o.onchainIDFactory) {
    lines.push([
      `OnchainIDFactory deploymentFee ${ethers.formatEther(await o.onchainIDFactory.deploymentFee())} ETH`,
      true,
    ]);
  }
  const topics = await o.identityRegistry.getClaimTopics();
  lines.push([
    `IdentityRegistry requires claim topics [${topics.join(", ")}] (none would verify everyone)`,
    topics.length > 0,
  ]);
  return lines;
}

/** Informational: investor-type caps and cooldowns per type. */
async function typeLines(o) {
  const reg = o.investorTypeRegistry;
  if (!reg) return [];
  const parts = [];
  for (let t = 0; t < TYPES.length; t++) {
    const c = await reg.getInvestorTypeConfig(t);
    parts.push(
      `${TYPES[t]} ${ethers.formatEther(c.maxTransferAmount)}/${ethers.formatEther(c.maxHoldingAmount)} VSC, cooldown ${c.transferCooldownMinutes} min, tier ${c.requiredWhitelistTier}`,
    );
  }
  return [
    [
      `InvestorTypeRegistry types (transfer/holding cap): ${parts.join("; ")}`,
      true,
    ],
  ];
}

/** Masked code pins of the plan contracts and the issuers. */
async function planPins(o) {
  const names = {
    token: "Token",
    governanceToken: "GovernanceToken",
    identityRegistry: "IdentityRegistry",
    complianceRules: "ComplianceRules",
    oracleManager: "OracleManager",
    dynamicListManager: "DynamicListManager",
    investorTypeRegistry: "InvestorTypeRegistry",
    escrowWalletFactory: "EscrowWalletFactory",
    onchainIDFactory: "OnchainIDFactory",
    governance: "VanguardGovernance",
  };
  const entries = [];
  for (const [key, name] of Object.entries(names)) {
    if (o[key]) entries.push({ label: name, addr: o[key], name });
  }
  for (const issuer of o.issuers || []) {
    entries.push({ label: "ClaimIssuer", addr: issuer, name: "ClaimIssuer" });
  }
  return pinChecks(entries);
}

async function paramChecks(o, pre) {
  return [
    ...(await governanceChecks(o)),
    ...(await factoryChecks(o, pre)),
    ...(await privacyChecks(o)),
    ...(await identityChecks(o)),
  ];
}

/** Read-only, before the first transaction. */
async function preflightParams(o) {
  for (const c of await paramChecks(o, true)) if (!c.ok) fail(c.fix);
}

/**
 * The plan's code pins, before the preflight reads through the plan
 * (review D2-1 round 2): a trusted issuer that is no ClaimIssuer is
 * refused by name, not by the revert of its first call.
 */
async function preflightPins(o) {
  for (const c of await planPins(o)) if (!c.ok) fail(codeHashRefusal(c));
}

/** Step 5: the factory's fee sink becomes ops while the deployer owns it. */
async function paramSteps({ o, d, dAddr, ok, log }) {
  const f = o.onchainIDFactory;
  if (!f) return;
  const ops = await addrOf(o.ops);
  if (same(await f.feeRecipient(), ops))
    return ok("OnchainIDFactory feeRecipient: already ops");
  if (!same(await f.owner(), dAddr)) {
    log(
      "   ⚠️  OnchainIDFactory: governance must setFeeRecipient(ops) by an IdentityFactoryParameters vote",
    );
    return;
  }
  await (await f.connect(d).setFeeRecipient(ops)).wait();
  if (!same(await f.feeRecipient(), ops))
    fail("OnchainIDFactory feeRecipient did not move to ops");
  ok(`OnchainIDFactory feeRecipient: ops ${ops} (D54)`);
}

/** Completion lines: [label, pass][]. */
async function paramLines(o) {
  const lines = (await paramChecks(o, false)).map((c) => [c.label, c.ok]);
  for (const c of await planPins(o)) lines.push([codeHashLabel(c), c.ok]);
  return [...lines, ...(await typeLines(o))];
}

module.exports = {
  attestorId,
  governanceChecks,
  factoryChecks,
  privacyChecks,
  identityChecks,
  planPins,
  preflightPins,
  preflightParams,
  paramSteps,
  paramLines,
};
