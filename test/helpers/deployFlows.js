// Review F-3: the demo deploy flows (options 1, 13, 21, 31, 51, 74, 61)
// over the in-process chain, their output captured, and a contract with
// one function answered by a stand-in (a call that fails or does nothing).
const { ethers } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const everything = require("../../demo/utils/DeployEverythingFlow");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");

/** Run fn with console.log/error captured; returns [result, lines]. */
async function capture(fn) {
  const lines = [];
  const [l, e] = [console.log, console.error];
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return [await fn(), lines];
  } finally {
    [console.log, console.error] = [l, e];
  }
}

const ask = async (q) => {
  throw new Error(`asked: ${q}`);
};

/** Options 1, 13 and 21 deployed, as the smoke does. */
async function baseStack() {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const deployer = new ContractDeployer(state, new EnhancedLogger());
  await capture(async () => {
    await deployer.deployAllContracts();
    await deployer.deployComplianceRules();
    await deployer.deployDigitalTokenSystem();
  });
  return { state, deployer };
}

/** `real` with `fn` answered by `impl` (the rest bound to the contract). */
function swap(real, fn, impl) {
  return new Proxy(real, {
    get(t, p) {
      if (p === fn) return impl;
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** ethers.getContractFactory(name)'s next deploys answer `fn` with `impl`. */
function swapDeployed(name, fn, impl) {
  const orig = ethers.getContractFactory;
  ethers.getContractFactory = async (n, ...a) => {
    const f = await orig.call(ethers, n, ...a);
    if (n !== name) return f;
    return swap(f, "deploy", async (...x) =>
      swap(await f.deploy(...x), fn, impl),
    );
  };
  return () => (ethers.getContractFactory = orig);
}

/** Option 1a's last two steps (51, 74) over the base stack and the oracles. */
async function oneClick(state, deployer) {
  await capture(() => deployer.deployOracleSystem());
  const gov = new GovernanceModule(state, new EnhancedLogger(), ask);
  const mod = {
    state,
    deployAllContracts: async () => {},
    deployDigitalTokenSystem: async () => {},
    deployOracleSystem: async () => {},
  };
  mod._reportDeploySummary = (done, steps, reached) =>
    everything._reportDeploySummary(mod, done, steps, reached);
  const modules = {
    investorType: new InvestorTypeModule(state, new EnhancedLogger(), ask),
    governance: gov,
  };
  const [ok, out] = await capture(() =>
    everything.deployEverything(mod, modules),
  );
  return { ok, text: out.join("\n"), gov };
}

module.exports = { capture, ask, baseStack, swap, swapDeployed, oneClick };
