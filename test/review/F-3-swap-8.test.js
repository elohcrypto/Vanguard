// Review F-3, round 8 (item C, GA-ARGS; lane G's swap sweep ported): an
// address-typed constructor argument the deploy flows pass is read back
// from chain. Each of the eight swaps that ended its option successfully
// (the argument replaced by another contract's address, the first one
// option 1 creates) now stops the option with "missing wiring: <the
// link>", without its success banner, and demo state holds no contract at
// the swapped address. Lane D D7-2: option 1 stopped by a testing-mode
// ZKVerifierIntegrated (PrivacyManager's constructor refuses it) leaves
// no verifier in demo state.
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
  21: "ERC-3643 DIGITAL TOKEN SYSTEM DEPLOYED!",
  31: "Oracle Management System deployed successfully!",
  51: "INVESTOR TYPE SYSTEM DEPLOYED SUCCESSFULLY!",
  61: "ENHANCED ESCROW SYSTEM DEPLOYED SUCCESSFULLY!",
  74: "GOVERNANCE TOKEN SYSTEM DEPLOYED!",
  84: "Dynamic List Management system ready!",
};

// [option, artifact, constructor word swapped, the link that reads it]
const SWAPS = [
  ["31", "WhitelistOracle", 0, "WhitelistOracle oracleManager as deployed"],
  ["31", "BlacklistOracle", 0, "BlacklistOracle oracleManager as deployed"],
  [
    "51",
    "InvestorRequestManager",
    3,
    "InvestorRequestManager identityRegistry as deployed",
  ],
  ["61", "EscrowWalletFactory", 0, "EscrowWalletFactory vscToken as deployed"],
  [
    "61",
    "EscrowWalletFactory",
    2,
    "EscrowWalletFactory identityRegistry as deployed",
  ],
  [
    "61",
    "EscrowWalletFactory",
    3,
    "EscrowWalletFactory complianceRules as deployed",
  ],
  [
    "74",
    "VanguardGovernance",
    0,
    "VanguardGovernance governanceToken as deployed",
  ],
  [
    "74",
    "VanguardGovernance",
    1,
    "VanguardGovernance identityRegistry as deployed",
  ],
];

const word = (hex, w) => hex.slice(w * 64, w * 64 + 64);
const put = (hex, w, v) => hex.slice(0, w * 64) + v + hex.slice(w * 64 + 64);

/**
 * Options 1 .. `opt` in order; the first creation of `artifact`'s code
 * sent as `edit(args, first)` (its constructor words, the address of the
 * first contract created) instead; no artifact, nothing edited.
 */
async function run(opt, artifact, edit) {
  const code =
    artifact && (await artifacts.readArtifact(artifact)).bytecode.toLowerCase();
  const m = modules(await newState());
  const r = { hits: 0, at: null, first: null, was: null, out: [] };
  await sending(
    async (tx, send) => {
      const data = String(tx.data ?? tx.input ?? "").toLowerCase();
      if (code && !tx.to && !r.hits && data.startsWith(code)) {
        r.hits++;
        const args = data.slice(code.length);
        r.was = args;
        const t = { ...tx, data: code + edit(args, r.first) };
        delete t.input;
        const h = await send(t);
        r.at = (
          await ethers.provider.getTransactionReceipt(h)
        )?.contractAddress;
        return h;
      }
      if (tx.to || r.first) return null;
      const h = await send(tx);
      r.first = (
        await ethers.provider.getTransactionReceipt(h)
      ).contractAddress;
      return h;
    },
    async () => {
      for (const s of STEPS.slice(0, STEPS.indexOf(opt) + 1)) {
        const [, lines] = await capture(() =>
          step(s, m).catch((e) => console.log(`THROWN: ${e.message}`)),
        );
        r.out.push(...lines.map((l) => `[${s}] ${l}`));
        if (r.hits) break;
      }
    },
  );
  const text = r.out.join("\n");
  const mine = r.out.filter((l) => l.startsWith(`[${opt}]`)).join("\n");
  return { ...r, text, mine, state: m.state };
}

/** Demo state's keys holding `at`. */
const holding = (state, at) =>
  Object.entries(state.contracts)
    .filter(
      ([, c]) => at && String(c?.target).toLowerCase() === at.toLowerCase(),
    )
    .map(([k]) => k);

describe("F-3 round 8: the deploy flows read their address arguments back", function () {
  this.timeout(1800000);

  for (const [opt, artifact, w, link] of SWAPS) {
    it(`option ${opt}'s ${artifact} with constructor word ${w} swapped for another contract stops the option with "${link}"; state holds no contract there`, async function () {
      const r = await fresh(() =>
        run(opt, artifact, (args, first) =>
          put(args, w, first.slice(2).toLowerCase().padStart(64, "0")),
        ),
      );
      expect(r.hits, "the creation was made and swapped once").to.equal(1);
      const decoy = BigInt(r.first);
      expect(BigInt("0x" + word(r.was, w)), "another contract").to.not.equal(
        decoy,
      );
      expect(r.mine).to.contain("missing wiring: ");
      expect(r.mine).to.contain(link);
      expect(r.mine).to.not.contain(BANNER[opt]);
      expect(holding(r.state, r.at)).to.deep.equal([]);
    });
  }

  it("option 1's ZKVerifierIntegrated with testingMode flipped to true stops option 1; state holds no verifier", async function () {
    const r = await fresh(() =>
      run("1", "ZKVerifierIntegrated", (args) =>
        put(args, 0, "1".padStart(64, "0")),
      ),
    );
    expect(r.hits, "the creation was made and flipped once").to.equal(1);
    expect(BigInt("0x" + word(r.was, 0)), "the deploy's word").to.equal(0n);
    expect(r.mine).to.contain("TestingModeVerifier");
    expect(r.mine).to.not.contain(BANNER[1]);
    expect(r.state.getContract("zkVerifierIntegrated")).to.equal(undefined);
    expect(r.state.getContract("zkVerifier")).to.equal(undefined);
    expect(r.state.zkVerifier).to.equal(null);
    expect(holding(r.state, r.at)).to.deep.equal([]);
  });

  it("control: options 1 .. 84 unswapped all complete with no missing wiring and every banner", async function () {
    const r = await fresh(() => run("84", null));
    expect(r.hits).to.equal(0);
    expect(r.text).to.not.contain("missing wiring");
    expect(r.text).to.not.contain("THROWN");
    for (const s of STEPS) {
      expect(r.text, `option ${s}'s banner`).to.contain(BANNER[s]);
    }
    expect(r.state.getContract("dynamicListManager")).to.not.equal(undefined);
  });
});
