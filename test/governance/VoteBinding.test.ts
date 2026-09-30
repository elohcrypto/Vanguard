import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ageVoters, handoverFixture } from "../helpers/governanceFixture";
import { attest, deployIdentity } from "../helpers/kyc";

// Plan 2F.1 (H1, D25 = (b)): one vote per OnchainID, cast by a wallet that
// controls it. Review probes probe-a1 (five wallets on Alice's identity passed
// a vote 4-2) and probe-b P1 (ops outvoted every honest holder) as tests.
const SYS = 4; // ProposalType.SystemParameters
const ACTION_KEY = 2;
const ECDSA = 1;
const keyOf = (a: string) =>
  ethers.keccak256(ethers.solidityPacked(["address"], [a]));

describe("Vote binding: one identity, one wallet, one vote", function () {
  async function setup() {
    const f = await handoverFixture();
    const { c, deployer, ops, proposer, voters } = f;
    const gov = c.governance;
    const ir = c.identityRegistry;
    for (const s of [proposer, ...voters])
      await c.governanceToken.connect(s).approve(f.govAddr, ethers.MaxUint256);
    // Post-handover shape: ops is registry agent and VGT agent.
    await ir.addAgent(ops.address);
    await c.governanceToken.addAgent(ops.address);
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    const propose = async (from = proposer) => {
      await gov.connect(from).createProposal(SYS, "t", "", f.govAddr, noop);
      return gov.proposalCount();
    };
    /** A wallet with gas and a VGT allowance, not yet registered. */
    const fresh = async () => {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({
        to: w.address,
        value: ethers.parseEther("1"),
      });
      await c.governanceToken.connect(w).approve(f.govAddr, ethers.MaxUint256);
      return w;
    };
    /** VGT for a wallet once it is registered (VGT only pays verified holders). */
    const fund = (w: { address: string }) =>
      c.governanceToken.connect(ops).mint(w.address, ethers.parseEther("100"));
    return { ...f, gov, ir, propose, fresh, fund };
  }

  describe("registry: one identity, one wallet", function () {
    it("refuses a second wallet on an identity already bound (probe A1)", async function () {
      const { ir, ops, proposer, stranger } = await setup();
      const aliceId = await ir.identity(proposer.address);
      await expect(
        ir.connect(ops).registerIdentity(stranger.address, aliceId, 840),
      ).to.be.revertedWith("Identity already bound");
      await expect(
        ir
          .connect(ops)
          .batchRegisterIdentity([stranger.address], [aliceId], [840]),
      ).to.be.revertedWith("Identity already bound");
      expect(await ir.walletOf(aliceId)).to.equal(proposer.address);
    });

    it("updateIdentity refuses an identity bound elsewhere and frees the old one", async function () {
      const { ir, proposer, voters } = await setup();
      const [bob] = voters;
      const aliceId = await ir.identity(proposer.address);
      const bobId = await ir.identity(bob.address);
      await expect(ir.updateIdentity(bob.address, aliceId)).to.be.revertedWith(
        "Identity already bound",
      );
      const other = ethers.Wallet.createRandom().address;
      await ir.updateIdentity(bob.address, other);
      expect(await ir.walletOf(other)).to.equal(bob.address);
      expect(await ir.walletOf(bobId)).to.equal(ethers.ZeroAddress);
      expect(await ir.identityRegisteredAt(other)).to.be.greaterThan(0n);
    });

    it("moveIdentity re-points and deleteIdentity clears; the age survives both", async function () {
      const { ir, proposer, stranger } = await setup();
      const aliceId = await ir.identity(proposer.address);
      const born = await ir.identityRegisteredAt(aliceId);
      expect(born).to.be.greaterThan(0n);
      await ir.moveIdentity(proposer.address, stranger.address);
      expect(await ir.walletOf(aliceId)).to.equal(stranger.address);
      await ir.deleteIdentity(stranger.address);
      expect(await ir.walletOf(aliceId)).to.equal(ethers.ZeroAddress);
      await time.increase(3600);
      await ir.registerIdentity(proposer.address, aliceId, 840);
      expect(await ir.walletOf(aliceId)).to.equal(proposer.address);
      expect(await ir.identityRegisteredAt(aliceId)).to.equal(born);
    });

    it("keeps the identity-count history across register, delete and move", async function () {
      const { ir, stranger, voters } = await setup();
      const t0 = await time.latest();
      expect(await ir.registeredIdentityCountAt(t0)).to.equal(3n);
      await ir.registerIdentity(
        stranger.address,
        ethers.Wallet.createRandom().address,
        840,
      );
      const t1 = await time.latest();
      await time.increase(10);
      await ir.moveIdentity(
        voters[0].address,
        ethers.Wallet.createRandom().address,
      );
      const t2 = await time.latest();
      await time.increase(10);
      await ir.deleteIdentity(stranger.address);
      const t3 = await time.latest();
      expect(await ir.registeredIdentityCountAt(t0)).to.equal(3n);
      expect(await ir.registeredIdentityCountAt(t1)).to.equal(4n);
      expect(await ir.registeredIdentityCountAt(t2)).to.equal(4n);
      expect(await ir.registeredIdentityCountAt(t3)).to.equal(3n);
      expect(await ir.registeredIdentityCountAt(t1 - 1)).to.equal(3n);
      expect(await ir.registeredIdentityCount()).to.equal(3n);
    });
  });

  describe("governance: votes keyed by identity", function () {
    it("hasVoted resolves the wallet to its identity; a moved identity cannot vote twice", async function () {
      const { gov, ir, propose, voters, fresh, fund } = await setup();
      const [bob] = voters;
      const id = await propose();
      await gov.connect(bob).castVote(id, true, "");
      // Bob recovers to a new wallet he controls (ACTION key on his identity).
      const bob2 = await fresh();
      const bobId = await ir.identity(bob.address);
      const oid = await ethers.getContractAt("OnchainID", bobId);
      await oid.connect(bob).addKey(keyOf(bob2.address), ACTION_KEY, ECDSA);
      await ir.moveIdentity(bob.address, bob2.address);
      await fund(bob2);
      expect(await gov.hasVoted(id, bob2.address)).to.equal(true);
      await expect(gov.connect(bob2).castVote(id, true, "")).to.be.revertedWith(
        "Already voted",
      );
    });

    it("excludes the proposer by identity, not by wallet", async function () {
      const { gov, ir, propose, proposer, fresh, fund } = await setup();
      const id = await propose();
      const alice2 = await fresh();
      const aliceId = await ir.identity(proposer.address);
      const oid = await ethers.getContractAt("OnchainID", aliceId);
      await oid
        .connect(proposer)
        .addKey(keyOf(alice2.address), ACTION_KEY, ECDSA);
      await ir.moveIdentity(proposer.address, alice2.address);
      await fund(alice2);
      await expect(
        gov.connect(alice2).castVote(id, true, ""),
      ).to.be.revertedWith("Proposer cannot vote on own proposal");
    });

    it("refuses a wallet holding no key on its identity (ops re-binds Alice's identity)", async function () {
      const { gov, ir, ops, propose, proposer, voters, fresh, fund } =
        await setup();
      const id = await propose(voters[0]);
      const opsWallet = await fresh();
      // The registry agent moves Alice's verified, aged identity to its own
      // wallet. The wallet is verified, but Alice never gave it a key.
      await ir.connect(ops).moveIdentity(proposer.address, opsWallet.address);
      expect(await ir.isVerified(opsWallet.address)).to.equal(true);
      await fund(opsWallet);
      await expect(
        gov.connect(opsWallet).castVote(id, true, ""),
      ).to.be.revertedWith("Wallet does not control its identity");
      await expect(
        gov
          .connect(opsWallet)
          .createProposal(SYS, "t", "", await gov.getAddress(), "0x12345678"),
      ).to.be.revertedWith("Wallet does not control its identity");
    });

    it("P1: ops cannot outvote the honest holders with extra wallets", async function () {
      const { gov, ir, ops, propose, proposer, voters, fresh } = await setup();
      const id = await propose();
      for (const v of voters) await gov.connect(v).castVote(id, false, "no");
      const aliceId = await ir.identity(proposer.address);
      const sybil = await fresh();
      await expect(
        ir.connect(ops).registerIdentity(sybil.address, aliceId, 840),
      ).to.be.revertedWith("Identity already bound");
      const p = (await gov.getProposal(id))[0];
      expect(p.votesFor).to.equal(0n);
      expect(p.votesAgainst).to.equal(2n);
      expect(p.proposerIdentity).to.equal(aliceId);
    });

    it("an OnchainID owner and a MANAGEMENT or ACTION key holder may vote", async function () {
      const f = await setup();
      const { gov, ir, deployer, fresh, fund, kycIssuer, factory, voters } = f;
      const owner = await fresh();
      const actionHolder = await fresh();
      const idA = await deployIdentity(factory, owner.address);
      await ir.registerIdentity(owner.address, idA, 840);
      await attest(kycIssuer, deployer, idA);
      // A second identity owned by a third party, delegating to actionHolder.
      const idB = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(voters[1].address);
      await idB
        .connect(voters[1])
        .addKey(keyOf(actionHolder.address), ACTION_KEY, ECDSA);
      await ir.registerIdentity(
        actionHolder.address,
        await idB.getAddress(),
        840,
      );
      await attest(kycIssuer, deployer, await idB.getAddress());
      await fund(owner);
      await fund(actionHolder);
      await ageVoters(gov);
      const id = await f.propose();
      await gov.connect(owner).castVote(id, true, "");
      await gov.connect(actionHolder).castVote(id, true, "");
      expect(await ir.identity(actionHolder.address)).to.equal(
        await idB.getAddress(),
      );
    });
  });
});
