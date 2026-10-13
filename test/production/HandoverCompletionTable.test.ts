import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

type Row = [string, () => Promise<unknown>];

// Review L6/L-C (2E.8): after a complete ceremony, every completion line
// fails when governance (or ops) hands its power back or away. Lines that
// cannot be re-broken are covered elsewhere: "deployer is not a trusted
// contract" (a wallet cannot be trusted), "governance is a trusted
// contract" (the owner guard keeps the owner trusted), "deployer holds no
// live key" (a revoked key keeps its slot) and the residue lines
// (HandoverPreflight.test.ts). Task 5.2: one `it` per group of lines, so
// no single test grows with every line a task adds (mocha's 60 s limit
// under coverage on a slow runner); each row still runs on a snapshot.
describe("Handover completion check (table)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  });

  afterEach(async function () {
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
  });

  /** Governance impersonated and funded, plus the names the rows share. */
  async function setup() {
    const { deployer, stranger, govAddr } = f;
    await network.provider.send("hardhat_impersonateAccount", [govAddr]);
    await network.provider.send("hardhat_setBalance", [
      govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(govAddr);
    const s = stranger.address;
    /** Governance hands `x` to the stranger (two-step where it applies). */
    const handAway = (x: any) => async () => {
      await x.connect(gov).transferOwnership(s);
      if (typeof x.acceptOwnership === "function")
        await x.connect(stranger).acceptOwnership();
    };
    return {
      gov,
      d: deployer.address,
      s,
      handAway,
      vgtAddr: await c.governanceToken.getAddress(),
    };
  }

  /** Review L6: every row's power, given back, fails its own line. */
  async function expectEachCaught(rows: Row[]) {
    for (const [label, give] of rows) {
      const snap = await network.provider.send("evm_snapshot", []);
      await give();
      const { failures } = await assertHandoverComplete(args);
      expect(failures, label).to.include(label);
      await network.provider.send("evm_revert", [snap]);
    }
  }

  it("passes after the ceremony, with the 3.9 close-out lines", async function () {
    const happy = await assertHandoverComplete(args);
    expect(happy.failures).to.deep.equal([]);
    // Task 3.9: the three lines the close-out added (B-L2, B-M2, D33).
    expect(happy.checks.map((x: any) => x.label)).to.include.members([
      "no ComplianceRules rule administrator but governance and ops",
      `VSC and VGT enforce ComplianceRules ${await c.complianceRules.getAddress()}`,
      "GovernanceToken whitelist mode is OracleOnly (D33)",
    ]);
  });

  it("catches each owned contract handed away", async function () {
    const { handAway } = await setup();
    await expectEachCaught(
      [
        ["Token", handAway(c.token)],
        ["GovernanceToken", handAway(c.governanceToken)],
        ["IdentityRegistry", handAway(c.identityRegistry)],
        ["ComplianceRules", handAway(c.complianceRules)],
        ["OracleManager", handAway(c.oracleManager)],
        ["DynamicListManager", handAway(c.dynamicListManager)],
        ["InvestorTypeRegistry", handAway(c.investorTypeRegistry)],
        ["OnchainIDFactory", handAway(c.onchainIDFactory)],
        ["PrivacyManager", handAway(c.privacyManager)],
        ["ZKVerifierIntegrated", handAway(c.zkVerifier)],
        ["VanguardGovernance", handAway(c.governance)],
      ].map(([l, give]) => [`${l} owned by governance`, give] as Row),
    );
  });

  it("catches the escrow factory, privacy and issuer lines", async function () {
    const { gov, d, s, handAway } = await setup();
    const escrowF = c.escrowWalletFactory;
    const pm = c.privacyManager;
    const [issuer] = args.issuers;
    const issuerName = `KYC Issuer (${await issuer.getAddress()})`;
    const issuerAdmin = f.issuerAdmin;
    // A verifier the deployer owns, for the "PrivacyManager's verifier" line.
    const otherZk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    const otherZkAddr = await otherZk.getAddress();
    // Review 3.3 MEDIUM-1/2: what only the code-hash pins catch.
    const zkAddr = await c.zkVerifier.getAddress();
    const alwaysTrue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    const atAddr = await alwaysTrue.getAddress();
    const fake = await (
      await ethers.getContractFactory("FakeZKVerifier")
    ).deploy();
    const fakeAddr = await fake.getAddress();
    await fake.setGovernance(f.govAddr);
    const kcKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [f.ops.address]),
    );
    await expectEachCaught([
      // 2F.5 (M4): the escrow factory line covers ownership and roles.
      [
        "EscrowWalletFactory owned by governance, deployer holds no role",
        handAway(escrowF),
      ],
      [
        "EscrowWalletFactory owned by governance, deployer holds no role",
        async () =>
          escrowF.connect(gov).grantRole(await escrowF.ADMIN_ROLE(), d),
      ],
      // Review M-1: no role holder besides governance and ops.
      [
        "EscrowWalletFactory DEFAULT_ADMIN_ROLE held only by governance",
        async () =>
          escrowF.connect(gov).grantRole(await escrowF.DEFAULT_ADMIN_ROLE(), s),
      ],
      [
        "EscrowWalletFactory ADMIN_ROLE held only by ops",
        async () =>
          escrowF.connect(gov).grantRole(await escrowF.ADMIN_ROLE(), s),
      ],
      // 3.3 (R-3R-4): the privacy lines. "ZKVerifierIntegrated is not in
      // testingMode" cannot be re-broken (testingMode is immutable).
      [
        "PrivacyManager listOperator is ops",
        () => pm.connect(gov).setListOperator(s),
      ],
      [
        "PrivacyManager pendingOwner is not the deployer",
        () => pm.connect(gov).transferOwnership(d),
      ],
      [
        "ZKVerifierIntegrated pendingOwner is not the deployer",
        () => c.zkVerifier.connect(gov).transferOwnership(d),
      ],
      [
        `PrivacyManager's verifier ${otherZkAddr} owned by governance`,
        () => pm.connect(gov).setZKVerifier(otherZkAddr),
      ],
      [
        `ZKVerifierIntegrated ${zkAddr} whitelistVerifier ${atAddr} code matches the compiled WhitelistMembershipVerifier`,
        () => c.zkVerifier.connect(gov).updateVerifier("whitelist", atAddr),
      ],
      [
        `ZKVerifierIntegrated ${fakeAddr} code matches the compiled ZKVerifierIntegrated`,
        () => pm.connect(gov).setZKVerifier(fakeAddr),
      ],
      // D25 (b): ops (registry agent) gains a claim-signer key.
      [
        "no IdentityRegistry agent owns or holds a key on a trusted issuer (D25 b)",
        () => issuer.connect(issuerAdmin).addIssuerKey(kcKey, 3, 1),
      ],
      // Review N-5: a planted nomination to the deployer.
      [
        `deployer does not own ${issuerName}`,
        () => issuer.connect(issuerAdmin).transferOwnership(d),
      ],
      // A revoked key keeps its slot ("Key already exists"), so the deployer
      // regains the issuer by ownership instead.
      [
        `deployer does not own ${issuerName}`,
        async () => {
          await issuer.connect(issuerAdmin).transferOwnership(d);
          await issuer.connect(f.deployer).acceptOwnership();
        },
      ],
    ]);
  });

  it("catches the agent, identity and side-governance lines", async function () {
    const { gov, d, s } = await setup();
    const { ops, govAddr } = f;
    const itr = c.investorTypeRegistry;
    await expectEachCaught([
      [
        "ops is a Token agent",
        () => c.token.connect(gov).removeAgent(ops.address),
      ],
      [
        "ops is a GovernanceToken agent",
        () => c.governanceToken.connect(gov).removeAgent(ops.address),
      ],
      [
        "ops is an IdentityRegistry agent",
        () => c.identityRegistry.connect(gov).removeAgent(ops.address),
      ],
      [
        "governance has no registry identity",
        async () => {
          const id = await (
            await ethers.getContractFactory("OnchainID")
          ).deploy(govAddr);
          await c.identityRegistry
            .connect(ops)
            .registerIdentity(govAddr, await id.getAddress(), 840);
        },
      ],
      ["deployer is not a Token agent", () => c.token.connect(gov).addAgent(d)],
      [
        "deployer is not a GovernanceToken agent",
        () => c.governanceToken.connect(gov).addAgent(d),
      ],
      [
        "deployer is not an IdentityRegistry agent",
        () => c.identityRegistry.connect(gov).addAgent(d),
      ],
      // L2: a new governor, or an open proposal, in the side-governance.
      [
        "InvestorTypeRegistry: no governor but governance, no open proposal",
        () => itr.connect(gov).setGovernor(s, true, 1),
      ],
      [
        "InvestorTypeRegistry: no governor but governance, no open proposal",
        async () => {
          const cfg = await itr.getInvestorTypeConfig(1);
          await itr.connect(gov).createProposal(1, [...cfg], "planted");
        },
      ],
      [
        "deployer is not an InvestorTypeRegistry compliance officer",
        () => itr.connect(gov).setComplianceOfficer(d, true),
      ],
      [
        "deployer is not an InvestorTypeRegistry governor",
        () => itr.connect(gov).setGovernor(d, true, 1),
      ],
      [
        "ops is an InvestorTypeRegistry compliance officer",
        () => itr.connect(gov).setComplianceOfficer(ops.address, false),
      ],
    ]);
  });

  it("catches the oracle, list, rule and guardian lines", async function () {
    const { gov, d, s, vgtAddr } = await setup();
    const { ops, stranger, guardian } = f;
    const [oracle] = args.oracles;
    const oAddr = await oracle.getAddress();
    const rules = c.complianceRules;
    const otherRules = await (
      await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(d, [840], [])
    ).getAddress();
    // D33 (b): a ZK mode on VGT is refused by ComplianceRules itself.
    await rules
      .connect(gov)
      .setPrivacyManager(vgtAddr, await c.privacyManager.getAddress());
    await expect(
      rules.connect(gov).setWhitelistMode(vgtAddr, 1),
    ).to.be.revertedWithCustomError(rules, "GovernanceTokenWhitelist");
    await rules.connect(gov).setPrivacyManager(vgtAddr, ethers.ZeroAddress);
    await expectEachCaught([
      [
        "DynamicListManager governanceContract is governance",
        () => c.dynamicListManager.connect(gov).setGovernanceContract(s),
      ],
      [
        "GovernanceToken has no guardian",
        () => c.governanceToken.connect(gov).setGuardian(guardian.address),
      ],
      ["guardian set on Token", () => c.token.connect(gov).setGuardian(s)],
      [
        "Token guardian is not the deployer",
        () => c.token.connect(gov).setGuardian(d),
      ],
      [
        `oracle ${oAddr} owned by ops`,
        async () => {
          await oracle.connect(ops).transferOwnership(s);
          await oracle.connect(stranger).acceptOwnership();
        },
      ],
      // Task 5.1 (Q7): a nomination alone is a power too.
      [
        `oracle ${oAddr} has no pending owner`,
        () => oracle.connect(ops).transferOwnership(s),
      ],
      [
        `oracle ${oAddr} listManager is not the deployer`,
        () => oracle.connect(ops).setListManager(d),
      ],
      [
        "no blacklist oracle bound to GovernanceToken (D23)",
        async () => {
          const bl = await (
            await ethers.getContractFactory("BlacklistOracle")
          ).deploy(await c.oracleManager.getAddress(), "BL", "d");
          await rules
            .connect(gov)
            .setBlacklistOracle(vgtAddr, await bl.getAddress());
        },
      ],
      // Task 3.9, review B-L2: any other live rule administrator.
      [
        `${s} is still a ComplianceRules rule administrator on ${vgtAddr} (neither governance nor ops)`,
        () => rules.connect(gov).setRuleAdministrator(vgtAddr, s, true),
      ],
      [
        "deployer is not a ComplianceRules rule administrator on VSC or VGT",
        () => rules.connect(gov).setRuleAdministrator(vgtAddr, d, true),
      ],
      // Review B-M2: a token moved to another ComplianceRules by its owner.
      [
        `VSC and VGT enforce ComplianceRules ${await rules.getAddress()}`,
        () => c.token.connect(gov).setCompliance(otherRules),
      ],
    ]);
  });
});
