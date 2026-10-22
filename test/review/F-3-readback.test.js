// Review F-3, round 2 (ported from the swarm's attack-u2-wiring,
// inverted): the read-back names every link the deploy flows make, so a
// call that returns without its effect stops option 1a; option 74's own
// success depends on its links read back from chain (a re-run after a
// stop past its step 6 does not report a deploy whose VGT ComplianceRules
// does not record); options 51 and 61 stop when their manager or factory
// cannot be named a registrar instead of reporting success after a
// warning.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const { EnhancedLogger } = require("../../demo/logging");
const {
  capture,
  ask,
  baseStack,
  swap,
  swapDeployed,
  oneClick,
} = require("../helpers/deployFlows");

/** ComplianceRules owned by a wallet that is neither the deployer nor governance. */
async function rulesElsewhere(state) {
  const rules = state.getContract("complianceRules");
  const other = state.signers[15];
  await (await rules.transferOwnership(other.address)).wait();
  await (await rules.connect(other).acceptOwnership()).wait();
}

const noop = async () => ({ wait: async () => ({}) });
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

describe("F-3 the read-back names every link the deploy flows make", function () {
  this.timeout(300000);

  it("W1: the deployer's rule administration of VGT not made stops 1a", async function () {
    const { state, deployer } = await baseStack();
    const real = state.getContract("complianceRules");
    const vsc = await state.getContract("digitalToken").getAddress();
    const dep = state.signers[0].address;
    state.setContract(
      "complianceRules",
      swap(real, "setRuleAdministrator", async (t, who, on) =>
        same(who, dep) && !same(t, vsc)
          ? noop()
          : real.setRuleAdministrator(t, who, on),
      ),
    );
    const { ok, text } = await oneClick(state, deployer);
    expect(ok).to.equal(false);
    expect(text).to.match(
      /the deploy stopped; missing wiring: [^\n]*deployer rule administrator for VGT \(until the handover\)/,
    );
    expect(text).to.not.contain("FULL STACK DEPLOYED");
  });

  it("W2: a registry that never authorized VSC stops 1a", async function () {
    const { state, deployer } = await baseStack();
    const restore = swapDeployed(
      "InvestorTypeRegistry",
      "authorizeToken",
      noop,
    );
    let res;
    try {
      res = await oneClick(state, deployer);
    } finally {
      restore();
    }
    expect(res.ok).to.equal(false);
    expect(res.text).to.match(
      /missing wiring: [^\n]*VSC authorized on InvestorTypeRegistry/,
    );
    expect(res.text).to.not.contain("FULL STACK DEPLOYED");
  });

  it("W4: 74 re-run after a stop past its step 6 does not report success", async function () {
    const { state, deployer } = await baseStack();
    await capture(() => deployer.deployOracleSystem());
    const inv = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    await capture(() => inv.deployInvestorTypeSystem());
    const types = state.getContract("investorTypeRegistry");
    state.setContract(
      "investorTypeRegistry",
      swap(types, "transferOwnership", async () => {
        throw new Error("nomination rejected (simulated)");
      }),
    );
    const gov = new GovernanceModule(state, new EnhancedLogger(), ask);
    let err = "";
    await capture(() =>
      gov.deployGovernanceSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.contain("nomination rejected");
    state.setContract("investorTypeRegistry", types);
    err = "";
    const [, out] = await capture(() =>
      gov.deployGovernanceSystem().catch((e) => (err = e.message)),
    );
    const text = out.join("\n");
    expect(err).to.match(
      /missing wiring: VGT recorded as the governance token/,
    );
    expect(text).to.contain(
      "the deploy stopped; missing wiring: VGT recorded as the governance token",
    );
    expect(text).to.not.contain("GOVERNANCE TOKEN SYSTEM DEPLOYED");
    expect(state.getContract("governanceToken")).to.equal(undefined);
  });

  it("51: a manager that cannot be named a registrar stops it", async function () {
    const { state } = await baseStack();
    await rulesElsewhere(state);
    const m = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    let err = "";
    const [, out] = await capture(() =>
      m.deployInvestorTypeSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.match(
      /Manager is not a registrar: ComplianceRules is owned by/,
    );
    expect(out.join("\n")).to.not.contain("SYSTEM DEPLOYED SUCCESSFULLY");
    expect(state.getContract("investorTypeRegistry")).to.equal(undefined);
  });

  it("61: a factory that cannot be named a registrar stops it", async function () {
    const { state } = await baseStack();
    await rulesElsewhere(state);
    const m = new EscrowModule(state, new EnhancedLogger(), ask);
    let err = "";
    const [, out] = await capture(() =>
      m.deployEscrowSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.match(
      /Factory is not a registrar: ComplianceRules is owned by/,
    );
    expect(out.join("\n")).to.not.contain("SYSTEM DEPLOYED SUCCESSFULLY");
    expect(state.getContract("escrowFactory")).to.equal(undefined);
  });
});
