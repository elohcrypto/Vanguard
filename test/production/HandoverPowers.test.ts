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
