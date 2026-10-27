// Review F-3, round 9 (U2 round 9 item C; lane G GC1, lane D D8-1): the
// call twin of F-3-abi-8. Round 8 swaps every address word of a
// constructor; the wiring the flows set AFTER construction (setX(address),
// addTrustedIssuer, addAgent, initialize-style calls) is swapped here:
// every address argument of every non-creation call options 1, 13, 21,
// 31, 51, 61, 74 and 84 send, decoded with the ABI of the contract the
// call goes to, is replaced once by another contract's address. Each swap
// stops its option by name ("missing wiring: <link>" or a named revert,
// else the flow's stop line naming the link the call sets, or a named
// check), except the two documented rows below, which still end with the
// banner. R9-C7: option 1 stopped by its trusted-issuer read-back leaves
// no identityRegistry in demo state.
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const DynamicListModule = require("../../demo/modules/DynamicListModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask } = require("../helpers/deployFlows");

/** `fn` with each eth_sendTransaction passed to `onSend(tx, send)` first. */
async function sending(onSend, fn) {
  const p = network.provider;
  const [request, send] = [p.request.bind(p), p.send.bind(p)];
  const shim = async (a) => {
    if (a.method === "eth_sendTransaction") {
      const tx = a.params[0];
      const out = await onSend(tx, (t) =>
        request({ method: a.method, params: [t] }),
      );
      if (out) return out;
    }
    return request(a);
  };
  p.request = shim;
  p.send = (m, x) => shim({ method: m, params: x ?? [] });
  try {
    return await fn();
  } finally {
    [p.request, p.send] = [request, send];
  }
}

/** `fn` on the chain as it is now, reverted after. */
async function fresh(fn) {
  const id = await network.provider.request({ method: "evm_snapshot" });
  try {
    return await fn();
  } finally {
    await network.provider.request({ method: "evm_revert", params: [id] });
  }
}

async function modules() {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const logger = new EnhancedLogger();
  return {
    state,
    deployer: new ContractDeployer(state, logger),
    inv: new InvestorTypeModule(state, logger, ask),
    gov: new GovernanceModule(state, logger, ask),
    esc: new EscrowModule(state, logger, ask),
    dyn: new DynamicListModule(state, logger, ask),
  };
}

const STEPS = ["1", "13", "21", "31", "51", "61", "74", "84"];
const step = (s, m) =>
  ({
    1: () => m.deployer.deployAllContracts(),
    13: () => m.deployer.deployComplianceRules(),
    21: () => m.deployer.deployDigitalTokenSystem(),
    31: () => m.deployer.deployOracleSystem(),
    51: () => m.inv.deployInvestorTypeSystem(),
    61: () => m.esc.deployEscrowSystem(),
    74: () => m.gov.deployGovernanceSystem(),
    84: () => m.dyn.deployDynamicListSystem(),
  })[s]();

/** Each option's success banner. */
const BANNER = {
  1: "ALL CONTRACTS DEPLOYED SUCCESSFULLY!",
  13: "ComplianceRules deployed successfully!",
  21: "ERC-3643 DIGITAL TOKEN SYSTEM DEPLOYED!",
  31: "Oracle Management System deployed successfully!",
  51: "INVESTOR TYPE SYSTEM DEPLOYED SUCCESSFULLY!",
  61: "ENHANCED ESCROW SYSTEM DEPLOYED SUCCESSFULLY!",
  74: "GOVERNANCE TOKEN SYSTEM DEPLOYED!",
  84: "Dynamic List Management system ready!",
};

/** The option's own stop: the error it threw, else the failure it printed. */
const stopOf = (mine) =>
  (mine.match(/^\[\d+\] THROWN: (.*)$/m) ||
    mine.match(/ failed: (.*)$/m))?.[1] ?? "";
/** A stop by a link or a named revert (F-3-abi-8's rule). */
const strict = (mine) =>
  /^missing wiring: |reverted with (reason string|custom error|panic code) '/.test(
    stopOf(mine),
  );
/** The link each call below sets, for a stop the flow's stop line names. */
const CAUSE = {
  "21 ComplianceRules.setTokenIdentityRegistry(token)":
    "VSC identity registry in ComplianceRules",
  "21 PrivacyManager.setPolicyToken(token)":
    "VSC jurisdiction policy token on PrivacyManager (until the handover)",
  "31 OracleManager.setConsensusEngine(_engine)":
    "ConsensusOracle engine on OracleManager",
  "51 Token.setInvestorTypeRegistry(_investorTypeRegistryAddress)":
    "VSC investor type registry",
};
/**
 * R9-C6, the weak forms: the flow's stop line ("the deploy stopped;
 * missing wiring: ...") naming the link the swapped call sets, or the
 * flow's named check "<Contract>.<fn> did not apply" for that call.
 */
function weak({ site, target, fn, r }) {
  if (stopOf(r.mine) === `${target}.${fn} did not apply`) return "check";
  const line = r.mine.match(/^\[\d+\] +the deploy stopped; missing wiring: (.*)$/m);
  const cause = CAUSE[site];
  return cause && line && `, ${line[1]}, `.includes(`, ${cause}, `)
    ? "stop line"
    : "";
}
const named = (x) => strict(x.r.mine) || Boolean(weak(x));

/**
 * Options 1 .. `opt` in order, send number `n` (any kind, counting from 0,
 * in send order) sent with `data` instead; with no `opt`, all of them,
 * each send recorded (a creation with the address it made).
 */
async function run(opt, n, data) {
  const m = await modules();
  const r = { hits: 0, made: [], out: [] };
  await sending(
    async (tx, send) => {
      const swap = r.made.length === n && data !== undefined;
      const t = swap ? { ...tx, data } : tx;
      if (swap) {
        r.hits++;
        delete t.input;
      }
      const rec = { opt: r.cur, to: tx.to ?? null };
      rec.data = String(tx.data ?? tx.input);
      r.made.push(rec);
      const h = await send(t);
      if (!tx.to) {
        rec.at = (await ethers.provider.getTransactionReceipt(h))
          .contractAddress;
      }
      return h;
    },
    async () => {
      for (const s of STEPS.slice(0, STEPS.indexOf(opt ?? "84") + 1)) {
        r.cur = s;
        const [, lines] = await capture(() =>
          step(s, m).catch((e) => console.log(`THROWN: ${e.message}`)),
        );
        r.out.push(...lines.map((l) => `[${s}] ${l}`));
        if (r.hits) break;
      }
    },
  );
  const mine = r.out.filter((l) => l.startsWith(`[${opt}]`)).join("\n");
  return { ...r, text: r.out.join("\n"), mine, state: m.state };
}

/** Every address in decoded `values` of `types`: [{ path, value }]. */
function addresses(types, values, path = []) {
  return types.flatMap((t, i) => {
    const at = [...path, i];
    if (t.baseType === "address") return [{ path: at, value: values[i] }];
    if (t.isTuple()) return addresses(t.components, values[i], at);
    if (t.isArray()) {
      const kids = values[i].map(() => t.arrayChildren);
      return addresses(kids, values[i], at);
    }
    return [];
  });
}

/** `values` (plain arrays) with the leaf at `path` set to `v`. */
const put = (values, [i, ...rest], v) =>
  values.map((x, j) => (j !== i ? x : rest.length ? put(x, rest, v) : v));

// The two swaps that still end with the banner, by ruling:
// - setComplianceRules(_token): the jurisdiction token has no getter, so no
//   link can read it back (a contract change; Not done, R9-C3).
// - refreshVerified(wallet): anyone's cache of the claim walk; swapped, the
//   decoy (no identity) caches nothing and isVerified walks the claims.
const DOCUMENTED = [
  "21 IdentityRegistry.setComplianceRules(_token)",
  "61 IdentityRegistry.refreshVerified(wallet)",
];
const TRUSTED = "KYC/AML issuers trusted on IdentityRegistry";

describe("F-3 round 9: every address argument of every post-construction call the deploy flows send is read back", function () {
  this.timeout(3600000);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const rows = [];
  const skipped = [];
  let control;
  let calls;

  before(async function () {
    // Creation code to artifact, longest match first.
    const table = [];
    for (const n of await artifacts.getAllFullyQualifiedNames()) {
      const a = await artifacts.readArtifact(n);
      if (a.bytecode.length > 2) {
        const code = a.bytecode.toLowerCase();
        table.push({ name: a.contractName, code, abi: a.abi });
      }
    }
    table.sort((x, y) => y.code.length - x.code.length);
    control = await fresh(() => run());
    calls = control.made.filter((c) => c.to).length;
    const kind = {}; // created address -> artifact
    for (const c of control.made.filter((x) => !x.to)) {
      const t = table.find((x) => c.data.toLowerCase().startsWith(x.code));
      if (t) kind[c.at.toLowerCase()] = t;
    }
    for (const [n, c] of control.made.entries()) {
      if (!c.to) continue;
      const t = kind[c.to.toLowerCase()];
      const sel = c.data.slice(0, 10);
      const f = t && new ethers.Interface(t.abi).getFunction(sel);
      if (!f) {
        skipped.push({ n, opt: c.opt, to: c.to, sel });
        continue;
      }
      const values = coder
        .decode(f.inputs, "0x" + c.data.slice(10))
        .toArray(true);
      for (const { path, value } of addresses(f.inputs, values)) {
        // Another contract: the first one the walk creates, else the next.
        const decoy = control.made.find(
          (d) =>
            !d.to &&
            d.at.toLowerCase() !== value.toLowerCase() &&
            d.at.toLowerCase() !== c.to.toLowerCase(),
        ).at;
        const data =
          sel + coder.encode(f.inputs, put(values, path, decoy)).slice(2);
        const r = await fresh(() => run(c.opt, n, data));
        const arg = path.map((i, d) => (d ? i : f.inputs[i].name)).join(".");
        const site = `${c.opt} ${t.name}.${f.name}(${arg})`;
        const row = { n, opt: c.opt, site, target: t.name, fn: f.name };
        rows.push({ ...row, value, decoy, r });
      }
    }
  });

  it("control: every option completes", function () {
    for (const s of STEPS) expect(control.text).to.contain(BANNER[s]);
  });

  it("the call walk: every call's target is an artifact's, each address argument swapped once", function () {
    expect(skipped, "calls to an unknown target").to.deep.equal([]);
    expect(rows.length).to.be.greaterThan(0);
    for (const { n, site, value, decoy, r } of rows) {
      expect(r.hits, `${site} #${n}`).to.equal(1);
      expect(decoy.toLowerCase(), site).to.not.equal(value.toLowerCase());
    }
  });

  it("GC1: the swaps that end with the banner are exactly the two documented rows", function () {
    const pass = rows.filter(
      (x) => x.r.mine.includes(BANNER[x.opt]) && !stopOf(x.r.mine),
    );
    for (const x of pass) console.log(`      PASS #${x.n} ${x.site}`);
    expect(pass.map((x) => x.site)).to.deep.equal(DOCUMENTED);
  });

  it("every other swap stops by name; the receipt", function () {
    const other = rows.filter((x) => !DOCUMENTED.includes(x.site));
    const byName = other.filter(named);
    const soft = other.filter((x) => !strict(x.r.mine) && weak(x));
    const line = `${rows.length} arguments over ${calls} calls, ${byName.length} stop by name (${byName.length - soft.length} by a link or named revert, ${soft.length} by the flow's stop line or a named check), ${rows.length - other.length} documented`;
    console.log(`      ${line}`);
    for (const x of soft) console.log(`      WEAK #${x.n} ${x.site}: ${weak(x)}`);
    const bad = other.filter((x) => !named(x));
    expect(
      bad.map((x) => `#${x.n} ${x.site}: ${stopOf(x.r.mine).slice(0, 160)}`),
    ).to.deep.equal([]);
    expect(line).to.equal(
      "55 arguments over 62 calls, 53 stop by name (47 by a link or named revert, 6 by the flow's stop line or a named check), 2 documented",
    );
  });

  it("the trusted-issuer swaps at option 1 stop naming the trusted-issuer link", function () {
    const at1 = rows.filter((x) => x.opt === "1" && x.fn === "addTrustedIssuer");
    expect(at1.length).to.equal(2);
    for (const x of at1) {
      expect(strict(x.r.mine), x.site).to.equal(true);
      expect(stopOf(x.r.mine), x.site).to.contain(TRUSTED);
    }
  });

  it("R9-C7: that stop leaves no identityRegistry in demo state; the honest run writes it", function () {
    expect(control.state.getContract("identityRegistry")).to.not.equal(
      undefined,
    );
    const at1 = rows.filter((x) => x.opt === "1" && x.fn === "addTrustedIssuer");
    expect(at1.length).to.equal(2);
    const held = at1.filter((x) => x.r.state.getContract("identityRegistry"));
    expect(held.map((x) => `#${x.n} ${x.site}`)).to.deep.equal([]);
  });
});
