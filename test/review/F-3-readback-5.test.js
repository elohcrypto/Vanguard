// Review F-3, round 5 (lane D-3's sweep case tx36 and the round-4
// attacker's 1a word flips, inverted): a contract deploy mined without
// creating its contract stops the option naming the contract, which never
// enters demo state; each oracle node is registered with the deploy's
// name, description and reputation, or option 31 stops naming the link.
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask, editing, skip } = require("../helpers/deployFlows");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NODES = "oracle nodes registered on OracleManager (until the handover)";

/** Option 1a over a fresh demo state. */
async function run1a() {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const logger = new EnhancedLogger();
  const deployer = new ContractDeployer(state, logger);
  const modules = {
    investorType: new InvestorTypeModule(state, logger, ask),
    governance: new GovernanceModule(state, logger, ask),
  };
  const [ok, lines] = await capture(() => deployer.deployEverything(modules));
  return { ok, text: lines.join("\n"), state };
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

/** `fn` with the first deploy of `name`'s creation code sent as `edit(tx)`. */
async function creating(name, edit, fn) {
  const { bytecode } = await artifacts.readArtifact(name);
  const p = network.provider;
  const [request, send] = [p.request.bind(p), p.send.bind(p)];
  let hits = 0;
  const shim = async (a) => {
    const tx = a.method === "eth_sendTransaction" ? a.params[0] : null;
    const data = String(tx?.data ?? tx?.input ?? "").toLowerCase();
    if (tx && !tx.to && !hits && data.startsWith(bytecode.toLowerCase())) {
      hits++;
      return request({ method: a.method, params: [edit(tx)] });
    }
    return request(a);
  };
  p.request = shim;
  p.send = (m, x) => shim({ method: m, params: x ?? [] });
  try {
    return [await fn(), hits];
  } finally {
    [p.request, p.send] = [request, send];
  }
}

describe("F-3 round 5: 1a reads each contract's code and each oracle node's registration back", function () {
  this.timeout(600000);
  let at;
  let honest;
  before(async function () {
    honest = await fresh(run1a);
    at = {};
    for (const [k, c] of Object.entries(honest.state.contracts)) {
      if (c?.target) at[k] = c.target;
    }
  });

  it("the honest 1a reports FULL STACK DEPLOYED", async function () {
    expect(honest.ok).to.equal(true);
    expect(honest.text).to.contain("FULL STACK DEPLOYED");
  });

  it("a WhitelistOracle deploy mined without creating it stops 1a at step 3 naming it; demo state holds no whitelistOracle", async function () {
    const [{ ok, text, state }, hits] = await fresh(() =>
      creating("WhitelistOracle", skip, run1a),
    );
    expect(hits, "the deploy was made and skipped once").to.equal(1);
    expect(ok).to.equal(false);
    expect(text).to.match(
      /Step 3 \(Oracle system\) threw: WhitelistOracle at 0x[0-9a-fA-F]{40} has no code: its deploy transaction mined without creating it/,
    );
    expect(text).to.contain("STOPPED AT STEP 3 OF 5");
    expect(text).to.not.contain("FULL STACK DEPLOYED");
    expect(state.getContract("whitelistOracle")).to.equal(undefined);
  });

  for (const [field, i, edit] of [
    ["reputation", 1, (a) => [a[0], a[1], a[2], a[3] ^ 1n]],
    ["name", 2, (a) => [a[0], a[1] + "\u0000", a[2], a[3]]],
    ["description", 3, (a) => [a[0], a[1], a[2] + "\u0000", a[3]]],
  ]) {
    it(`OracleManager.registerOracle for node ${i} with another ${field} stops 1a at step 3 naming "${NODES}"`, async function () {
      const node = (await ethers.getSigners())[i].address;
      const spec = {
        name: "OracleManager",
        fn: "registerOracle",
        target: () => at.oracleManager,
        match: (a) => same(a[0], node),
        edit: (tx, a, iface) => {
          const { input, ...rest } = tx;
          const data = iface.encodeFunctionData("registerOracle", edit(a));
          return { ...rest, data };
        },
      };
      const [{ ok, text }, hits] = await fresh(() => editing(spec, run1a));
      expect(hits, "the call was made and edited once").to.equal(1);
      expect(ok).to.equal(false);
      expect(text).to.match(
        new RegExp(
          `Step 3 \\(Oracle system\\) threw: missing wiring: [^\\n]*${esc(NODES)}`,
        ),
      );
      expect(text).to.contain("STOPPED AT STEP 3 OF 5");
      expect(text).to.not.contain("FULL STACK DEPLOYED");
    });
  }
});
