// Review F-3, round 6 (the round-5 attacker G's G4 and lane D's site
// sweep, inverted): a contract enters demo state only when the code at its
// address is its artifact's. Each 1a creation swapped for a one-byte STOP
// contract stops 1a naming the contract; and at every deploy site (options
// 1, 13, 21, 31, 51, 61, 74, the custody manager and 84) a creation mined
// with the wrong code, or with none, stops the option naming it, and demo
// state holds no contract without its artifact's code.
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
const { createLabel } = require("../../scripts/production/deployRecordLabels");

/** Init code that deploys the one-byte runtime 0x00 (STOP). */
const STOP_INIT = "0x6001600c60003960016000f300";
const stop = (tx) => {
  const t = { ...tx, data: STOP_INIT };
  delete t.input;
  return t;
};

/** `fn` with each eth_sendTransaction passed to `onSend` first. */
async function sending(onSend, fn) {
  const p = network.provider;
  const [request, send] = [p.request.bind(p), p.send.bind(p)];
  const shim = async (a) => {
    if (a.method === "eth_sendTransaction") {
      const tx = await onSend(a.params[0]);
      if (tx) return request({ method: a.method, params: [tx] });
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

/** Option 1a over a fresh demo state. */
async function run1a() {
  const state = await newState();
  const m = modules(state);
  const [ok, lines] = await capture(() =>
    m.deployer.deployEverything({ investorType: m.inv, governance: m.gov }),
  );
  return { ok, text: lines.join("\n"), state };
}

/** Demo state's contracts whose code is none or the STOP byte. */
async function badInState(state) {
  const bad = [];
  for (const [k, c] of Object.entries(state.contracts)) {
    const at = c?.target;
    if (!at) continue;
    const code = await ethers.provider.getCode(at);
    if (code === "0x" || code === "0x00") bad.push(`${k} ${at} ${code}`);
  }
  return bad;
}

/** The stop naming the contract (its display name holds the artifact's). */
const not = (artifact) =>
  new RegExp(
    `${artifact}[^\\n]* at 0x[0-9a-fA-F]{40} has code that is not ${artifact}'s`,
  );
const none = (artifact) =>
  new RegExp(
    `${artifact}[^\\n]* at 0x[0-9a-fA-F]{40} has no code: its deploy transaction mined without creating it`,
  );

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

// [option, artifact, nth creation of its code]; the custody manager is
// deployed by option 51 once the investor type registry exists.
const SITES = [
  ["1", "OnchainIDFactory", 0],
  ["1", "ClaimIssuer", 0],
  ["1", "ClaimIssuer", 1],
  ["1", "KeyManager", 0],
  ["1", "IdentityRegistry", 0],
  ["1", "ZKVerifierIntegrated", 0],
  ["1", "PrivacyManager", 0],
  ["13", "ComplianceRules", 0],
  ["21", "Token", 0],
  ["31", "OracleManager", 0],
  ["31", "WhitelistOracle", 0],
  ["31", "BlacklistOracle", 0],
  ["31", "ConsensusOracle", 0],
  ["51", "InvestorTypeRegistry", 0],
  ["51", "InvestorRequestManager", 0],
  ["61", "EscrowWalletFactory", 0],
  ["74", "GovernanceToken", 0],
  ["74", "VanguardGovernance", 0],
  ["84", "DynamicListManager", 0],
];

/** Options 1 .. `opt` in order, the `nth` creation of `artifact` sent as `edit(tx)`. */
async function site(opt, artifact, nth, edit) {
  const { bytecode } = await artifacts.readArtifact(artifact);
  const m = modules(await newState());
  let seen = 0;
  let hits = 0;
  const out = [];
  await sending(
    async (tx) => {
      const data = String(tx.data ?? tx.input ?? "").toLowerCase();
      if (tx.to || !data.startsWith(bytecode.toLowerCase())) return null;
      if (seen++ !== nth) return null;
      hits++;
      return edit(tx);
    },
    async () => {
      for (const s of STEPS.slice(0, STEPS.indexOf(opt) + 1)) {
        const [, lines] = await capture(() =>
          step(s, m).catch((e) => console.log(`THROWN: ${e.message}`)),
        );
        out.push(...lines);
        if (hits) break;
      }
    },
  );
  return { hits, text: out.join("\n"), state: m.state };
}

describe("F-3 round 6: a contract enters demo state only with its artifact's code", function () {
  this.timeout(1800000);

  it("A (G4): every 1a creation swapped for a STOP contract stops 1a naming the contract; state holds none of them", async function () {
    const creations = [];
    let i = 0;
    await fresh(() =>
      sending(async (tx) => {
        if (!tx.to) creations.push([i, String(tx.data ?? tx.input)]);
        i++;
        return null;
      }, run1a),
    );
    expect(creations.length, "1a's creations").to.equal(17);
    const green = [];
    for (const [send, data] of creations) {
      const artifact = (await createLabel(data)).replace(/^new /, "");
      let n = 0;
      const { ok, text, bad } = await fresh(async () => {
        const r = await sending(
          async (tx) => (n++ === send ? stop(tx) : null),
          run1a,
        );
        return { ...r, bad: await badInState(r.state) };
      });
      const named = not(artifact).test(text);
      const full = text.includes("FULL STACK DEPLOYED");
      if (ok || full || !named || bad.length) {
        green.push(`send ${send} (${artifact}): ok ${ok}, named ${named}`);
      }
    }
    expect(green, "swaps not stopped by name").to.deep.equal([]);
  });

  for (const [mode, edit, re] of [
    ["the wrong code (STOP)", stop, (a) => not(a)],
    ["no code (a self-transfer)", skip, none],
  ]) {
    for (const [opt, artifact, nth] of SITES) {
      it(`A/B: option ${opt}'s ${artifact}#${nth} mined with ${mode} stops the option naming it; state holds no contract without its code`, async function () {
        const { hits, text, bad } = await fresh(async () => {
          const r = await site(opt, artifact, nth, edit);
          return { ...r, bad: await badInState(r.state) };
        });
        expect(hits, "the creation was made and edited once").to.equal(1);
        expect(text).to.match(re(artifact));
        expect(bad).to.deep.equal([]);
      });
    }
  }
});
