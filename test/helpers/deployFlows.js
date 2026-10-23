// Review F-3: the demo deploy flows (options 1, 13, 21, 31, 51, 74, 61)
// over the in-process chain, their output captured, and a contract with
// one function answered by a stand-in (a call that fails or does nothing),
// or one sent call replaced at the provider (found by target, function
// and arguments).
const { ethers, network, artifacts } = require("hardhat");
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

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

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

/**
 * Run `fn` with each eth_sendTransaction to `spec.target()` calling
 * `spec.fn` of contract `spec.name` with arguments `spec.match` accepts
 * sent as `spec.edit(tx, args, iface)` instead; returns [result, hits].
 */
async function editing(spec, fn) {
  const i = new ethers.Interface((await artifacts.readArtifact(spec.name)).abi);
  const sel = i.getFunction(spec.fn).selector;
  const p = network.provider;
  const [request, send] = [p.request.bind(p), p.send.bind(p)];
  let hits = 0;
  const shim = async (a) => {
    const tx = a.method === "eth_sendTransaction" ? a.params[0] : null;
    const data = tx && (tx.data || tx.input);
    if (tx?.to && same(tx.to, await spec.target()) && data?.startsWith(sel)) {
      const args = i.decodeFunctionData(spec.fn, data);
      if (await spec.match(args)) {
        hits++;
        return request({ method: a.method, params: [spec.edit(tx, args, i)] });
      }
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

/** Mined, status 1, no effect: a self-transfer of nothing. */
const skip = (tx) => {
  const out = { ...tx, to: tx.from, value: "0x0" };
  delete out.data;
  delete out.input;
  return out;
};

module.exports = {
  capture,
  ask,
  baseStack,
  swap,
  swapDeployed,
  oneClick,
  editing,
  skip,
};
