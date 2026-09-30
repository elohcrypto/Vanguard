import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";
import { attest } from "../helpers/kyc";

// Plan 2F.1 (D25, decided with a 7-day minimum identity age): an identity
// votes only if it was registered at least minVoterAge before the proposal
// was created, and only such identities count toward quorum. Review probe
// probe-d-sybil (P6): ops plus the issuer keys minted fake identities and
// passed transferOwnership(ops) on ComplianceRules with no honest voter.
const RULES = 1; // ProposalType.ComplianceRules
const SYS = 4; // ProposalType.SystemParameters
const IRP = 7; // ProposalType.IdentityRegistryParameters
const DAY = 24 * 3600;

describe("Vote binding: minimum identity age", function () {
  async function setup() {
    const f = await handoverFixture();
    const { c, proposer, voters } = f;
    for (const s of [proposer, ...voters])
      await c.governanceToken.connect(s).approve(f.govAddr, ethers.MaxUint256);
    await c.identityRegistry.addAgent(f.ops.address);
    await c.governanceToken.addAgent(f.ops.address);
    const gov = c.governance;
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    const propose = async (from = proposer) => {
      await gov.connect(from).createProposal(SYS, "t", "", f.govAddr, noop);
      return gov.proposalCount();
    };
    /** Settle `id` after its voting period and execution delay. */
    const settle = async (id: bigint) => {
      await time.increase(4 * DAY);
      await gov.executeProposal(id);
      return Number((await gov.getProposal(id))[0].status);
    };
    /**
     * A fake electorate built by ops (registry + VGT agent) and the issuer
     * key: each wallet owns a fresh OnchainID, so it passes the key check.
     */
    const fakes = async (n: number) => {
      const OID = await ethers.getContractFactory("OnchainID");
      const out = [];
      for (let i = 0; i < n; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await f.deployer.sendTransaction({
          to: w.address,
          value: ethers.parseEther("1"),
        });
        const id = await (await OID.deploy(w.address)).getAddress();
        await c.identityRegistry
          .connect(f.ops)
          .registerIdentity(w.address, id, 840);
        await attest(f.kycIssuer, f.deployer, id);
        await c.governanceToken
          .connect(f.ops)
          .mint(w.address, ethers.parseEther("100"));
        await c.governanceToken
          .connect(w)
          .approve(f.govAddr, ethers.MaxUint256);
        out.push(w);
      }
      return out;
    };
    return { ...f, gov, propose, settle, fakes };
  }

  it("starts at 7 days scaled by TIME_SCALE", async function () {
    const { gov } = await setup();
    const scale = await gov.TIME_SCALE();
    expect(await gov.minVoterAge()).to.equal(BigInt(7 * DAY) / scale);
  });

  it("refuses a too-young proposer and a too-young voter", async function () {
    const { gov, propose, fakes } = await setup();
    // Shortest allowed age (1 day scaled), so the jump below stays inside
    // the voting period.
    await gov.setMinVoterAge(BigInt(DAY) / (await gov.TIME_SCALE()));
    const [young] = await fakes(1);
    await expect(propose(young)).to.be.revertedWith("Identity too new to vote");
    const id = await propose();
    await expect(gov.connect(young).castVote(id, true, "")).to.be.revertedWith(
      "Identity too new to vote",
    );
    // Aging after creation does not help: the electorate is fixed at creation.
    await time.increase((await gov.minVoterAge()) + 1n);
    await expect(gov.connect(young).castVote(id, true, "")).to.be.revertedWith(
      "Identity too new to vote",
    );
    // A proposal created once the identity is old enough admits it.
    const id2 = await propose();
    await gov.connect(young).castVote(id2, true, "");
  });

  it("does not count fresh identities in the quorum denominator (100 fakes)", async function () {
    const { gov, c, proposer } = await setup();
    const ir = c.identityRegistry;
    const before = await ir.registeredIdentityCount();
    const n = 100;
    const wallets = Array.from(
      { length: n },
      () => ethers.Wallet.createRandom().address,
    );
    const ids = Array.from(
      { length: n },
      () => ethers.Wallet.createRandom().address,
    );
    await ir.batchRegisterIdentity(
      wallets.slice(0, 50),
      ids.slice(0, 50),
      wallets.slice(0, 50).map(() => 840),
    );
    await ir.batchRegisterIdentity(
      wallets.slice(50),
      ids.slice(50),
      wallets.slice(50).map(() => 840),
    );
    expect(await ir.registeredIdentityCount()).to.equal(before + BigInt(n));
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    await gov
      .connect(proposer)
      .createProposal(SYS, "t", "", await gov.getAddress(), noop);
    const p = (await gov.getProposal(await gov.proposalCount()))[0];
    expect(p.eligibleVotersAtCreation).to.equal(before);
  });

  it("P6: a fresh issuer-key electorate cannot vote; the honest remedy passes without it", async function () {
    const { gov, c, ops, proposer, voters, settle, fakes, govAddr } =
      await setup();
    const ir = c.identityRegistry;
    // Governance owns the registry (as after the ceremony).
    await ir.transferOwnership(govAddr);
    await gov
      .connect(proposer)
      .createProposal(
        IRP,
        "accept",
        "",
        await ir.getAddress(),
        ir.interface.encodeFunctionData("acceptOwnership"),
      );
    let id = await gov.proposalCount();
    for (const v of voters) await gov.connect(v).castVote(id, true, "");
    expect(await settle(id)).to.equal(4); // Executed
    // Day 0 of the attack: ops mints an electorate larger than the honest one.
    const syb = await fakes(5);
    const takeover = ir.interface.encodeFunctionData("transferOwnership", [
      ops.address,
    ]);
    await expect(
      gov
        .connect(syb[0])
        .createProposal(
          RULES,
          "hand rules to ops",
          "",
          await c.complianceRules.getAddress(),
          takeover,
        ),
    ).to.be.revertedWith("Identity too new to vote");
    // Day 1: the honest holders remove ops as registry agent.
    await time.increase(DAY / Number(await gov.TIME_SCALE()));
    const remedy = ir.interface.encodeFunctionData("removeAgent", [
      ops.address,
    ]);
    await gov
      .connect(proposer)
      .createProposal(IRP, "remove ops", "", await ir.getAddress(), remedy);
    id = await gov.proposalCount();
    expect((await gov.getProposal(id))[0].eligibleVotersAtCreation).to.equal(
      3n,
    );
    for (const w of syb)
      await expect(gov.connect(w).castVote(id, false, "")).to.be.revertedWith(
        "Identity too new to vote",
      );
    for (const v of voters) await gov.connect(v).castVote(id, true, "");
    expect(await settle(id)).to.equal(4);
    expect(await ir.isAgent(ops.address)).to.equal(false);
  });

  it("M8c: an identity registered exactly at the cutoff is eligible and counted; one second later is not", async function () {
    const { gov, c, proposer, deployer, kycIssuer, ops } = await setup();
    const ir = c.identityRegistry;
    const before = await ir.registeredIdentityCount();
    const OID = await ethers.getContractFactory("OnchainID");
    const ws = [];
    for (let i = 0; i < 2; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({
        to: w.address,
        value: ethers.parseEther("1"),
      });
      const id = await (await OID.deploy(w.address)).getAddress();
      await attest(kycIssuer, deployer, id);
      ws.push({ w, id });
    }
    const t = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(t);
    await ir.registerIdentity(ws[0].w.address, ws[0].id, 840);
    await time.setNextBlockTimestamp(t + 1);
    await ir.registerIdentity(ws[1].w.address, ws[1].id, 840);
    for (const { w } of ws) {
      await c.governanceToken
        .connect(ops)
        .mint(w.address, ethers.parseEther("100"));
      await c.governanceToken
        .connect(w)
        .approve(await gov.getAddress(), ethers.MaxUint256);
    }
    await time.setNextBlockTimestamp(t + Number(await gov.minVoterAge()));
    await gov
      .connect(proposer)
      .createProposal(
        SYS,
        "t",
        "",
        await gov.getAddress(),
        gov.interface.encodeFunctionData("setVotingCost", [
          ethers.parseEther("10"),
        ]),
      );
    const id = await gov.proposalCount();
    const p = (await gov.getProposal(id))[0];
    expect(p.voterAgeCutoff).to.equal(BigInt(t));
    expect(p.eligibleVotersAtCreation).to.equal(before + 1n);
    await gov.connect(ws[0].w).castVote(id, true, "");
    await expect(
      gov.connect(ws[1].w).castVote(id, true, ""),
    ).to.be.revertedWith("Identity too new to vote");
  });

  describe("setMinVoterAge", function () {
    it("is owner-only and bounded to [1 day, 30 days] / TIME_SCALE", async function () {
      const { gov, stranger } = await setup();
      const scale = await gov.TIME_SCALE();
      const lo = BigInt(DAY) / scale;
      const hi = BigInt(30 * DAY) / scale;
      await expect(
        gov.connect(stranger).setMinVoterAge(lo),
      ).to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount");
      await expect(gov.setMinVoterAge(lo - 1n)).to.be.revertedWithCustomError(
        gov,
        "VoterAgeOutOfRange",
      );
      await expect(gov.setMinVoterAge(hi + 1n)).to.be.revertedWithCustomError(
        gov,
        "VoterAgeOutOfRange",
      );
      await expect(gov.setMinVoterAge(0)).to.be.revertedWithCustomError(
        gov,
        "VoterAgeOutOfRange",
      );
      const old = await gov.minVoterAge();
      await expect(gov.setMinVoterAge(lo))
        .to.emit(gov, "MinVoterAgeUpdated")
        .withArgs(old, lo);
      await gov.setMinVoterAge(hi);
      expect(await gov.minVoterAge()).to.equal(hi);
    });

    it("freezes the cutoff per proposal when minVoterAge changes", async function () {
      const { gov, propose, voters } = await setup();
      const id = await propose();
      const cutoff = (await gov.getProposal(id))[0].voterAgeCutoff;
      // Raise the age so far that nobody would qualify on a new proposal.
      await gov.setMinVoterAge(BigInt(30 * DAY) / (await gov.TIME_SCALE()));
      expect((await gov.getProposal(id))[0].voterAgeCutoff).to.equal(cutoff);
      await gov.connect(voters[0]).castVote(id, true, "");
      await expect(propose()).to.be.revertedWith("Identity too new to vote");
    });
  });
});
