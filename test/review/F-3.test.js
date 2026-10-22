// Review F-3 (ported from the reviewer's F-6.test.js, inverted): options
// 74, 51 and 61 register their contracts in demo state only once their
// wiring is on chain and never swallow a failure, and option 1a reads the
// wiring back from chain before it reports FULL STACK DEPLOYED.
const { expect } = require("chai");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const { EnhancedLogger } = require("../../demo/logging");
const {
  capture,
  ask,
  baseStack,
  swap,
  oneClick,
} = require("../helpers/deployFlows");

describe("F-3 the deploy flows report success only after their wiring", function () {
  this.timeout(300000);

  it("74: a failure in its wiring stops option 1a, registers nothing, and 74 runs again", async function () {
    const { state, deployer } = await baseStack();
    const real = state.getContract("complianceRules");
    state.setContract(
      "complianceRules",
      swap(real, "setRuleAdministrator", async () => {
        throw new Error("nonce too low (simulated RPC hiccup)");
      }),
    );
    const { ok, text, gov } = await oneClick(state, deployer);
    expect(ok).to.equal(false);
    expect(text).to.contain("nonce too low");
    expect(text).to.contain(
      "the deploy stopped; missing wiring: VanguardGovernance rule administrator for VSC, VanguardGovernance rule administrator for VGT",
    );
    expect(text).to.contain("STOPPED AT STEP 5 OF 5");
    expect(text).to.match(/Governance system +stopped here/);
    expect(text).to.not.contain("FULL STACK DEPLOYED");
    expect(state.getContract("governanceToken")).to.equal(undefined);
    expect(state.getContract("vanguardGovernance")).to.equal(undefined);

    state.setContract("complianceRules", real);
    const [, again] = await capture(() => gov.deployGovernanceSystem());
    expect(again.join("\n")).to.not.contain("already deployed");
    const govAddr = await state.getContract("vanguardGovernance").getAddress();
    const vsc = await state.getContract("digitalToken").getAddress();
    expect(await real.ruleAdministrators(vsc, govAddr)).to.equal(true);
  });

  it("1a reads the wiring back: a call that returns without its effect stops it", async function () {
    const { state, deployer } = await baseStack();
    const real = state.getContract("complianceRules");
    state.setContract(
      "complianceRules",
      swap(real, "setRuleAdministrator", async () => ({
        wait: async () => ({}),
      })),
    );
    const { ok, text } = await oneClick(state, deployer);
    expect(ok).to.equal(false);
    expect(text).to.contain(
      "the deploy stopped; missing wiring: VanguardGovernance rule administrator for VSC, VanguardGovernance rule administrator for VGT",
    );
    expect(text).to.not.contain("FULL STACK DEPLOYED");
  });

  it("51: a failure wiring the registry into VSC throws and registers no registry", async function () {
    const { state } = await baseStack();
    state.setContract(
      "digitalToken",
      swap(
        state.getContract("digitalToken"),
        "setInvestorTypeRegistry",
        async () => {
          throw new Error("rejected at the signer (simulated)");
        },
      ),
    );
    const m = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    let err = "";
    const [, out] = await capture(() =>
      m.deployInvestorTypeSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.contain("rejected at the signer");
    expect(out.join("\n")).to.contain(
      "the deploy stopped; missing wiring: VSC investor type registry",
    );
    expect(state.getContract("investorTypeRegistry")).to.equal(undefined);
  });

  it("61: a failure naming the factory a registrar throws and registers no factory", async function () {
    const { state } = await baseStack();
    const real = state.getContract("complianceRules");
    state.setContract(
      "complianceRules",
      swap(real, "connect", (s) =>
        swap(real.connect(s), "setTrustedRegistrar", async () => {
          throw new Error("registrar call rejected (simulated)");
        }),
      ),
    );
    const m = new EscrowModule(state, new EnhancedLogger(), ask);
    let err = "";
    const [, out] = await capture(() =>
      m.deployEscrowSystem().catch((e) => (err = e.message)),
    );
    expect(err).to.contain("registrar call rejected");
    expect(out.join("\n")).to.contain(
      "the deploy stopped; missing wiring: escrow factory registrar on VSC",
    );
    expect(state.getContract("escrowFactory")).to.equal(undefined);
  });
});
