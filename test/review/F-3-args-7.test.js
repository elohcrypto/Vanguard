// Review F-3, round 7 (lane D D6's constructor-argument sweep, inverted):
// a static constructor argument the deploy flows pass is read back from
// chain. Each of the ten flipped arguments that ended its option
// successfully (one low bit of the word) now stops the option with
// "missing wiring: <the check>", without its success banner, and demo
// state holds no contract at the swapped address. Option 84 reads its
// two governance links back the same way.
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

function modules(state) {
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

async function newState() {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  return state;
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
  51: "INVESTOR TYPE SYSTEM DEPLOYED SUCCESSFULLY!",
  61: "ENHANCED ESCROW SYSTEM DEPLOYED SUCCESSFULLY!",
  74: "GOVERNANCE TOKEN SYSTEM DEPLOYED!",
  84: "Dynamic List Management system ready!",
};

const CHECK = {
  1: "KYC and AML ClaimIssuers owned by the deployer (until the handover)",
  13: "ComplianceRules owned by the deployer (until the handover)",
  51: "InvestorRequestManager bank (ops) and VSC as deployed",
  61: "escrow fee wallet as configured (until the handover)",
  74: "VanguardGovernance's investor type registry, ComplianceRules, OracleManager and VSC as deployed",
};

// [option, artifact, nth creation of its code, constructor word flipped]
const ARGS = [
  ["1", "ClaimIssuer", 0, 0], // _owner
  ["1", "ClaimIssuer", 1, 0], // _owner
  ["13", "ComplianceRules", 0, 0], // _owner
  ["51", "InvestorRequestManager", 0, 0], // _bank
  ["51", "InvestorRequestManager", 0, 1], // _token
  ["61", "EscrowWalletFactory", 0, 1], // _ownerWallet
  ["74", "VanguardGovernance", 0, 2], // _investorTypeRegistry
  ["74", "VanguardGovernance", 0, 3], // _complianceRules
  ["74", "VanguardGovernance", 0, 4], // _oracleManager
  ["74", "VanguardGovernance", 0, 5], // _token
];

const flipWord = (hex, w) => {
  const s = w * 64;
  const word = (BigInt("0x" + hex.slice(s, s + 64)) ^ 1n).toString(16);
  return hex.slice(0, s) + word.padStart(64, "0") + hex.slice(s + 64);
};

/** Options 1 .. `opt` in order, `edit(tx)` answering one of `opt`'s sends. */
async function run(opt, edit) {
  const m = modules(await newState());
  let hits = 0;
  let at = null;
  const out = [];
  await sending(
    async (tx, send) => {
      const t = edit(tx);
      if (!t) return null;
      hits++;
      const h = await send(t);
      at = (await ethers.provider.getTransactionReceipt(h))?.contractAddress;
      return h;
    },
    async () => {
      for (const s of STEPS.slice(0, STEPS.indexOf(opt) + 1)) {
        const [, lines] = await capture(() =>
          step(s, m).catch((e) => console.log(`THROWN: ${e.message}`)),
        );
        out.push(...lines.map((l) => `[${s}] ${l}`));
        if (hits) break;
      }
    },
  );
  return { hits, at, text: out.join("\n"), state: m.state };
}

/** Demo state's keys holding `at`. */
const holding = (state, at) =>
  Object.entries(state.contracts)
    .filter(
      ([, c]) => at && String(c?.target).toLowerCase() === at.toLowerCase(),
    )
    .map(([k]) => k);

describe("F-3 round 7: the deploy flows read their constructor arguments back", function () {
  this.timeout(1800000);

  for (const [opt, artifact, nth, w] of ARGS) {
    it(`option ${opt}'s ${artifact}#${nth} with constructor word ${w} flipped stops the option by name; state holds no contract there`, async function () {
      const { bytecode } = await artifacts.readArtifact(artifact);
      const code = bytecode.toLowerCase();
      let seen = 0;
      const r = await fresh(async () => {
        const res = await run(opt, (tx) => {
          const data = String(tx.data ?? tx.input ?? "").toLowerCase();
          if (tx.to || !data.startsWith(code) || seen++ !== nth) return null;
          const t = {
            ...tx,
            data: code + flipWord(data.slice(code.length), w),
          };
          delete t.input;
          return t;
        });
        return { ...res, keys: Object.keys(res.state.contracts) };
      });
      expect(r.hits, "the creation was made and flipped once").to.equal(1);
      const mine = r.text
        .split("\n")
        .filter((l) => l.startsWith(`[${opt}]`))
        .join("\n");
      expect(mine).to.contain("missing wiring: ");
      expect(mine).to.contain(CHECK[opt]);
      expect(mine).to.not.contain(BANNER[opt]);
      // Round 8 (lane D D7-1): option 51's manager and registry stay out.
      if (opt === "51") expect(r.keys).to.not.include("investorTypeRegistry");
      expect(holding(r.state, r.at)).to.deep.equal([]);
    });
  }

  it("option 84 with setGovernanceContract's argument flipped stops by name; state holds no dynamicListManager", async function () {
    const sel = new ethers.Interface([
      "function setGovernanceContract(address)",
    ]).getFunction("setGovernanceContract").selector;
    const r = await fresh(() =>
      run("84", (tx) => {
        const data = String(tx.data ?? tx.input ?? "").toLowerCase();
        if (!tx.to || !data.startsWith(sel)) return null;
        const t = { ...tx, data: sel + flipWord(data.slice(sel.length), 0) };
        delete t.input;
        return t;
      }),
    );
    expect(r.hits).to.equal(1);
    expect(r.text).to.contain(
      "missing wiring: DynamicListManager governed by VanguardGovernance",
    );
    expect(r.text).to.not.contain(BANNER[84]);
    expect(r.state.getContract("dynamicListManager")).to.equal(undefined);
  });

  // Lead ruling R7-C4: option 61 reads the fee wallet's exemption back
  // before the handover; after it (InvestorTypeRegistry's owner, read on
  // chain, is not the deployer) only a D22 vote exempts it: warned, kept.
  const EXEMPT = "escrow fee wallet exempt from investor limits";
  /** Options 1 .. 51, `between(m)`, then option 61 under `onSend`. */
  async function to61(between, onSend) {
    const m = modules(await newState());
    for (const s of STEPS.slice(0, STEPS.indexOf("61"))) {
      await capture(() => step(s, m));
    }
    await between(m);
    const [, lines] = await sending(onSend, () =>
      capture(() =>
        step("61", m).catch((e) => console.log(`THROWN: ${e.message}`)),
      ),
    );
    const f = m.state.getContract("escrowFactory");
    const types = m.state.getContract("investorTypeRegistry");
    const exempt =
      f && (await types.investorLimitExempt(await f.ownerWallet()));
    return { text: lines.join("\n"), state: m.state, exempt };
  }

  it("option 61 before the handover: a fee wallet left unexempt stops it by name", async function () {
    const sel = new ethers.Interface([
      "function setInvestorLimitExempt(address,bool)",
    ]).getFunction("setInvestorLimitExempt").selector;
    let hits = 0;
    const r = await fresh(() =>
      to61(
        async () => {},
        async (tx, send) => {
          const data = String(tx.data ?? tx.input ?? "").toLowerCase();
          if (!tx.to || !data.startsWith(sel)) return null;
          hits++;
          return send(skip(tx)); // mined, without its effect
        },
      ),
    );
    expect(hits).to.equal(1);
    expect(r.text).to.contain(`missing wiring: ${EXEMPT}`);
    expect(r.text).to.not.contain(BANNER[61]);
    expect(r.state.getContract("escrowFactory")).to.equal(undefined);
  });

  it("option 61 after the handover: the unexempt fee wallet is warned of (a D22 vote) and the option completes", async function () {
    const r = await fresh(() =>
      to61(
        async (m) => {
          const types = m.state.getContract("investorTypeRegistry");
          const next = m.state.signers[5];
          await (await types.transferOwnership(next.address)).wait();
          await (await types.connect(next).acceptOwnership()).wait();
        },
        async () => null,
      ),
    );
    expect(r.text).to.contain(
      "is not exempt from investor limits: after the handover only an InvestorTypeConfig vote can exempt it (D22; option 76, type 0, choice 2)",
    );
    expect(r.text).to.not.contain("missing wiring");
    expect(r.text).to.contain(BANNER[61]);
    expect(r.exempt, "the exemption stays a vote's").to.equal(false);
    expect(r.state.getContract("escrowFactory")).to.not.equal(undefined);
  });

  it("control: options 1 .. 84 unflipped all complete with no missing wiring", async function () {
    const r = await fresh(() => run("84", () => null));
    expect(r.text).to.not.contain("missing wiring");
    expect(r.text).to.not.contain("THROWN");
    for (const s of ["1", "13", "51", "61", "74", "84"]) {
      expect(r.text, `option ${s}'s banner`).to.contain(BANNER[s]);
    }
    expect(r.state.getContract("dynamicListManager")).to.not.equal(undefined);
  });
});
