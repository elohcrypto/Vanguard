import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

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
    expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
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
    const issuerAdmin = f.issuerAdmin;
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
