// Review F-3, round 8 (item C2, lead ruling R8-C1): the class, not the
// instances. Every contract creation options 1, 13, 21, 31, 51, 61, 74
// and 84 make is matched to its artifact by creation code; its constructor
// arguments are decoded with the artifact's ABI, so an address after a
// dynamic argument (a string's offset) is found too; and EVERY address in
// them (a contract's or an EOA's by design: owner, bank, fee wallet) is
// swapped, one at a time, for another contract's address. Each swap stops
// its option by name ("missing wiring: <link>" or a named revert), without
// its success banner, and demo state holds no contract at the swapped
// creation's address. And option 21 run after 51 (it deploys the custody
// manager then) that stops leaves demo state as it found it; the links an
// owner setter can move are a vote's after the handover.
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const DynamicListModule = require("../../demo/modules/DynamicListModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask, skip } = require("../helpers/deployFlows");
const { wiring } = require("../../demo/utils/DeployWiring");

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
/**
 * A stop that names its cause: "missing wiring: <link>" or a revert's
 * reason or error; not a revert with none (a later call failing on it).
 */
const named = (mine) =>
  /^missing wiring: |reverted with (reason string|custom error|panic code) '/.test(
    stopOf(mine),
  );

/**
 * Options 1 .. `opt` in order, creation number `n` (counting from 0, in
 * send order) sent with `data` instead; with no `opt`, all of them, each
 * creation recorded.
 */
async function run(opt, n, data) {
  const m = await modules();
  const r = { hits: 0, at: null, made: [], out: [] };
  await sending(
    async (tx, send) => {
      if (tx.to) return null;
      const swap = r.made.length === n;
      const t = swap ? { ...tx, data } : tx;
      if (swap) {
        r.hits++;
        delete t.input;
      }
      r.made.push({ opt: r.cur, data: String(tx.data ?? tx.input) });
      const h = await send(t);
      const at = (await ethers.provider.getTransactionReceipt(h))
        .contractAddress;
      r.made[r.made.length - 1].at = at;
      if (swap) r.at = at;
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

/** Demo state's keys holding `at`. */
const holding = (state, at) =>
  Object.entries(state.contracts)
    .filter(
      ([, c]) => at && String(c?.target).toLowerCase() === at.toLowerCase(),
    )
    .map(([k]) => k);

describe("F-3 round 8: every address constructor argument the deploy flows pass is read back", function () {
  this.timeout(1800000);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let control;
  let sites;
  const rows = [];
  const ok = ({ opt, r }) =>
    named(r.mine) &&
    !r.mine.includes(BANNER[opt]) &&
    !holding(r.state, r.at).length;

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
    sites = control.made.map((c, n) => {
      const t = table.find((x) => c.data.toLowerCase().startsWith(x.code));
      const types = t && new ethers.Interface(t.abi).deploy.inputs;
      const args = t && "0x" + c.data.slice(t.code.length);
      const values = t && coder.decode(types, args).toArray(true);
      return { ...c, n, name: t?.name, types, values, args };
    });
    for (const s of sites.filter((x) => x.name)) {
      for (const { path, value } of addresses(s.types, s.values)) {
        // Another contract: the first one this walk creates, else the next.
        const decoy = control.made.find(
          (c) => c.at !== s.at && c.at.toLowerCase() !== value.toLowerCase(),
        ).at;
        const args = coder.encode(s.types, put(s.values, path, decoy));
        const code = s.data.slice(0, s.data.length - s.args.length + 2);
        const r = await fresh(() => run(s.opt, s.n, code + args.slice(2)));
        const arg = path.map((i, d) => (d ? i : s.types[i].name)).join(".");
        const site = `${s.opt} ${s.name}#${s.n} ${arg}`;
        rows.push({ opt: s.opt, site, value, decoy, r });
      }
    }
  });

  it("the unswapped walk completes every option with its banner", function () {
    expect(control.text).to.not.contain("missing wiring");
    expect(control.text).to.not.contain("THROWN");
    for (const s of STEPS) {
      expect(control.text, `option ${s}'s banner`).to.contain(BANNER[s]);
    }
  });

  it("the ABI walk: every creation is an artifact's, each address word swapped once for another contract", function () {
    const unknown = sites.filter((s) => !s.name).map((s) => s.n);
    expect(unknown, "creations with no artifact").to.deep.equal([]);
    const words = sites.reduce(
      (k, s) => k + addresses(s.types, s.values).length,
      0,
    );
    const m = sites.filter((s) => addresses(s.types, s.values).length).length;
    console.log(
      `      ${words} address-typed constructor words across ${m} sites (${sites.length} creations): ${rows.filter(ok).length} stop by name`,
    );
    if (process.env.ABI8_ROWS) {
      for (const x of rows) {
        const why = [stopOf(x.r.mine)];
        const held = holding(x.r.state, x.r.at);
        console.log(
          `      ${ok(x) ? "stops " : "PASSES"} ${x.site} -> ${(why || []).join(" | ").slice(0, 240)}${held.length ? ` [state: ${held}]` : ""}`,
        );
      }
    }
    expect(rows.length).to.equal(words);
    expect(words).to.be.greaterThan(0);
    for (const { site, value, decoy, r } of rows) {
      expect(r.hits, site).to.equal(1);
      expect(decoy.toLowerCase(), site).to.not.equal(value.toLowerCase());
    }
  });

  it("every swap stops its option by name", function () {
    const bad = rows.filter(({ r }) => !named(r.mine));
    expect(bad.map((x) => x.site)).to.deep.equal([]);
  });

  it("no swapped option ends with its success banner", function () {
    const bad = rows.filter((x) => x.r.mine.includes(BANNER[x.opt]));
    expect(bad.map((x) => x.site)).to.deep.equal([]);
  });

  it("demo state holds no contract at a swapped creation's address", function () {
    const bad = rows.filter(({ r }) => holding(r.state, r.at).length);
    expect(
      bad.map((x) => `${x.site}: ${holding(x.r.state, x.r.at)}`),
    ).to.deep.equal([]);
  });
});

/** Demo state's contracts, by key: their addresses. */
const held = (state) =>
  Object.fromEntries(
    Object.entries(state.contracts).map(([k, c]) => [k, c?.target]),
  );

describe("F-3 round 8: option 21 writes demo state only once read back", function () {
  this.timeout(600000);

  it("option 21 after 51 (custody deployed with VSC) stopped by a link leaves neither VSC nor the manager in demo state", async function () {
    const sel = new ethers.Interface([
      "function addAgent(address)",
    ]).getFunction("addAgent").selector;
    const r = await fresh(async () => {
      const m = await modules();
      for (const s of ["1", "13", "51"]) await capture(() => step(s, m));
      const before = held(m.state);
      let hits = 0;
      const [, lines] = await sending(
        async (tx, send) => {
          const data = String(tx.data ?? tx.input ?? "");
          if (hits || !tx.to || !data.startsWith(sel)) return null;
          hits++;
          return send(skip(tx)); // mined, without its effect
        },
        () =>
          capture(() =>
            step("21", m).catch((e) => console.log(`THROWN: ${e.message}`)),
          ),
      );
      return { hits, text: lines.join("\n"), before, after: held(m.state) };
    });
    expect(r.hits).to.equal(1);
    expect(r.text).to.contain("✅ InvestorRequestManager: ");
    expect(r.text).to.contain(
      "missing wiring: VSC agent on IdentityRegistry (recovery)",
    );
    expect(r.text).to.not.contain(BANNER[21]);
    expect(r.after).to.deep.equal(r.before);
  });

  it("the links an owner setter moves (both tokens, the escrow factory) read true once the deployer no longer owns the contract", async function () {
    const names = [
      ["digitalToken", "Token", ["identityRegistry", "compliance"]],
      [
        "governanceToken",
        "GovernanceToken",
        ["identityRegistry", "compliance"],
      ],
      [
        "escrowFactory",
        "EscrowWalletFactory",
        ["identityRegistry", "complianceRules"],
      ],
    ];
    const setter = { identityRegistry: "setIdentityRegistry" };
    setter.compliance = "setCompliance";
    setter.complianceRules = "setComplianceRules";
    const w = await fresh(async () => {
      const { state } = await run("74", -1);
      const vote = state.signers[15];
      const decoy = state.getContract("keyManager").target; // a contract
      for (const [key, , fields] of names) {
        const c = state.getContract(key);
        await (await c.transferOwnership(vote.address)).wait();
        await (await c.connect(vote).acceptOwnership()).wait();
        for (const f of fields) {
          await (await c.connect(vote)[setter[f]](decoy)).wait();
        }
      }
      return wiring(state);
    });
    for (const [, label, fields] of names) {
      for (const f of fields) {
        const link = w.find((x) => x.name === `${label} ${f} as deployed`);
        expect(link, `${label} ${f}`).to.deep.equal({
          name: `${label} ${f} as deployed`,
          ok: true,
        });
      }
    }
  });
});
