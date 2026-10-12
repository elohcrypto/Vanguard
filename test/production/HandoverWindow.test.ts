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

  const NONCE =
    /^deployer sent [1-9]\d* transaction\(s\) in the voting window that the ceremony did not send/;

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
        /^every grant, mint, identity registration, freeze and rule-administrator event since the preflight \(blocks \d+-\d+, \d+ events, [1-9]\d* of them the ceremony's\) came from the ceremony, ops or a vote$/.test(
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
        `^EscrowWalletFactory fee wallet ${f.deployer.address} is ops or listed in feeWallets, never the deployer`,
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
    // The deployer paying for a vote (option 83d proposes as wallet 0).
    await c.governanceToken.connect(f.deployer).approve(f.govAddr, 1n);
    await accept(report);
    expect((await H.assertHandoverComplete(args)).failures).to.deep.equal([]);
    const { ceremonyTxs, ...bare } = args.snapshot;
    expect(ceremonyTxs.length).to.be.greaterThan(10);
    args.snapshot = bare;
    await failsWith(
      /^the preflight snapshot records no preflight block, deployer nonce and ceremony transactions/,
    );
  });

  // Review of slice B (lead, 2026-10-12): the scan must not pass on an
  // RPC that returns nothing, must reach the last chunk, and compares
  // addresses case-insensitively like the rest of the ceremony.
  it("an RPC that drops one filter's logs fails the window line (R-413-6)", async function () {
    const report = await steps();
    await accept(report);
    const p: any = ethers.provider;
    const real = p.getLogs.bind(p);
    const agentAdded = c.token.interface.getEvent("AgentAdded").topicHash;
    const vsc = (await c.token.getAddress()).toLowerCase();
    p.getLogs = async (flt: any) => {
      const t0 = (await flt).topics?.[0];
      const addr = String((await flt).address || "").toLowerCase();
      return addr === vsc && t0 === agentAdded ? [] : real(flt);
    };
    try {
      await failsWith(
        /^voting-window event scan found none of the ceremony events it must see/,
      );
    } finally {
      p.getLogs = real;
    }
  });

  it("an event in the last one-block chunk is refused; mixed-case acknowledgements pass", async function () {
    args.feeWallets = [f.feeWallet.address.toLowerCase()];
    args.logChunk = 1;
    const report = await steps();
    await accept(report);
    expect((await H.assertHandoverComplete(args)).failures).to.deep.equal([]);
    // Governance (impersonated: a vote) seats the deployer as an agent
    // after the votes; its burn is the newest block the completion reads.
    await ethers.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await ethers.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(f.govAddr);
    await c.token.connect(gov).addAgent(f.deployer.address);
    await c.token.connect(f.ops).mint(f.voters[0].address, E("5"));
    await c.token.connect(f.deployer).burn(f.voters[0].address, E("5"));
    const r = await failsWith(WINDOW("VSC burn"));
    // The burn, the live agent, the deployer's untracked transaction.
    expect(r.failures).to.have.lengthOf(3);
    expect(r.failures.some((l: string) => NONCE.test(l))).to.equal(true);
  });

  // Review of 4.17 slice B (X1-X6): what the event scan alone missed.
  /** Run `act` once, inside the first getBlockNumber called under `where`. */
  function hookOnce(where: string, act: () => Promise<void>) {
    const p: any = ethers.provider;
    const orig = p.getBlockNumber.bind(p);
    let done = false;
    p.getBlockNumber = async () => {
      if (!done && (new Error().stack || "").includes(where)) {
        done = true;
        await act();
      }
      return orig();
    };
    return () => {
      p.getBlockNumber = orig;
      return done;
    };
  }
  async function mintByDeployer(to: string, amt: bigint) {
    const t = c.token.connect(f.deployer);
    await t.addAgent(f.deployer.address);
    await t.mint(to, amt);
    await t.removeAgent(f.deployer.address);
  }

  it("X1: a compliance swap and back in the window is refused by the deployer's nonce", async function () {
    await mintByDeployer(f.voters[0].address, E("100"));
    const report = await steps();
    const yes = await (
      await ethers.getContractFactory("YesCompliance")
    ).deploy();
    const rules = await c.complianceRules.getAddress();
    await c.token.connect(f.deployer).setCompliance(yes.target);
    await c.token.connect(f.voters[0]).transfer(f.stranger.address, E("10"));
    await c.token.connect(f.deployer).setCompliance(rules);
    await accept(report);
    expect(await c.token.balanceOf(f.stranger.address)).to.equal(E("10"));
    await failsWith(NONCE);
  });

  it("X2/X3: a deployer mint while the preflight or the snapshot reads is refused", async function () {
    for (const where of ["snapshotFacts", "preflightEscrow"]) {
      const g = await handoverFixture();
      ({ c, args } = g);
      f = g;
      const un = hookOnce(where, () =>
        mintByDeployer(f.voters[0].address, E("7")),
      );
      let report;
      try {
        report = await steps();
      } finally {
        expect(un(), where).to.equal(true);
      }
      await accept(report);
      await failsWith(WINDOW("VSC mint"), NONCE);
    }
  });

  it("X4: an escrow the deployer arbitrates is refused before step 1", async function () {
    const e = c.escrowWalletFactory;
    await e.registerInvestor(f.deployer.address, f.feeWallet.address);
    await e
      .connect(f.deployer)
      .createEscrowWallet(f.voters[0].address, f.voters[1].address, E("1"));
    const w = await e.getWalletAddress(1);
    await refusedAt(
      new RegExp(
        `the deployer arbitrates escrow ${w}: settle it before the ceremony`,
      ),
    );
  });

  it("X5: an escrow the deployer creates during step 5 is refused", async function () {
    const e = c.escrowWalletFactory;
    await e.registerInvestor(f.deployer.address, f.feeWallet.address);
    const un = hookOnce("escrowSteps", async () => {
      await e
        .connect(f.deployer)
        .createEscrowWallet(f.voters[0].address, f.voters[1].address, E("1"));
    });
    let report;
    try {
      report = await steps();
    } finally {
      expect(un()).to.equal(true);
    }
    await accept(report);
    await failsWith(
      NONCE,
      /^no escrow ComplianceRules trusts is arbitrated by the deployer$/,
    );
  });

  it("X6: an exempt wallet is no acknowledged fee wallet (R-417-2 replaced)", async function () {
    await c.investorTypeRegistry.setInvestorLimitExempt(
      f.stranger.address,
      true,
    );
    await c.escrowWalletFactory.setOwnerWallet(f.stranger.address);
    await refusedAt(
      new RegExp(`EscrowWalletFactory ownerWallet is ${f.stranger.address}`),
    );
  });
});
