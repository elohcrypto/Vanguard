import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { deployIdentity } from "../helpers/kyc";

const H = require("../../demo/utils/Handover");

// Task 4.17 slice B (review B BF-1, BF-2, BF-3, PB5; probes PB0-PB8).
// The deployer's escrow investor role and fee wallet are handed over in
// step 5 or refused; every grant, mint, registration, freeze and rule
// administrator event in the voting window must come from the ceremony,
// ops or a vote, even when the power was revoked again; the list
// manager writes the oracles ComplianceRules binds.
describe("Handover: escrow investors, fee wallet and the voting window (4.17)", function () {
  let f: any, c: any, args: any;
  const E = ethers.parseEther;
  const WINDOW = (label: string) =>
    new RegExp(`^${label} at block \\d+ sent by ${f.deployer.address}`);

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
  });

  const steps = () => H.handoverDeployerPowers(args);
  async function accept(report: any) {
    await H.acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }
  async function refusedAt(re: RegExp) {
    await expect(steps()).to.be.rejectedWith(re);
    expect(await c.token.isAgent(f.ops.address)).to.equal(false);
  }
  /** The completion's failures; each `re` must name one of them. */
  async function failsWith(...res: RegExp[]) {
    const r = await H.assertHandoverComplete(args);
    expect(r.ok).to.equal(false);
    for (const re of res)
      expect(
        r.failures.some((l: string) => re.test(l)),
        `${re} not in ${r.failures.join(" | ")}`,
      ).to.equal(true);
    return r;
  }

  it("PB0: an honest ceremony completes; the window holds only its own events", async function () {
    await accept(await steps());
    const r = await H.assertHandoverComplete(args);
    expect(r.failures).to.deep.equal([]);
    const labels = r.checks.map((x: any) => x.label);
    expect(
      labels.some((l: string) =>
        /^every grant, mint, identity registration, freeze and rule-administrator event since the preflight \(block \d+, \d+ events\) came from the ceremony, ops or a vote$/.test(
          l,
        ),
      ),
    ).to.equal(true);
    expect(labels).to.include(
      "deployer holds no EscrowWalletFactory INVESTOR_ROLE and no active registration",
    );
  });

  it("PB1: the deployer's escrow registration is deactivated in step 5", async function () {
    const e = c.escrowWalletFactory;
    await e.registerInvestor(f.deployer.address, f.feeWallet.address);
    const report = await steps();
    expect(report.steps).to.include(
      "deployer's EscrowWalletFactory investor registration deactivated",
    );
    await accept(report);
    expect((await H.assertHandoverComplete(args)).failures).to.deep.equal([]);
    expect(await e.isInvestor(f.deployer.address)).to.equal(false);
    await expect(
      e
        .connect(f.deployer)
        .createEscrowWallet(f.voters[0].address, f.voters[1].address, E("1")),
    ).to.be.revertedWithCustomError(e, "AccessControlUnauthorizedAccount");
  });

  it("PB1: a bare INVESTOR_ROLE grant is refused before step 1", async function () {
    const e = c.escrowWalletFactory;
    await e.grantRole(await e.INVESTOR_ROLE(), f.stranger.address);
    await refusedAt(
      new RegExp(
        `EscrowWalletFactory INVESTOR_ROLE held by ${f.stranger.address} without an active registration`,
      ),
    );
  });

  it("PB2: a deployer fee wallet moves to ops in step 5; an unlisted one is refused", async function () {
    const e = c.escrowWalletFactory;
    await e.setOwnerWallet(f.stranger.address);
    await refusedAt(
      new RegExp(
        `EscrowWalletFactory ownerWallet is ${f.stranger.address}: platform fees would flow to a key the ceremony does not hand over`,
      ),
    );
    await e.setOwnerWallet(f.deployer.address);
    await accept(await steps());
    expect(await e.ownerWallet()).to.equal(f.ops.address);
    expect((await H.assertHandoverComplete(args)).failures).to.deep.equal([]);
  });

  it("PB3: a transient agent's mint in the window is refused", async function () {
    const report = await steps();
    const d = f.deployer;
    await c.token.connect(d).addAgent(d.address);
    await c.token.connect(d).mint(f.voters[0].address, E("1000"));
    await c.token.connect(d).removeAgent(d.address);
    await accept(report);
    await failsWith(WINDOW("VSC AgentAdded"), WINDOW("VSC mint"));
  });

  it("PB4: an investor role and a fee wallet taken in the window are refused", async function () {
    const report = await steps();
    const e = c.escrowWalletFactory;
    await e.grantRole(await e.INVESTOR_ROLE(), f.deployer.address);
    await e.setOwnerWallet(f.deployer.address);
    await accept(report);
    await failsWith(
      WINDOW("EscrowWalletFactory RoleGranted"),
      /^deployer holds no EscrowWalletFactory INVESTOR_ROLE and no active registration$/,
      new RegExp(
        `^EscrowWalletFactory fee wallet ${f.deployer.address} is ops, listed in feeWallets or an exempt treasury, never the deployer`,
      ),
    );
  });

  it("PB5: the list manager writes the bound oracles, before and after the ceremony", async function () {
    const om = await c.oracleManager.getAddress();
    const deploy = async (n: string) =>
      (await ethers.getContractFactory(n)).deploy(om, "x", "y") as any;
    const [W, B] = [
      await deploy("WhitelistOracle"),
      await deploy("BlacklistOracle"),
    ];
    const dlm = c.dynamicListManager;
    await dlm.setOracles(W.target, B.target);
    await refusedAt(
      new RegExp(`DynamicListManager writes whitelist oracle ${W.target}`),
    );
    await dlm.setOracles(args.oracles[0].target, B.target);
    await refusedAt(
      new RegExp(`DynamicListManager writes blacklist oracle ${B.target}`),
    );
    // Planted in the window instead.
    const fresh = await handoverFixture();
    ({ c, args } = fresh);
    f = fresh;
    const report = await steps();
    const W2 = await deploy("WhitelistOracle");
    await c.dynamicListManager.setOracles(W2.target, W2.target);
    await accept(report);
    await failsWith(
      new RegExp(
        `^DynamicListManager whitelist oracle ${W2.target} is the one ComplianceRules binds to VSC`,
      ),
    );
  });

  it("PB6: a transient registry agent's registration in the window is refused", async function () {
    const report = await steps();
    const d = f.deployer;
    await c.identityRegistry.connect(d).addAgent(d.address);
    const id = await deployIdentity(c.onchainIDFactory, f.stranger.address);
    await c.identityRegistry
      .connect(d)
      .registerIdentity(f.stranger.address, id, 840);
    await c.identityRegistry.connect(d).removeAgent(d.address);
    await accept(report);
    await failsWith(
      WINDOW("IdentityRegistry AgentAdded"),
      WINDOW("IdentityRegistry IdentityStored"),
    );
  });

  it("PB7: an exemption granted in the window is refused", async function () {
    const report = await steps();
    await c.investorTypeRegistry.setInvestorLimitExempt(
      f.stranger.address,
      true,
    );
    await accept(report);
    await failsWith(
      WINDOW("InvestorTypeRegistry InvestorLimitExemptionUpdated"),
    );
  });

  it("PB8: a freeze by a transient agent in the window is refused", async function () {
    const report = await steps();
    const d = f.deployer;
    await c.token.connect(d).addAgent(d.address);
    await c.token.connect(d).setAddressFrozen(f.voters[0].address, true);
    await c.token.connect(d).removeAgent(d.address);
    await accept(report);
    await failsWith(WINDOW("VSC AgentAdded"), WINDOW("VSC AddressFrozen"));
  });

  it("ops acts in the window freely; a snapshot without the ceremony record fails", async function () {
    const report = await steps();
    await c.token.connect(f.ops).freezePartialTokens(f.voters[0].address, 0n);
    await c.token.connect(f.ops).setAddressFrozen(f.stranger.address, true);
    await accept(report);
    expect((await H.assertHandoverComplete(args)).failures).to.deep.equal([]);
    const { ceremonyTxs, ...bare } = args.snapshot;
    expect(ceremonyTxs.length).to.be.greaterThan(10);
    args.snapshot = bare;
    await failsWith(
      /^the preflight snapshot records no preflight block and ceremony transactions/,
    );
  });
});
