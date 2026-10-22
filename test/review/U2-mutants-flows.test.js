// Review U2 rounds 2 and 3 (the swarm's surviving mutants M17, M18, M19,
// M30, and the read-back links): each case fails when its guard is
// removed.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const { EnhancedLogger } = require("../../demo/logging");
const { missingWiring } = require("../../demo/utils/DeployWiring");
const { deployStack } = require("../../scripts/production/DeployProduction");
const { resolveInputs } = require("../../scripts/production/deployConfig");
const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");
const everything = require("../../demo/utils/DeployEverythingFlow");
const {
  capture,
  ask,
  baseStack,
  swap,
  swapDeployed,
} = require("../helpers/deployFlows");

const noop = async () => ({ wait: async () => ({}) });

describe("U2 the deploy flows' read-back (mutants M17, M19, M30)", function () {
  this.timeout(600000);

  it("M17: the production deploy reads the escrow's links back after option 61", async function () {
    const accounts = (await ethers.getSigners()).map((s) => s.address);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const inputs = resolveInputs(
      { attestor: { Ax: Ax.toString(), Ay: Ay.toString() } },
      31337,
      accounts,
    );
    const restore = swapDeployed(
      "InvestorTypeRegistry",
      "setInvestorLimitExempt",
      noop,
    );
    let err = "";
    try {
      await capture(() =>
        deployStack(inputs, ethers.hexlify(ethers.randomBytes(32)), undefined)
          .then(() => "")
          .catch((e) => (err = e.message)),
      );
    } finally {
      restore();
    }
    expect(err).to.equal(
      "the deploy stopped; missing wiring: escrow fee wallet exempt from investor limits",
    );
  });

  it("M19: option 74 on its own throws when its wiring fails", async function () {
    const { state, deployer } = await baseStack();
    await capture(() => deployer.deployOracleSystem());
    const real = state.getContract("complianceRules");
    state.setContract(
      "complianceRules",
      swap(real, "setRuleAdministrator", async () => {
        throw new Error("nonce too low (simulated RPC hiccup)");
      }),
    );
    const gov = new GovernanceModule(state, new EnhancedLogger(), ask);
    let err = "";
    await capture(() =>
      gov.deployGovernanceSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.contain("nonce too low");
    expect(state.getContract("vanguardGovernance")).to.equal(undefined);
  });

  it("M30: option 74 on a node that mines only for a receipt waits for every link", async function () {
    const { state, deployer } = await baseStack();
    await capture(() => deployer.deployOracleSystem());
    const inv = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    await capture(() => inv.deployInvestorTypeSystem());
    const gov = new GovernanceModule(state, new EnhancedLogger(), ask);
    // A block only when a receipt is asked for: a call nobody waits for
    // is still pending when the next read runs.
    const p = network.provider;
    const [request, send] = [p.request.bind(p), p.send.bind(p)];
    const shim = async (a) => {
      if (a.method !== "eth_getTransactionReceipt") return request(a);
      const r = await request(a);
      if (r) return r;
      await request({ method: "evm_mine" });
      return request(a);
    };
    p.request = shim;
    p.send = (m, x) => shim({ method: m, params: x ?? [] });
    await request({ method: "evm_setAutomine", params: [false] });
    let err = "";
    try {
      await capture(() =>
        gov.deployGovernanceSystem().catch((e) => (err = e.message)),
      );
    } finally {
      [p.request, p.send] = [request, send];
      await request({ method: "evm_setAutomine", params: [true] });
      await request({ method: "evm_mine" });
    }
    expect(err).to.equal("");
    expect(await missingWiring(state)).to.deep.equal([]);
  });

  it("74 reads back only its own links: an escrow deployed before 51 does not stop it", async function () {
    const { state, deployer } = await baseStack();
    await capture(() => deployer.deployOracleSystem());
    const escrow = new EscrowModule(state, new EnhancedLogger(), ask);
    await capture(() => escrow.deployEscrowSystem()); // before the registry
    const inv = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    await capture(() => inv.deployInvestorTypeSystem());
    expect(await missingWiring(state)).to.deep.equal([
      "escrow fee wallet exempt from investor limits",
    ]);
    const gov = new GovernanceModule(state, new EnhancedLogger(), ask);
    let err = "";
    await capture(() =>
      gov.deployGovernanceSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.equal("");
    expect(state.getContract("vanguardGovernance")).to.not.equal(undefined);
  });

  it("the custody lock amounts a production config sets are read back", async function () {
    const amounts = ["1000", "3000", "5000"].map((x) => ethers.parseEther(x));
    const missing = async (swapped) => {
      const { state } = await baseStack();
      state.production = { lockRequirements: amounts };
      const restore = swapped
        ? swapDeployed("InvestorRequestManager", "updateLockRequirement", noop)
        : () => {};
      let err = "";
      try {
        const m = new InvestorTypeModule(state, new EnhancedLogger(), ask);
        await capture(() =>
          m.deployInvestorTypeSystem().catch((e) => (err = e.message)),
        );
      } finally {
        restore();
      }
      return [err, await missingWiring(state)];
    };
    expect(await missing(false)).to.deep.equal(["", []]);
    // Round 3: option 51 reads its own links back and stops on the miss.
    expect(await missing(true)).to.deep.equal([
      "missing wiring: custody lock requirements as configured",
      [],
    ]);
  });

  it("an escrow fee wallet that is no verified identity is read back missing", async function () {
    const { state } = await baseStack();
    const c = (k) => state.getContract(k).getAddress();
    const fee = ethers.Wallet.createRandom().address;
    const escrow = await (
      await ethers.getContractFactory("EscrowWalletFactory")
    ).deploy(
      await c("digitalToken"),
      fee,
      await c("identityRegistry"),
      await c("complianceRules"),
    );
    state.setContract("escrowFactory", escrow);
    expect(await missingWiring(state)).to.include("escrow fee wallet verified");
  });

  it("M18: a later step undoing an earlier option's link stops 1a at that step", async function () {
    const { state, deployer } = await baseStack();
    await capture(() => deployer.deployOracleSystem());
    const rules = state.getContract("complianceRules");
    const vsc = await state.getContract("digitalToken").getAddress();
    const investorType = new InvestorTypeModule(
      state,
      new EnhancedLogger(),
      ask,
    );
    const real = investorType.deployInvestorTypeSystem.bind(investorType);
    // 51 reads only its own links back; 1a reads every link after a step
    investorType.deployInvestorTypeSystem = async () => {
      await real();
      await (await rules.setBlacklistOracle(vsc, ethers.ZeroAddress)).wait();
    };
    const mod = {
      state,
      deployAllContracts: async () => {},
      deployDigitalTokenSystem: async () => {},
      deployOracleSystem: async () => {},
    };
    mod._reportDeploySummary = (done, steps, reached) =>
      everything._reportDeploySummary(mod, done, steps, reached);
    const governance = new GovernanceModule(state, new EnhancedLogger(), ask);
    const [ok, out] = await capture(() =>
      everything.deployEverything(mod, { investorType, governance }),
    );
    expect(ok).to.equal(false);
    expect(out.join("\n")).to.match(
      /Step 4 \(Investor Type Registry\): the deploy stopped; missing wiring: [^\n]*VSC blacklist oracle in ComplianceRules/,
    );
    expect(state.getContract("vanguardGovernance")).to.equal(undefined);
  });
});
