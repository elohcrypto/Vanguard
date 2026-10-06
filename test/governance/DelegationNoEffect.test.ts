import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { attest, deployIdentity } from "../helpers/kyc";

// Plan v2 Task 4.6, D12 = (b): VGT delegation is recorded on the token and
// not counted by governance (one verified identity, one vote). Every
// expectation tagged TODAY is what D12 (a), "wire into castVote after the
// external audit", would change; the others should survive it.
const SYS = 4; // ProposalType.SystemParameters (25% quorum, 65% approval)
const EXECUTED = 4n;
const REJECTED = 3n;
const ACTION_KEY = 2;
const ECDSA = 1;
const E = ethers.parseEther;
const keyOf = (a: string) =>
  ethers.keccak256(ethers.solidityPacked(["address"], [a]));

async function setup() {
  const f = await handoverFixture();
  const { c, proposer, voters, govAddr } = f;
  for (const s of [proposer, ...voters])
    await c.governanceToken.connect(s).approve(govAddr, ethers.MaxUint256);
  const gov = c.governance;
  const vgt = c.governanceToken;
  const ir = c.identityRegistry;
  const [bob, carol] = voters;
  const propose = async () => {
    // A harmless view on governance itself, so execution always succeeds.
    const call = gov.interface.encodeFunctionData("owner");
    await gov.connect(proposer).createProposal(SYS, "t", "d", govAddr, call);
    return gov.proposalCount();
  };
  const settle = async (id: bigint) => {
    const [p] = await gov.getProposal(id);
    await ethers.provider.send("evm_increaseTime", [
      Number(p.executionTime - p.createdAt) + 5,
    ]);
    await ethers.provider.send("evm_mine", []);
    await gov.executeProposal(id);
    return (await gov.getProposal(id))[0];
  };
  return { ...f, gov, vgt, ir, bob, carol, alice: proposer, propose, settle };
}

/** Power delegated in to `a`: what getVotingPower adds to the balance. */
async function delegatedIn(vgt: any, a: string): Promise<bigint> {
  return (await vgt.getVotingPower(a)) - (await vgt.balanceOf(a));
}

/** Sum of delegated-in power equals the sum of delegators' balances. */
async function expectMirror(vgt: any, accounts: string[]) {
  let inSum = 0n;
  let delegatorBalances = 0n;
  for (const a of accounts) {
    inSum += await delegatedIn(vgt, a);
    if ((await vgt.getDelegate(a)) !== ethers.ZeroAddress)
      delegatorBalances += await vgt.balanceOf(a);
  }
  expect(inSum, "delegated-in sum vs delegators' balances").to.equal(
    delegatorBalances,
  );
}

describe("VGT delegation is recorded, not counted (D12 b)", function () {
  it("records power: the delegate rises, the delegator does not fall", async function () {
    const { vgt, bob, carol } = await setup();
    await expect(vgt.connect(bob).delegate(carol.address))
      .to.emit(vgt, "DelegateChanged")
      .withArgs(bob.address, ethers.ZeroAddress, carol.address);
    expect(await vgt.getDelegate(bob.address)).to.equal(carol.address);
    expect(await vgt.getVotingPower(carol.address)).to.equal(E("2000"));
    // TODAY: the delegator keeps its own power (balanceOf), so the two
    // readings count bob's 1000 VGT twice. Nothing reads them for a vote.
    expect(await vgt.getVotingPower(bob.address)).to.equal(E("1000"));
  });

  it("delegation moves no vote and takes none away", async function () {
    const { gov, vgt, ir, deployer, bob, carol, propose } = await setup();
    await vgt.connect(bob).delegate(carol.address);
    const id = await propose();
    // TODAY: carol carries bob's delegated power, and still adds exactly 1.
    await gov.connect(carol).castVote(id, true, "");
    expect((await gov.getProposal(id))[0].votesFor).to.equal(1n);
    // TODAY: bob delegated and still votes himself; his vote counts 1.
    await gov.connect(bob).castVote(id, true, "");
    expect((await gov.getProposal(id))[0].votesFor).to.equal(2n);

    // One vote per identity, unchanged by delegation: no second wallet can
    // be bound to bob's identity, and moving it to a wallet he controls
    // does not buy another vote.
    const bobId = await ir.identity(bob.address);
    const bob2 = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: bob2.address, value: E("1") });
    await expect(
      ir.registerIdentity(bob2.address, bobId, 840),
    ).to.be.revertedWith("Identity already bound");
    const oid = await ethers.getContractAt("OnchainID", bobId);
    await oid.connect(bob).addKey(keyOf(bob2.address), ACTION_KEY, ECDSA);
    await ir.moveIdentity(bob.address, bob2.address);
    await vgt.mint(bob2.address, E("100"));
    await vgt.connect(bob2).approve(await gov.getAddress(), ethers.MaxUint256);
    await expect(gov.connect(bob2).castVote(id, true, "")).to.be.revertedWith(
      "Already voted",
    );
    expect((await gov.getProposal(id))[0].votesFor).to.equal(2n);
  });

  it("the outcome is the same with and without a prior delegate", async function () {
    // TODAY: carol delegates to bob, bob votes for, carol against. Weighted
    // by voting power this would be 2000 for / 1000 against (66.7%, above
    // the 65% bar); counted per identity it is 1 / 1 (50%) and fails.
    const run = async (withDelegate: boolean) => {
      const { gov, vgt, bob, carol, propose, settle } = await setup();
      if (withDelegate) await vgt.connect(carol).delegate(bob.address);
      const id = await propose();
      await gov.connect(bob).castVote(id, true, "");
      await gov.connect(carol).castVote(id, false, "");
      const p = await settle(id);
      return [p.votesFor, p.votesAgainst, p.eligibleVotersAtCreation, p.status];
    };
    const plain = await run(false);
    expect(plain).to.deep.equal([1n, 1n, 3n, REJECTED]);
    expect(await run(true)).to.deep.equal(plain);
  });

  it("a passing vote passes the same with and without a prior delegate", async function () {
    const run = async (withDelegate: boolean) => {
      const { gov, vgt, bob, carol, propose, settle } = await setup();
      if (withDelegate) await vgt.connect(bob).delegate(carol.address);
      const id = await propose();
      await gov.connect(carol).castVote(id, true, "");
      await gov.connect(bob).castVote(id, true, "");
      const p = await settle(id);
      return [p.votesFor, p.votesAgainst, p.eligibleVotersAtCreation, p.status];
    };
    const plain = await run(false);
    expect(plain).to.deep.equal([2n, 0n, 3n, EXECUTED]);
    expect(await run(true)).to.deep.equal(plain);
  });

  it("total power is the supply and no account exceeds 100%", async function () {
    const { vgt, alice, bob, carol } = await setup();
    await vgt.connect(bob).delegate(carol.address);
    await vgt.connect(alice).delegate(carol.address);
    expect(await vgt.getTotalVotingPower()).to.equal(await vgt.totalSupply());
    for (const s of [alice, bob, carol])
      expect(await vgt.getVotingPowerPercentage(s.address)).to.be.lte(10000n);
    const total = await vgt.totalSupply();
    expect(await vgt.getVotingPowerPercentage(carol.address)).to.equal(
      (E("3000") * 10000n) / total,
    );
  });

  it("the delegated mirror stays consistent through transfers and redelegation", async function () {
    const { gov, vgt, alice, bob, carol, deployer, stranger, propose } =
      await setup();
    const accounts = [
      alice.address,
      bob.address,
      carol.address,
      deployer.address,
      stranger.address,
      await gov.getAddress(),
    ];
    await vgt.connect(bob).delegate(carol.address);
    await expectMirror(vgt, accounts);
    // Transfer out of a delegator: its delegate loses the amount.
    await vgt.connect(bob).transfer(alice.address, E("100"));
    expect(await delegatedIn(vgt, carol.address)).to.equal(E("900"));
    await expectMirror(vgt, accounts);
    // Redelegation moves the whole current balance.
    await vgt.connect(bob).delegate(alice.address);
    expect(await delegatedIn(vgt, carol.address)).to.equal(0n);
    expect(await delegatedIn(vgt, alice.address)).to.equal(E("900"));
    await expectMirror(vgt, accounts);
    // Mint into a delegator: its delegate gains the amount.
    await vgt.mint(bob.address, E("50"));
    expect(await delegatedIn(vgt, alice.address)).to.equal(E("950"));
    await expectMirror(vgt, accounts);
    // Fees paid to governance flow through _update like any transfer.
    const id = await propose();
    await gov.connect(bob).castVote(id, true, "");
    expect(await delegatedIn(vgt, alice.address)).to.equal(E("940"));
    await expectMirror(vgt, accounts);
    // Transfer out everything: nothing stays delegated.
    await vgt
      .connect(bob)
      .transfer(carol.address, await vgt.balanceOf(bob.address));
    expect(await delegatedIn(vgt, alice.address)).to.equal(0n);
    await expectMirror(vgt, accounts);
  });
});

describe("GovernanceToken.canVote checks verification", function () {
  it("true for a verified holder, false once the identity is gone", async function () {
    const { vgt, ir, bob } = await setup();
    expect(await vgt.canVote(bob.address)).to.equal(true);
    await ir.deleteIdentity(bob.address);
    expect(await vgt.balanceOf(bob.address)).to.equal(E("1000"));
    // Before Task 4.6 this returned true: it only checked the balance.
    expect(await vgt.canVote(bob.address)).to.equal(false);
  });

  it("false for a verified wallet without VGT", async function () {
    const { vgt, ir, deployer, factory, kycIssuer } = await setup();
    const w = ethers.Wallet.createRandom();
    const id = await deployIdentity(factory, w.address);
    await ir.registerIdentity(w.address, id, 840);
    await attest(kycIssuer, deployer, id);
    expect(await ir.isVerified(w.address)).to.equal(true);
    expect(await vgt.canVote(w.address)).to.equal(false);
  });

  it("delegated-in power alone does not make an account eligible", async function () {
    const { vgt, bob, stranger } = await setup();
    await vgt.connect(bob).delegate(stranger.address);
    expect(await vgt.getVotingPower(stranger.address)).to.equal(E("1000"));
    expect(await vgt.canVote(stranger.address)).to.equal(false);
  });
});
