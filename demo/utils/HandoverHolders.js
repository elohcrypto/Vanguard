/**
 * @fileoverview Task 4.16 (D47): the VSC holders and their standing on the
 * whitelist oracle bound to VSC. A whitelist oracle in OracleOnly refuses
 * every unlisted holder (default-deny) and, with an investor-type registry
 * live on the token, every holder listed below its type's tier (R-410-6);
 * in Either an unlisted holder passes by a proof binding only when its type
 * requires tier 1 or it is exempt (D46 a, Task 4.17), a short live entry
 * refuses in both modes. Standing is read with whitelistStanding, the one
 * call the transfer path makes. The ceremony's preflight refuses the
 * holders a bind would freeze and warns on the rest; the completion prints
 * the standing; demo option 38a fills the oracle before it binds. Trusted
 * contracts skip the whitelist (the human counterparty is checked) and
 * are left out of the holder set.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail, MODE } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");

const ZERO = ethers.ZeroAddress;
const WL_ABI = [
  "function whitelistStanding(address) view returns (bool live, uint8 tier)",
];
const REG_ABI = [
  "function getRequiredWhitelistTier(address) view returns (uint8)",
  "function investorLimitExempt(address) view returns (bool)",
  "function getInvestorType(address) view returns (uint8)",
];
const TYPES = ["Normal", "Retail", "Accredited", "Institutional"];

/**
 * Every address that holds VSC now and is not a trusted contract on it,
 * from the Transfer scan (mints included) since o.fromBlock.
 */
async function vscHolders(o) {
  const token = o.token;
  const vsc = await addrOf(token);
  const seen = new Set();
  const out = [];
  for (const ev of await scanLogs(token, token.filters.Transfer(), o)) {
    const to = ethers.getAddress(ev.args[1]);
    if (same(to, ZERO) || seen.has(to)) continue;
    seen.add(to);
    if ((await token.balanceOf(to)) === 0n) continue;
    if (await o.complianceRules["isTrustedContract(address,address)"](vsc, to))
      continue;
    out.push(to);
  }
  return out;
}

/**
 * The holders' standing on `oracle` (the one bound to VSC by default):
 * { mode, oracle, holders: [{ address, listed, tier, required, exempt,
 * ok }] }, or null when no oracle is bound and none is given. `required`
 * is the holder's investor type's tier (0 with no registry live on the
 * token); `ok` is listed and, unless exempt, tier >= required.
 */
async function holderStanding(o, oracle) {
  const vsc = await addrOf(o.token);
  const rules = o.complianceRules;
  const wl = oracle ? await addrOf(oracle) : await rules.whitelistOracle(vsc);
  if (same(wl, ZERO)) return null;
  const mode = MODE[Number(await rules.whitelistMode(vsc))];
  const list = await ethers.getContractAt(WL_ABI, wl);
  const regAddr = await o.token.investorTypeRegistry();
  const reg = same(regAddr, ZERO)
    ? null
    : await ethers.getContractAt(REG_ABI, regAddr);
  const holders = [];
  for (const address of await vscHolders(o)) {
    const [live, t] = await list.whitelistStanding(address);
    const listed = Boolean(live);
    const tier = Number(t);
    const required = reg
      ? Number(await reg.getRequiredWhitelistTier(address))
      : 0;
    const exempt = reg ? await reg.investorLimitExempt(address) : false;
    const type = reg ? TYPES[Number(await reg.getInvestorType(address))] : "-";
    holders.push({
      address,
      type,
      listed,
      tier,
      required,
      exempt,
      ok: listed && (exempt || tier >= required),
    });
  }
  return { mode, oracle: wl, holders };
}

const addrs = (hs) => hs.map((h) => h.address).join(", ");
/** D46 (a): unlisted in Either, its type above tier 1, not exempt. */
const stuck = (s) =>
  s.mode === "Either"
    ? s.holders.filter((h) => !h.listed && !h.exempt && h.required >= 2)
    : [];
const stuckText = (hs) =>
  hs
    .map(
      (h) =>
        `unlisted holder ${h.address} of type ${h.type} needs tier ${h.required} in Either: list it before the ceremony`,
    )
    .join("; ");

/**
 * D47: read-only, before the ceremony's first transaction. With a
 * whitelist oracle bound to VSC: in OracleOnly an unlisted holder is
 * refused (the bind would freeze it and after the handover only ops can
 * list it); a holder listed below its type's tier is refused in OracleOnly
 * and Either alike (R-410-6); in Either an unlisted holder whose type needs
 * tier 2 or more is refused (D46 a: a proof carries no tier), a tier-1 or
 * exempt one is a warning (it passes by a proof binding). ZkOnly reads no entry. Returns the
 * standing, or null when no oracle is bound.
 */
async function preflightHolders(o, warn = () => {}) {
  const s = await holderStanding(o);
  if (!s || s.mode === "ZkOnly") return s;
  const unlisted = s.holders.filter((h) => !h.listed);
  const short = s.holders.filter((h) => h.listed && !h.ok);
  if (unlisted.length && s.mode === "OracleOnly") {
    fail(
      `whitelist oracle ${s.oracle} is bound to VSC in OracleOnly and ${unlisted.length} current holder(s) are not listed (${addrs(unlisted)}): every transfer of theirs is refused, and after the handover only ops can list them; list them first (demo option 38a lists every holder at its tier) or unbind the oracle (setWhitelistOracle(VSC, 0))`,
    );
  }
  if (short.length) {
    fail(
      `whitelist oracle ${s.oracle} lists ${short.length} VSC holder(s) below the tier their investor type requires (${short.map((h) => `${h.address} tier ${h.tier} < ${h.required}`).join(", ")}): R-410-6 refuses their transfers; raise the entries (option 33 -> 2) first`,
    );
  }
  const held = stuck(s);
  if (held.length) fail(stuckText(held));
  if (unlisted.length) {
    warn(
      `whitelist oracle ${s.oracle} is bound to VSC in Either and ${unlisted.length} holder(s) are not listed (${addrs(unlisted)}): tier-1 or exempt, they pass only by a live PrivacyManager binding`,
    );
  }
  return s;
}

/**
 * Completion lines: the standing of every holder on the bound oracle (a
 * failing line in OracleOnly for an unlisted holder, in both modes for a
 * short entry), or the one line that no oracle is bound.
 */
async function holderLines(o, warnings) {
  const s = await holderStanding(o);
  if (!s) {
    return [
      [
        "no whitelist oracle bound to VSC: the investor-type tier rule is inert until a ComplianceRules vote binds one (D47)",
        true,
      ],
    ];
  }
  if (s.mode === "ZkOnly") {
    return [
      [
        `VSC in ZkOnly: the bound whitelist oracle ${s.oracle} is not read`,
        true,
      ],
    ];
  }
  const unlisted = s.holders.filter((h) => !h.listed);
  const short = s.holders.filter((h) => h.listed && !h.ok);
  if (s.mode === "Either" && unlisted.length) {
    warnings.push(
      `${unlisted.length} VSC holder(s) not listed on ${s.oracle} (Either): ${addrs(unlisted)} pass only by a proof binding, and only at tier 1 or exempt (D46)`,
    );
  }
  const bad = s.mode === "OracleOnly" ? [...unlisted, ...short] : short;
  const held = stuck(s);
  return [
    ...(held.length ? [[stuckText(held), false]] : []),
    [
      bad.length
        ? `whitelist oracle ${s.oracle} (${s.mode}) refuses ${bad.length} of ${s.holders.length} VSC holder(s): ${bad.map((h) => `${h.address} (${h.listed ? `tier ${h.tier} < ${h.required}` : "unlisted"})`).join(", ")}`
        : `every one of ${s.holders.length} VSC holder(s) is listed at its tier on the bound whitelist oracle ${s.oracle} (${s.mode})`,
      bad.length === 0,
    ],
  ];
}

module.exports = { vscHolders, holderStanding, preflightHolders, holderLines };
