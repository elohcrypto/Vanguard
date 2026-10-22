// Review F-3, round 3 (ported from the swarm's attack-u2r2-wiring R1-R7
// and R9, inverted): a wiring call that returns without its effect stops
// the option that makes it (1, 21, 31, 51), so option 1a stops at that
// step naming the link and never reports FULL STACK DEPLOYED, and the
// production deploy stops with it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { missingWiring } = require("../../demo/utils/DeployWiring");
const { deployStack } = require("../../scripts/production/DeployProduction");
const { resolveInputs } = require("../../scripts/production/deployConfig");
const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");
const { capture, ask, baseStack } = require("../helpers/deployFlows");

const noop = async () => ({
  wait: async () => ({ gasUsed: 0n, blockNumber: 0 }),
  hash: "0x" + "00".repeat(32),
});
const nth = (k) => {
  let n = 0;
  return () => ++n === k;
};

/** The next `name` deploys answer `fn` with a no-op when `when()`; returns [restore, deployed]. */
function skipCall(name, fn, when = () => true) {
  const orig = ethers.getContractFactory;
  const deployed = [];
  const bind = (t, p) => {
    const v = Reflect.get(t, p);
    return typeof v === "function" ? v.bind(t) : v;
  };
  ethers.getContractFactory = async (n, ...a) => {
    const f = await orig.call(ethers, n, ...a);
    if (n !== name) return f;
    return new Proxy(f, {
      get: (t, p) =>
        p !== "deploy"
          ? bind(t, p)
          : async (...x) => {
              const c = new Proxy(await t.deploy(...x), {
                get: (ct, cp) =>
                  cp !== fn
                    ? bind(ct, cp)
                    : (...args) => (when() ? noop() : ct[fn](...args)),
              });
              deployed.push(c);
              return c;
            },
    });
  };
  return [() => (ethers.getContractFactory = orig), deployed];
}

/** Option 1a over a fresh demo state with one call skipped. */
async function run1a(name, fn, when) {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const logger = new EnhancedLogger();
  const deployer = new ContractDeployer(state, logger);
  const modules = {
    investorType: new InvestorTypeModule(state, logger, ask),
    governance: new GovernanceModule(state, logger, ask),
  };
  const [restore] = skipCall(name, fn, when);
  try {
    const [ok, lines] = await capture(() => deployer.deployEverything(modules));
    return { ok, text: lines.join("\n"), state };
  } finally {
    restore();
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("F-3 round 3: each deploy option reads its own links back", function () {
  this.timeout(600000);

  const cases = [
    [
      "R1",
      "OnchainIDFactory",
      "setRecoveryManager",
      undefined,
      1,
      "KeyManager recovery manager on OnchainIDFactory",
    ],
    [
      "R2",
      "IdentityRegistry",
      "addAgent",
      nth(1),
      2,
      "VSC agent on IdentityRegistry (recovery)",
    ],
    [
      "R3",
      "IdentityRegistry",
      "setComplianceRules",
      undefined,
      2,
      "ComplianceRules jurisdiction check on IdentityRegistry",
    ],
    [
      "R4",
      "OracleManager",
      "setConsensusEngine",
      undefined,
      3,
      "ConsensusOracle engine on OracleManager",
    ],
    [
      "R5",
      "OracleManager",
      "registerOracle",
      nth(3),
      3,
      "oracle nodes registered on OracleManager (until the handover)",
    ],
    [
      "R6",
      "ComplianceRules",
      "setBlacklistOracle",
      undefined,
      3,
      "VSC blacklist oracle in ComplianceRules",
    ],
    [
      "R7",
      "ComplianceRules",
      "setPrivacyManager",
      undefined,
      2,
      "VSC PrivacyManager in ComplianceRules",
    ],
  ];
  const option = ["1", "21", "31"];
  const success = [
    "ALL CONTRACTS DEPLOYED SUCCESSFULLY",
    "ERC-3643 DIGITAL TOKEN SYSTEM DEPLOYED",
    "Oracle Management System deployed successfully",
  ];
  // Options 1 and 31 register their contracts only once read back; 21's
  // later steps read its token from state, so the token stays there.
  const unset = ["onchainIDFactory", null, "oracleManager"];
  for (const [id, name, fn, when, step, link] of cases) {
    it(`${id}: ${name}.${fn} without effect stops option ${option[step - 1]} and 1a at step ${step}`, async function () {
      const { ok, text, state } = await run1a(name, fn, when);
      expect(ok).to.equal(false);
      expect(text).to.match(
        new RegExp(
          `Step ${step} \\([^)]*\\) threw: missing wiring: [^\\n]*${esc(link)}`,
        ),
      );
      expect(text).to.match(
        new RegExp(`the deploy stopped; missing wiring: [^\\n]*${esc(link)}`),
      );
      expect(text).to.contain(`STOPPED AT STEP ${step} OF 5`);
      expect(text).to.not.contain(success[step - 1]);
      expect(text).to.not.contain("FULL STACK DEPLOYED");
      if (unset[step - 1]) {
        expect(state.getContract(unset[step - 1])).to.equal(undefined);
      }
    });
  }

  it("R9: option 51 does not report success with the central bank not exempt", async function () {
    const { state } = await baseStack();
    const bank = state.signers[5];
    state.bankingInstitutions.set(bank.address, {
      type: "CENTRAL_BANK",
      address: bank.address,
    });
    const [restore, deployed] = skipCall(
      "InvestorTypeRegistry",
      "setInvestorLimitExempt",
    );
    let err = "";
    let out;
    try {
      const m = new InvestorTypeModule(state, new EnhancedLogger(), ask);
      [, out] = await capture(() =>
        m.deployInvestorTypeSystem().catch((e) => (err = e.message)),
      );
    } finally {
      restore();
    }
    const link =
      "central bank exempt from investor limits (until the handover)";
    expect(err).to.equal(`missing wiring: ${link}`);
    expect(out.join("\n")).to.contain(
      `the deploy stopped; missing wiring: ${link}`,
    );
    expect(out.join("\n")).to.not.contain("DEPLOYED SUCCESSFULLY");
    expect(state.getContract("investorTypeRegistry")).to.equal(undefined);
    const [types] = deployed;
    expect(await types.investorLimitExempt(bank.address)).to.equal(false);
    expect(
      await missingWiring(state, { investorTypeRegistry: types }),
    ).to.deep.equal([link]);
  });

  it("the production deploy stops on an oracle node left unregistered (R5)", async function () {
    const accounts = (await ethers.getSigners()).map((s) => s.address);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const inputs = resolveInputs(
      { attestor: { Ax: Ax.toString(), Ay: Ay.toString() } },
      31337,
      accounts,
    );
    const [restore] = skipCall("OracleManager", "registerOracle", nth(3));
    let err = "";
    let out;
    try {
      [, out] = await capture(() =>
        deployStack(inputs, ethers.hexlify(ethers.randomBytes(32)), undefined)
          .then(() => "")
          .catch((e) => (err = e.message)),
      );
    } finally {
      restore();
    }
    expect(err).to.match(/^the deploy stopped/);
    expect(out.join("\n")).to.contain(
      "the deploy stopped; missing wiring: oracle nodes registered on OracleManager (until the handover)",
    );
    expect(out.join("\n")).to.not.contain("Wiring read back from chain");
  });

  it("after the handover the node set and treasury exemptions are governance's", async function () {
    const { state, deployer } = await baseStack();
    const bank = state.signers[5];
    state.bankingInstitutions.set(bank.address, {
      type: "CENTRAL_BANK",
      address: bank.address,
    });
    await capture(() => deployer.deployOracleSystem());
    const m = new InvestorTypeModule(state, new EnhancedLogger(), ask);
    await capture(() => m.deployInvestorTypeSystem());
    expect(await missingWiring(state)).to.deep.equal([]);
    const gov = state.signers[15];
    const [om, types] = ["oracleManager", "investorTypeRegistry"].map((k) =>
      state.getContract(k),
    );
    for (const c of [om, types]) {
      await (await c.transferOwnership(gov.address)).wait();
      await (await c.connect(gov).acceptOwnership()).wait();
    }
    const node = state.signers[3].address;
    await (await om.connect(gov).removeOracle(node, "rotated")).wait();
    await (
      await types.connect(gov).setInvestorLimitExempt(bank.address, false)
    ).wait();
    expect(await missingWiring(state)).to.deep.equal([]);
  });
});
