// Review F-3, round 4 (ported from the swarm's attack-u2r3-wiring skip
// table, inverted): each call option 1a makes on PrivacyManager (the
// issuer key for each attestation circuit, the default policies, the
// jurisdiction policy token, each allowed code's bit) and the deployer's
// rule administration of VSC, mined without its effect, stops the option
// that makes it naming the link, so 1a never reports FULL STACK DEPLOYED;
// the production deploy stops with it. A call is found by its target,
// function and arguments, not by its place in the run.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { wiring, missingWiring } = require("../../demo/utils/DeployWiring");
const {
  DEFAULT_ALLOWED_COUNTRIES,
} = require("../../demo/utils/DeployDefaults");
const { deployStack } = require("../../scripts/production/DeployProduction");
const { resolveInputs } = require("../../scripts/production/deployConfig");
const {
  CIRCUITS,
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");
const { capture, ask, editing, skip } = require("../helpers/deployFlows");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LINK = {
  attestor:
    "issuer key trusted on PrivacyManager for each attestation circuit (until the handover)",
  accreditation:
    "PrivacyManager minimum accreditation policy (until the handover)",
  compliance:
    "PrivacyManager compliance aggregation policy (until the handover)",
  admin: "deployer rule administrator for VSC (until the handover)",
  policyToken:
    "VSC jurisdiction policy token on PrivacyManager (until the handover)",
  bits: "jurisdiction bit for each allowed VSC code on PrivacyManager (until the handover)",
  locks: "custody lock requirements as configured",
};
const STEP = {
  1: "Core contracts",
  2: "ERC-3643 token + ComplianceRules",
  4: "Investor Type Registry",
};

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

describe("F-3 round 4: option 1a's PrivacyManager, rule administrator and custody links read back", function () {
  this.timeout(600000);
  // From the honest run: a chain reverted to the same snapshot deploys
  // each contract at the same address again.
  let at;
  let honest;
  before(async function () {
    honest = await fresh(async () => {
      const r = await run1a();
      return { ...r, links: await wiring(r.state) };
    });
    at = {};
    for (const [k, c] of Object.entries(honest.state.contracts)) {
      if (c?.target) at[k] = c.target;
    }
  });

  it("the honest 1a reports FULL STACK DEPLOYED with every one of these links read true", async function () {
    expect(honest.ok).to.equal(true);
    expect(honest.text).to.contain("FULL STACK DEPLOYED");
    for (const name of Object.values(LINK)) {
      expect(honest.links).to.deep.include({ name, ok: true });
    }
  });

  const deployer = async () => (await ethers.getSigners())[0].address;
  const rows = [
    ...Object.entries(CIRCUITS).map(([circuit, { id }]) => [
      `PrivacyManager.setTrustedAttestor (${circuit})`,
      {
        name: "PrivacyManager",
        key: "privacyManager",
        fn: "setTrustedAttestor",
      },
      (a) => a[0] === id,
      1,
      LINK.attestor,
    ]),
    [
      "PrivacyManager.setMinimumAccreditation",
      {
        name: "PrivacyManager",
        key: "privacyManager",
        fn: "setMinimumAccreditation",
      },
      () => true,
      1,
      LINK.accreditation,
    ],
    [
      "PrivacyManager.setCompliancePolicy",
      {
        name: "PrivacyManager",
        key: "privacyManager",
        fn: "setCompliancePolicy",
      },
      () => true,
      1,
      LINK.compliance,
    ],
    [
      "ComplianceRules.setRuleAdministrator(VSC, deployer, true)",
      {
        name: "ComplianceRules",
        key: "complianceRules",
        fn: "setRuleAdministrator",
      },
      async (a) =>
        same(a[0], at.digitalToken) && same(a[1], await deployer()) && a[2],
      2,
      LINK.admin,
    ],
    [
      "PrivacyManager.setPolicyToken",
      { name: "PrivacyManager", key: "privacyManager", fn: "setPolicyToken" },
      () => true,
      2,
      LINK.policyToken,
    ],
    ...DEFAULT_ALLOWED_COUNTRIES.map((code) => [
      `PrivacyManager.registerJurisdictionCode(${code})`,
      {
        name: "PrivacyManager",
        key: "privacyManager",
        fn: "registerJurisdictionCode",
      },
      (a) => a[0] === BigInt(code),
      2,
      LINK.bits,
    ]),
  ];
  for (const [label, call, match, step, link] of rows) {
    it(`${label} without effect stops 1a at step ${step} naming "${link}"`, async function () {
      const spec = { ...call, target: () => at[call.key], match, edit: skip };
      const [{ ok, text }, hits] = await fresh(() => editing(spec, run1a));
      expect(hits, "the call was made and skipped once").to.equal(1);
      expect(ok).to.equal(false);
      expect(text).to.match(
        new RegExp(
          `Step ${step} \\(${esc(STEP[step])}\\) threw: missing wiring: [^\\n]*${esc(link)}`,
        ),
      );
      expect(text).to.match(
        new RegExp(`the deploy stopped; missing wiring: [^\\n]*${esc(link)}`),
      );
      expect(text).to.contain(`STOPPED AT STEP ${step} OF 5`);
      expect(text).to.not.contain("FULL STACK DEPLOYED");
    });
  }

  it("a step-1 stop keeps the half-wired PrivacyManager out of demo state", async function () {
    const spec = {
      name: "PrivacyManager",
      fn: "setMinimumAccreditation",
      target: () => at.privacyManager,
      match: () => true,
      edit: skip,
    };
    const [{ ok, text, state }, hits] = await fresh(() => editing(spec, run1a));
    expect(hits, "the call was made and skipped once").to.equal(1);
    expect(ok).to.equal(false);
    expect(text).to.contain("STOPPED AT STEP 1 OF 5");
    // deployPrivacyPair reuses a PrivacyManager it finds in state
    expect(state.getContract("privacyManager")).to.equal(undefined);
  });

  // A skipped demo updateLockRequirement leaves the chain as it was: the
  // manager's constructor sets the same D45 amounts (cap/4, cap/2, cap).
  // A lock set to another amount is what the read-back can see.
  for (const type of [1, 2, 3]) {
    it(`InvestorRequestManager.updateLockRequirement(${type}) to another amount stops 1a at step 4`, async function () {
      const spec = {
        name: "InvestorRequestManager",
        fn: "updateLockRequirement",
        target: () => at.investorRequestManager,
        match: (a) => a[0] === BigInt(type),
        edit: (tx, a, i) => {
          const { input, ...rest } = tx;
          const data = i.encodeFunctionData("updateLockRequirement", [
            a[0],
            a[1] - 1n,
          ]);
          return { ...rest, data };
        },
      };
      const [{ ok, text }, hits] = await fresh(() => editing(spec, run1a));
      expect(hits, "the call was made and edited once").to.equal(1);
      expect(ok).to.equal(false);
      expect(text).to.match(
        new RegExp(
          `Step 4 \\(${esc(STEP[4])}\\) threw: missing wiring: [^\\n]*${esc(LINK.locks)}`,
        ),
      );
      expect(text).to.contain("STOPPED AT STEP 4 OF 5");
      expect(text).to.not.contain("FULL STACK DEPLOYED");
    });
  }

  it("the production deploy stops on its configured issuer key left untrusted", async function () {
    const accounts = (await ethers.getSigners()).map((s) => s.address);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const inputs = resolveInputs(
      { attestor: { Ax: Ax.toString(), Ay: Ay.toString() } },
      31337,
      accounts,
    );
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const deploy = () => deployStack(inputs, salt, undefined);
    const [state] = await fresh(() => capture(deploy));
    const spec = {
      name: "PrivacyManager",
      fn: "setTrustedAttestor",
      target: () => state.getContract("privacyManager").target,
      match: (a) => a[0] === CIRCUITS.compliance.id && a[1] === Ax,
      edit: skip,
    };
    let err = "";
    const [[, out], hits] = await fresh(() =>
      editing(spec, () =>
        capture(() => deploy().catch((e) => (err = e.message))),
      ),
    );
    expect(hits, "the call was made and skipped once").to.equal(1);
    expect(err).to.match(/^the deploy stopped/);
    expect(out.join("\n")).to.contain(
      `the deploy stopped; missing wiring: ${LINK.attestor}`,
    );
    expect(out.join("\n")).to.not.contain("Wiring read back from chain");
  });

  it("after the handover the issuer key, policies, policy token, bits, VSC rule administrator and demo lock amounts are governance's", async function () {
    await fresh(async () => {
      const { state } = await run1a();
      expect(await missingWiring(state)).to.deep.equal([]);
      // VanguardGovernance's own key stands in for its acceptance votes.
      const g = state.getContract("vanguardGovernance").target;
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [g],
      });
      await network.provider.request({
        method: "hardhat_setBalance",
        params: [g, "0x56bc75e2d63100000"],
      });
      const gov = await ethers.getSigner(g);
      const [pm, rules, types] = [
        "privacyManager",
        "complianceRules",
        "investorTypeRegistry",
      ].map((k) => state.getContract(k));
      for (const c of [pm, rules, types]) {
        await (await c.transferOwnership(gov.address)).wait();
        await (await c.connect(gov).acceptOwnership()).wait();
      }
      const vsc = state.getContract("digitalToken").target;
      const vgt = state.getContract("governanceToken").target;
      const dep = state.signers[0].address;
      const { Ax, Ay } = await attestorPublicKey(state.attestorKey);
      const send = async (p) => (await p).wait();
      const jur = CIRCUITS.jurisdiction.id;
      await send(pm.connect(gov).setTrustedAttestor(jur, Ax, Ay, false));
      await send(pm.connect(gov).setMinimumAccreditation(1n));
      await send(pm.connect(gov).setCompliancePolicy(50n, 40n, 20n, 20n, 20n));
      await send(rules.connect(gov).setRuleAdministrator(vsc, dep, false));
      await send(
        rules.connect(gov).setRuleAdministrator(vsc, gov.address, true),
      );
      const [, allowed, blocked] = await rules.getJurisdictionRule(vsc);
      await send(
        rules
          .connect(gov)
          .setJurisdictionRule(vsc, [...allowed, 554n], [...blocked]),
      );
      expect(await pm.jurisdictionBit(554)).to.equal(0n);
      const normal = (await types.getInvestorTypeConfig(0)).toObject();
      normal.maxTransferAmount += ethers.parseEther("1000");
      await send(types.connect(gov).updateInvestorTypeConfig(0, normal));
      await send(pm.connect(gov).setPolicyToken(vgt));
      expect(await missingWiring(state)).to.deep.equal([]);
    });
  });
});
