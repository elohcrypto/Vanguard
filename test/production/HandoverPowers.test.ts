import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

// Plan v2 Task 2F.5 (M4, L2, D25 b): the ceremony reads the deployer's
// power set from chain, refuses a config that omits part of it, hands the
// factories to governance and the issuers to issuerAdmin (never to a
// registry agent), refuses live side-governance in the InvestorTypeRegistry,
// and warns about residue it cannot fix. Probe P0/P7 shapes as tests.
describe("Handover power set from chain (plan 2F.5)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;
  let deployer: SignerWithAddress;
  let ops: SignerWithAddress;
  let stranger: SignerWithAddress;
  let govAddr: string;
  const keyOf = (a: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [a]));

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args, deployer, ops, stranger, govAddr } = f);
  });

  async function ceremony(log: (m: string) => void = () => {}) {
    const report = await handoverDeployerPowers({ ...args, log });
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  /** Refused with `msg`; the deployer sent nothing. */
  async function refused(msg: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(msg);
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
  }

  const blacklistOnVsc = async () => {
    const bl = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(await c.oracleManager.getAddress(), "BL", "d");
    await c.complianceRules.setBlacklistOracle(
      await c.token.getAddress(),
      await bl.getAddress(),
    );
    return bl;
  };

  it("refuses a config that omits an oracle bound to VSC (probe P7)", async function () {
    const bl = await blacklistOnVsc();
    await refused(
      new RegExp(`config "oracles" omits ${await bl.getAddress()}`),
    );
  });

  it("without an oracles list, hands over the bound oracle; completion checks it", async function () {
    const bl = await blacklistOnVsc();
    delete args.oracles;
    await ceremony();
    expect(await bl.owner()).to.equal(ops.address);
    const { checks, failures } = await assertHandoverComplete({
      ...args,
      oracles: [],
    });
    expect(failures).to.deep.equal([]);
    expect(checks.map((x: any) => x.label)).to.include(
      `oracle ${await bl.getAddress()} owned by ops`,
    );
  });

  it("warns on an oracle the chain does not bind", async function () {
    const lines: string[] = [];
    await ceremony((m) => lines.push(m));
    const wl = await args.oracles[0].getAddress();
    expect(lines).to.include(
      `   ⚠️  oracle ${wl} is not bound on chain; handed over anyway`,
    );
  });

  it("refuses a config that omits a trusted issuer", async function () {
    args.issuers = [];
    await refused(/config "issuers" omits 0x[0-9a-fA-F]+ \(a trusted issuer/);
  });

  it("refuses an oracle whose listManager is outside governance", async function () {
    const bl = await blacklistOnVsc();
    args.oracles = [...args.oracles, bl];
    await bl.setListManager(stranger.address);
    await refused(/listManager is 0x[0-9a-fA-F]+, not the DynamicListManager/);
  });

  describe("factories (M4, probe P0)", function () {
    it("nominates, binds and accepts both; ops gets the escrow ADMIN_ROLE", async function () {
      await ceremony();
      const e = c.escrowWalletFactory;
      expect(await e.owner()).to.equal(govAddr);
      expect(await c.onchainIDFactory.owner()).to.equal(govAddr);
      expect(await c.governance.boundTarget(9)).to.equal(await e.getAddress());
      expect(await c.governance.boundTarget(10)).to.equal(
        await c.onchainIDFactory.getAddress(),
      );
      const [ADMIN, DEF] = [await e.ADMIN_ROLE(), await e.DEFAULT_ADMIN_ROLE()];
      expect(await e.hasRole(ADMIN, ops.address)).to.equal(true);
      expect(await e.hasRole(ADMIN, deployer.address)).to.equal(false);
      expect(await e.hasRole(DEF, deployer.address)).to.equal(false);
      expect(await e.hasRole(DEF, govAddr)).to.equal(true);
      const labels = (await assertHandoverComplete(args)).checks.map(
        (x: any) => x.label,
      );
      expect(labels).to.include.members([
        "EscrowWalletFactory owned by governance, deployer holds no role",
        "OnchainIDFactory owned by governance",
      ]);
    });

    it("skips a factory not given, with a line", async function () {
      delete args.onchainIDFactory;
      delete c.onchainIDFactory;
      const lines: string[] = [];
      await ceremony((m) => lines.push(m));
      expect(lines).to.include(
        "   ℹ️  OnchainIDFactory not given: left out of this handover (not deployed)",
      );
      expect(await c.escrowWalletFactory.owner()).to.equal(govAddr);
    });

    it("refuses a config that omits a factory governance is bound to", async function () {
      const e = c.escrowWalletFactory;
      await e.transferOwnership(govAddr);
      await c.governance.setEscrowWalletFactory(await e.getAddress());
      delete args.escrowWalletFactory;
      await refused(
        /bound to EscrowWalletFactory 0x[0-9a-fA-F]+, which the config does not name: add "escrowWalletFactory"/,
      );
    });
  });

  describe("privacy contracts (3.3, R-3R-4)", function () {
    it("nominates, binds and accepts both; ops is the list operator", async function () {
      const pm = c.privacyManager;
      const zk = c.zkVerifier;
      const root = ethers.toBeHex(7n, 32);
      // Before the ceremony the deployer (owner) publishes roots.
      await pm.publishWhitelistRoot(root);
      await ceremony();
      expect(await pm.owner()).to.equal(govAddr);
      expect(await zk.owner()).to.equal(govAddr);
      expect(await c.governance.boundTarget(11)).to.equal(
        await pm.getAddress(),
      );
      expect(await c.governance.boundTarget(12)).to.equal(
        await zk.getAddress(),
      );
      expect(await pm.listOperator()).to.equal(ops.address);
      // After it, the deployer cannot publish a root or swap a verifier.
      await expect(pm.publishWhitelistRoot(root)).to.be.revertedWithCustomError(
        pm,
        "NotListOperator",
      );
      await expect(
        zk.updateVerifier("whitelist", await zk.getAddress()),
      ).to.be.revertedWithCustomError(zk, "OwnableUnauthorizedAccount");
      await pm.connect(ops).publishWhitelistRoot(root);
      const { checks, failures } = await assertHandoverComplete(args);
      expect(failures).to.deep.equal([]);
      expect(checks.map((x: any) => x.label)).to.include.members([
        "PrivacyManager owned by governance",
        "ZKVerifierIntegrated owned by governance",
        "PrivacyManager listOperator is ops",
        "PrivacyManager pendingOwner is not the deployer",
        "ZKVerifierIntegrated pendingOwner is not the deployer",
        "ZKVerifierIntegrated is not in testingMode",
        `PrivacyManager's verifier ${await zk.getAddress()} owned by governance`,
        `PrivacyManager ${await pm.getAddress()} code matches the compiled PrivacyManager`,
        `ZKVerifierIntegrated ${await zk.getAddress()} code matches the compiled ZKVerifierIntegrated`,
        `ZKVerifierIntegrated ${await zk.getAddress()} whitelistVerifier ${await zk.whitelistVerifier()} code matches the compiled WhitelistMembershipVerifier`,
      ]);
    });

    // Review 3.3 MEDIUM-1: a circuit verifier swapped before the ceremony.
    it("refuses an always-true whitelist verifier by code hash", async function () {
      const zk = c.zkVerifier;
      const at = await (
        await ethers.getContractFactory("AlwaysTrueVerifier")
      ).deploy();
      const atAddr = await at.getAddress();
      await zk.updateVerifier("whitelist", atAddr);
      expect(await zk.testingMode()).to.equal(false);
      await refused(
        new RegExp(
          `ZKVerifierIntegrated ${await zk.getAddress()} whitelistVerifier ${atAddr} runtime code hash 0x[0-9a-f]{64} is not the compiled WhitelistMembershipVerifier \\(0x[0-9a-f]{64}\\)`,
        ),
      );
    });

    // Review 3.3 MEDIUM-2: a look-alike wrapper that reports governance.
    it("refuses a look-alike wrapper by code hash", async function () {
      const fake = await (
        await ethers.getContractFactory("FakeZKVerifier")
      ).deploy();
      const fakeAddr = await fake.getAddress();
      await fake.setGovernance(govAddr);
      await c.privacyManager.setZKVerifier(fakeAddr);
      args.zkVerifier = await ethers.getContractAt(
        "ZKVerifierIntegrated",
        fakeAddr,
      );
      await refused(
        new RegExp(
          `ZKVerifierIntegrated ${fakeAddr} runtime code hash 0x[0-9a-f]{64} is not the compiled ZKVerifierIntegrated`,
        ),
      );
    });

    it("refuses a privacy contract governance is bound to but the config omits", async function () {
      const pm = c.privacyManager;
      await pm.transferOwnership(govAddr);
      await c.governance.setPrivacyManager(await pm.getAddress());
      delete args.privacyManager;
      await refused(
        /bound to PrivacyManager 0x[0-9a-fA-F]+, which the config does not name: add "privacyManager"/,
      );
      args.privacyManager = pm;
      const zk = c.zkVerifier;
      await zk.transferOwnership(govAddr);
      await c.governance.setZKVerifier(await zk.getAddress());
      args.zkVerifier = null;
      await refused(
        /bound to ZKVerifierIntegrated 0x[0-9a-fA-F]+, which the config does not name: add "zkVerifier"/,
      );
    });

    it("refuses a PrivacyManager whose verifier the config does not name", async function () {
      const pm = c.privacyManager;
      args.zkVerifier = null;
      await refused(
        new RegExp(
          `uses ZKVerifierIntegrated ${await c.zkVerifier.getAddress()}, which the config does not name: set "zkVerifier"`,
        ),
      );
      const other = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(false);
      args.zkVerifier = other;
      await refused(/which the config does not name: set "zkVerifier"/);
      expect(await pm.owner()).to.equal(deployer.address);
    });

    it("refuses a testingMode verifier", async function () {
      const mock = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(true);
      args.privacyManager = null;
      args.zkVerifier = mock;
      await refused(/is in testingMode .*redeploy it with testingMode=false/);
    });
  });

  describe("review M-1 to M-3, L-2 (2F.5 fixes)", function () {
    /** carol registers, creates an escrow (alice pays bob), rules trust it. */
    async function trustedEscrow() {
      const e = c.escrowWalletFactory;
      const [, , , , alice, bob, carol] = await ethers.getSigners();
      await e.registerInvestor(carol.address, carol.address);
      await e
        .connect(carol)
        .createEscrowWallet(alice.address, bob.address, ethers.parseEther("1"));
      // The factory is VSC's registrar: creation trusts it (Task 4.3).
      return e.getWalletAddress(1);
    }

    it("M-1: refuses a second escrow-factory role admin before any transaction", async function () {
      const e = c.escrowWalletFactory;
      await e.grantRole(await e.DEFAULT_ADMIN_ROLE(), stranger.address);
      await refused(
        new RegExp(
          `EscrowWalletFactory DEFAULT_ADMIN_ROLE held by ${stranger.address} besides the deployer`,
        ),
      );
      await e.revokeRole(await e.DEFAULT_ADMIN_ROLE(), stranger.address);
      await e.grantRole(await e.ADMIN_ROLE(), stranger.address);
      await refused(
        new RegExp(
          `EscrowWalletFactory ADMIN_ROLE held by ${stranger.address} besides the deployer and ops`,
        ),
      );
    });

    it("M-1: a role granted mid-ceremony fails completion; a planted admin is cleared", async function () {
      const e = c.escrowWalletFactory;
      const [DA, AD] = [await e.DEFAULT_ADMIN_ROLE(), await e.ADMIN_ROLE()];
      const report = await handoverDeployerPowers(args);
      // The deployer still owns the factory until the vote.
      await e.grantRole(DA, stranger.address);
      await e.grantRole(AD, stranger.address);
      await acceptAllByVote({
        governance: c.governance,
        contracts: c,
        proposer: f.proposer,
        voters: f.voters,
        registryProposals: report.registryProposals,
        log: () => {},
      });
      // Contract side: accepting ownership revoked every other admin.
      expect(await e.hasRole(DA, stranger.address)).to.equal(false);
      const { failures, checks } = await assertHandoverComplete(args);
      expect(failures).to.deep.equal([
        "EscrowWalletFactory ADMIN_ROLE held only by ops",
      ]);
      expect(checks.map((x: any) => x.label)).to.include(
        "EscrowWalletFactory DEFAULT_ADMIN_ROLE held only by governance",
      );
    });

    it("M-2: refuses a null escrow factory key while a trusted escrow names one", async function () {
      const w = await trustedEscrow();
      const fAddr = await c.escrowWalletFactory.getAddress();
      args.escrowWalletFactory = null;
      await refused(
        new RegExp(
          `trusted escrow ${w} was created by EscrowWalletFactory ${fAddr}, which the config does not name: add "escrowWalletFactory"`,
        ),
      );
    });

    it("M-3: refuses a fromBlock after the IdentityRegistry deploy", async function () {
      args.fromBlock = await ethers.provider.getBlockNumber();
      await refused(
        new RegExp(
          `fromBlock ${args.fromBlock} is after the IdentityRegistry deploy`,
        ),
      );
    });

    it("L-2: warns about escrows that keep the deployer as owner", async function () {
      const w = await trustedEscrow();
      await ceremony();
      const { ok, warnings } = await assertHandoverComplete(args);
      expect(ok).to.equal(true);
      expect(warnings.join("\n")).to.include(
        `escrow(s) ${w} were created before the handover and keep the deployer as owner (immutable)`,
      );
    });
  });

  describe("separation of duties (D25 b)", function () {
    for (const [who, pick] of [
      ["deployer", () => deployer],
      ["ops", () => ops],
      ["guardian", () => f.guardian],
    ] as const) {
      it(`refuses issuerAdmin == ${who}`, async function () {
        args.issuerAdmin = pick();
        await refused(new RegExp(`issuerAdmin 0x[0-9a-fA-F]+ is the ${who}`));
      });
    }

    it("refuses issuerAdmin == governance, and a missing issuerAdmin", async function () {
      args.issuerAdmin = govAddr;
      await refused(/issuerAdmin 0x[0-9a-fA-F]+ is the governance/);
      delete args.issuerAdmin;
      await refused(/issuerAdmin is required: 1 trusted issuer/);
    });

    it("refuses a registry agent that owns a trusted issuer", async function () {
      const other = await (
        await ethers.getContractFactory("ClaimIssuer")
      ).deploy(ops.address, "Ops Issuer", "d");
      await c.identityRegistry.addTrustedIssuer(await other.getAddress(), [6]);
      args.issuers = [...args.issuers, other];
      await refused(
        new RegExp(`IdentityRegistry agent ${ops.address} owns Ops Issuer`),
      );
    });

    it("refuses a registry agent holding a claim-signer key on an issuer", async function () {
      await c.identityRegistry.addAgent(stranger.address);
      await f.kycIssuer.addIssuerKey(keyOf(stranger.address), 3, 1);
      await refused(
        new RegExp(
          `IdentityRegistry agent ${stranger.address} holds a live CLAIM_SIGNER key on KYC Issuer`,
        ),
      );
    });

    it("refuses an issuerAdmin that is a registry agent", async function () {
      await c.identityRegistry.addAgent(f.issuerAdmin.address);
      await refused(
        /issuerAdmin 0x[0-9a-fA-F]+ is an IdentityRegistry agent and would own KYC Issuer/,
      );
    });
  });

  describe("InvestorTypeRegistry side-governance (L2)", function () {
    it("refuses an open registry proposal; passes once cancelled", async function () {
      const reg = c.investorTypeRegistry;
      const cfg = await reg.getInvestorTypeConfig(1);
      await reg.createProposal(1, [...cfg], "planted before the ceremony");
      await refused(/InvestorTypeRegistry proposal\(s\) #1 still open/);
      await reg.cancelProposal(1);
      await ceremony();
      expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
    });

    it("refuses a governor other than the deployer", async function () {
      await c.investorTypeRegistry.setGovernor(stranger.address, true, 1);
      await refused(
        new RegExp(`governor\\(s\\) ${stranger.address} besides the deployer`),
      );
    });
  });

  describe("residue warnings (not failures)", function () {
    it("names the deployer's exemption and non-exempt or late fee wallets", async function () {
      const reg = c.investorTypeRegistry;
      await c.token.setInvestorTypeRegistry(await reg.getAddress());
      await reg.authorizeToken(await c.token.getAddress(), true);
      await reg.setInvestorLimitExempt(deployer.address, true);
      await ceremony();
      // ops (ADMIN_ROLE now) registers an escrow investor after the ceremony.
      await c.escrowWalletFactory
        .connect(ops)
        .registerInvestor(stranger.address, stranger.address);
      const { ok, warnings } = await assertHandoverComplete({
        ...args,
        feeWallets: [f.feeWallet.address],
      });
      expect(ok).to.equal(true);
      const text = warnings.join("\n");
      expect(text).to.match(
        /deployer still holds 0\.0 VSC \(investorLimitExempt: true/,
      );
      expect(text).to.include(
        `escrow fee wallet ${f.feeWallet.address} (factory ownerWallet) is not investorLimitExempt`,
      );
      expect(text).to.match(
        new RegExp(
          `fee wallet ${stranger.address} \\(investor ${stranger.address}\\) was registered after the handover`,
        ),
      );
    });
  });
});
