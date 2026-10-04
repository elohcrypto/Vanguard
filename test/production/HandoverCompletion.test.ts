import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { privacySteps } = require("../../demo/utils/HandoverPrivacy");

// Review L6/L-C (2E.8): after a complete ceremony, every completion line
// fails when governance (or ops) hands its power back or away. Lines that
// cannot be re-broken are covered elsewhere: "deployer is not a trusted
// contract" (a wallet cannot be trusted), "governance is a trusted
// contract" (the owner guard keeps the owner trusted), "deployer holds no
// live key" (a revoked key keeps its slot) and the residue lines
// (HandoverPreflight.test.ts).
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

  // Review L6: every completion line fails when its power is given back.
  it("each completion line catches its power (table)", async function () {
    const { deployer, ops, guardian, stranger, govAddr } = f;
    const happy = await assertHandoverComplete(args);
    expect(happy.failures).to.deep.equal([]);
    // Task 3.9: the three lines the close-out added (B-L2, B-M2, D33).
    expect(happy.checks.map((x: any) => x.label)).to.include.members([
      "no ComplianceRules rule administrator but governance and ops",
      `VSC and VGT enforce ComplianceRules ${await c.complianceRules.getAddress()}`,
      "GovernanceToken whitelist mode is OracleOnly (D33)",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [govAddr]);
    await network.provider.send("hardhat_setBalance", [
      govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(govAddr);
    const d = deployer.address;
    const [issuer] = args.issuers;
    const issuerName = `KYC Issuer (${await issuer.getAddress()})`;
    const [oracle] = args.oracles;
    const oAddr = await oracle.getAddress();
    const s = stranger.address;
    const vgtAddr = await c.governanceToken.getAddress();
    /** Governance hands `x` to the stranger (two-step where it applies). */
    const handAway = (x: any) => async () => {
      await x.connect(gov).transferOwnership(s);
      if (typeof x.acceptOwnership === "function")
        await x.connect(stranger).acceptOwnership();
    };
    const owned: [string, () => Promise<unknown>][] = [
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
    ].map(([l, f]) => [`${l} owned by governance`, f] as any);
    const escrowF = c.escrowWalletFactory;
    const pm = c.privacyManager;
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
    await fake.setGovernance(govAddr);
    const issuerAdmin = f.issuerAdmin;
    const otherRules = await (
      await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(d, [840], [])
    ).getAddress();
    const kcKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [ops.address]),
    );
    const breaks: [string, () => Promise<unknown>][] = [
      ...owned,
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
      // L2: a new governor, or an open proposal, in the side-governance.
      [
        "InvestorTypeRegistry: no governor but governance, no open proposal",
        () => c.investorTypeRegistry.connect(gov).setGovernor(s, true, 1),
      ],
      [
        "InvestorTypeRegistry: no governor but governance, no open proposal",
        async () => {
          const cfg = await c.investorTypeRegistry.getInvestorTypeConfig(1);
          await c.investorTypeRegistry
            .connect(gov)
            .createProposal(1, [...cfg], "planted");
        },
      ],
      [
        "deployer is not an InvestorTypeRegistry compliance officer",
        () => c.investorTypeRegistry.connect(gov).setComplianceOfficer(d, true),
      ],
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
        `oracle ${oAddr} owned by ops`,
        () => oracle.connect(ops).transferOwnership(s),
      ],
      [
        `oracle ${oAddr} listManager is not the deployer`,
        () => oracle.connect(ops).setListManager(d),
      ],
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
      [
        "no blacklist oracle bound to GovernanceToken (D23)",
        async () => {
          const bl = await (
            await ethers.getContractFactory("BlacklistOracle")
          ).deploy(await c.oracleManager.getAddress(), "BL", "d");
          await c.complianceRules
            .connect(gov)
            .setBlacklistOracle(vgtAddr, await bl.getAddress());
        },
      ],
      // Task 3.9, review B-L2: any other live rule administrator.
      [
        `${s} is still a ComplianceRules rule administrator (neither governance nor ops)`,
        () => c.complianceRules.connect(gov).setRuleAdministrator(s, true),
      ],
      // Review B-M2: a token moved to another ComplianceRules by its owner.
      [
        `VSC and VGT enforce ComplianceRules ${await c.complianceRules.getAddress()}`,
        () => c.token.connect(gov).setCompliance(otherRules),
      ],
      // D33 (a): a ZK whitelist mode on VGT.
      [
        "GovernanceToken whitelist mode is OracleOnly (D33)",
        async () => {
          await c.complianceRules
            .connect(gov)
            .setPrivacyManager(vgtAddr, await pm.getAddress());
          await c.complianceRules.connect(gov).setWhitelistMode(vgtAddr, 1);
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
      [
        "deployer is not a ComplianceRules rule administrator",
        () => c.complianceRules.connect(gov).setRuleAdministrator(d, true),
      ],
      [
        "deployer is not an InvestorTypeRegistry governor",
        () => c.investorTypeRegistry.connect(gov).setGovernor(d, true, 1),
      ],
      [
        "ops is an InvestorTypeRegistry compliance officer",
        () =>
          c.investorTypeRegistry
            .connect(gov)
            .setComplianceOfficer(ops.address, false),
      ],
      [
        "Token guardian is not the deployer",
        () => c.token.connect(gov).setGuardian(d),
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
          await issuer.connect(deployer).acceptOwnership();
        },
      ],
    ];
    for (const [label, give] of breaks) {
      const snap = await network.provider.send("evm_snapshot", []);
      await give();
      const { failures } = await assertHandoverComplete(args);
      expect(failures, label).to.include(label);
      await network.provider.send("evm_revert", [snap]);
    }
    await network.provider.send("hardhat_stopImpersonatingAccount", [govAddr]);
  });

  /** Governance as a signer (impersonated, funded). */
  async function govSigner() {
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0xDE0B6B3A7640000",
    ]);
    return ethers.getSigner(f.govAddr);
  }

  // Review 3.3 MEDIUM-2 (d): a testingMode wrapper fails the flag and the pin.
  it("a testingMode wrapper fails both the flag and the code-hash line", async function () {
    const tm = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(true);
    const { failures } = await assertHandoverComplete({
      ...args,
      zkVerifier: tm,
    });
    expect(failures).to.include.members([
      "ZKVerifierIntegrated is not in testingMode",
      `ZKVerifierIntegrated ${await tm.getAddress()} code matches the compiled ZKVerifierIntegrated`,
    ]);
  });

  // Review 3.3 LOW-3: a deployer-published root is a warning, not a failure.
  it("warns while the current whitelist root was published by the deployer", async function () {
    const { deployer, ops } = f;
    const gov = await govSigner();
    const pm = c.privacyManager;
    const line =
      "was published by the deployer: republish as ops so deployer-era bindings lapse";
    expect(
      (await assertHandoverComplete(args)).warnings.join("\n"),
    ).to.not.include(line);
    await pm.connect(gov).setListOperator(deployer.address);
    await pm.connect(deployer).publishWhitelistRoot(ethers.toBeHex(7n, 32));
    await pm.connect(gov).setListOperator(ops.address);
    const before = await assertHandoverComplete(args);
    expect(before.ok).to.equal(true);
    expect(before.warnings).to.include(
      `PrivacyManager whitelist root ${ethers.toBeHex(7n, 32)} (version 1) ${line}`,
    );
    await pm.connect(ops).publishWhitelistRoot(ethers.toBeHex(8n, 32));
    const after = await assertHandoverComplete(args);
    expect(after.warnings.join("\n")).to.not.include(line);
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
  });

  // Review 3.3 LOW-4: governance owns PrivacyManager; step 5 says so.
  it("step 5 leaves a governance-owned listOperator to a vote, with a line", async function () {
    const gov = await govSigner();
    const pm = c.privacyManager;
    await pm.connect(gov).setListOperator(f.stranger.address);
    const lines: string[] = [];
    await privacySteps({
      o: args,
      d: f.deployer,
      dAddr: f.deployer.address,
      ok: (m: string) => lines.push(m),
      log: (m: string) => lines.push(m),
    });
    expect(lines).to.deep.equal([
      "   ⚠️  PrivacyManager: governance must set listOperator to ops by a PrivacyParameters vote",
    ]);
    expect(await pm.listOperator()).to.equal(f.stranger.address);
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
  });

  // Review L-5 (mutant M9): the fee-wallet warning, present and absent.
  it("warns on a non-exempt escrow fee wallet, not on an exempt one", async function () {
    const { govAddr, feeWallet } = f;
    await network.provider.send("hardhat_impersonateAccount", [govAddr]);
    await network.provider.send("hardhat_setBalance", [
      govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(govAddr);
    const reg = c.investorTypeRegistry;
    await c.token.connect(gov).setInvestorTypeRegistry(await reg.getAddress());
    const line = `escrow fee wallet ${feeWallet.address} (factory ownerWallet) is not investorLimitExempt`;
    const before = await assertHandoverComplete(args);
    expect(before.ok).to.equal(true);
    expect(before.warnings.join("\n")).to.include(line);
    await reg.connect(gov).setInvestorLimitExempt(feeWallet.address, true);
    const after = await assertHandoverComplete(args);
    expect(after.warnings.join("\n")).to.not.include(line);
    await network.provider.send("hardhat_stopImpersonatingAccount", [govAddr]);
  });
});

// Task 3.9 (review B-L2, B-L4): what the deployer did before the ceremony.
describe("Handover completion check: deployer-era residue (3.9)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
  });

  async function ceremony() {
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  it("refuses a rule administrator the deployer authorized and never revoked", async function () {
    const s = f.stranger.address;
    await c.complianceRules.setRuleAdministrator(s, true);
    await ceremony();
    const { ok, failures } = await assertHandoverComplete(args);
    expect(ok).to.equal(false);
    expect(failures).to.deep.equal([
      `${s} is still a ComplianceRules rule administrator (neither governance nor ops)`,
    ]);
  });

  // Review B-L4: the two deployer-era privacy warnings, as warnings.
  it("warns, without failing, on an issuer key the deployer trusted", async function () {
    const {
      attestorPublicKey,
      newAttestorKey,
    } = require("../../scripts/zk/attest");
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const JUR = ethers.id("JURISDICTION_PROOF");
    await c.privacyManager.setTrustedAttestor(JUR, Ax, Ay, true);
    await ceremony();
    const line = `PrivacyManager issuer key (Ax ${Ax}) for jurisdiction was trusted by the deployer: re-approve it by a PrivacyParameters vote or untrust it`;
    const before = await assertHandoverComplete(args);
    expect(before.ok).to.equal(true);
    expect(before.failures).to.deep.equal([]);
    expect(before.warnings).to.include(line);
    expect(before.residual).to.deep.equal([line]);
    // Untrusted by governance (as a vote would): the warning goes.
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(f.govAddr);
    await c.privacyManager.connect(gov).setTrustedAttestor(JUR, Ax, Ay, false);
    const after = await assertHandoverComplete(args);
    expect(after.warnings).to.not.include(line);
    expect(after.residual).to.deep.equal([]);
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
  });

  it("warns, without failing, on a whitelist root the deployer published", async function () {
    const root = ethers.toBeHex(5n, 32);
    await c.privacyManager.publishWhitelistRoot(root);
    await ceremony();
    const line = `PrivacyManager whitelist root ${root} (version 1) was published by the deployer: republish as ops so deployer-era bindings lapse`;
    const r = await assertHandoverComplete(args);
    expect(r.ok).to.equal(true);
    expect(r.warnings).to.include(line);
    expect(r.residual).to.deep.equal([line]);
  });
});
