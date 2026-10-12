import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Task 4.15 (C §2 MultiSigWallet rows; C §3 N65; C §5 MultiSigWallet
// unlock paths). Only the user or the bank proposes and signs; each signs
// once; the second signature executes, and an executed proposal is never
// signed, executed or cancelled again; an unlock that outgrew the balance
// is refused; the free (fee) balance pays before the lock.
//
// Unreachable (mutation-confirmed, kept as defence in depth): the private
// _executeUnlock's own `require(!proposal.executed, "Already executed")`,
// since its only caller, signUnlock, refuses an executed proposal first.
describe("Custody unlock guards (Task 4.15)", function () {
  let owner: SignerWithAddress, bank: SignerWithAddress;
  let user: SignerWithAddress, stranger: SignerWithAddress;
  let tok: any, w: any, wAddr: string;
  const LOCK = 1000n;

  beforeEach(async function () {
    [owner, bank, user, stranger] = await ethers.getSigners();
    tok = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("M", "M", 0);
    w = await (
      await ethers.getContractFactory("MultiSigWallet")
    ).deploy(bank.address, user.address, await tok.getAddress());
    wAddr = await w.getAddress();
    await tok.mint(user.address, LOCK);
    await tok.connect(user).approve(wAddr, LOCK);
    await w.connect(user).lockTokens(LOCK);
  });

  const idOf = async (tx: any) => {
    const rec = await (await tx).wait();
    const ev = rec.logs.find(
      (l: any) => l.fragment?.name === "UnlockProposalCreated",
    );
    return ev.args[0] as string;
  };

  it("proposeUnlock: user or bank only (N65); amount, recipient and reason checked", async function () {
    await expect(
      w.connect(stranger).proposeUnlock(1n, user.address, "r"),
    ).to.be.revertedWith("Not authorized");
    await expect(
      w.connect(owner).proposeUnlock(1n, user.address, "r"),
    ).to.be.revertedWith("Not authorized");
    for (const amount of [0n, LOCK + 1n])
      await expect(
        w.connect(user).proposeUnlock(amount, user.address, "r"),
      ).to.be.revertedWith("Invalid amount");
    await expect(
      w.connect(user).proposeUnlock(1n, ethers.ZeroAddress, "r"),
    ).to.be.revertedWith("Invalid recipient");
    await expect(
      w.connect(user).proposeUnlock(1n, user.address, ""),
    ).to.be.revertedWith("Reason required");
    const id = await idOf(w.connect(bank).proposeUnlock(1n, user.address, "r"));
    expect((await w.proposals(id)).amount).to.equal(1n);
  });

  it("signUnlock: user or bank only, a known proposal, one signature each; the second executes", async function () {
    const id = await idOf(
      w.connect(user).proposeUnlock(LOCK, user.address, "r"),
    );
    await expect(w.connect(stranger).signUnlock(id)).to.be.revertedWith(
      "Not authorized",
    );
    await expect(w.connect(bank).signUnlock(ethers.id("x"))).to.be.revertedWith(
      "Proposal does not exist",
    );
    await w.connect(bank).signUnlock(id);
    await expect(w.connect(bank).signUnlock(id)).to.be.revertedWith(
      "Bank already signed",
    );
    await expect(w.connect(user).signUnlock(id))
      .to.emit(w, "TokensUnlocked")
      .withArgs(id, user.address, LOCK);
    expect(await tok.balanceOf(user.address)).to.equal(LOCK);
    expect(await w.lockedAmount()).to.equal(0);
    // Executed: neither signs, executes nor cancels it again.
    for (const who of [user, bank])
      await expect(w.connect(who).signUnlock(id)).to.be.revertedWith(
        "Proposal already executed",
      );
    await expect(w.connect(owner).cancelProposal(id)).to.be.revertedWith(
      "Proposal already executed",
    );
  });

  it("the user signs once too", async function () {
    const id = await idOf(w.connect(user).proposeUnlock(1n, user.address, "r"));
    await w.connect(user).signUnlock(id);
    await expect(w.connect(user).signUnlock(id)).to.be.revertedWith(
      "User already signed",
    );
    expect((await w.proposals(id)).executed).to.equal(false);
  });

  it("cancelProposal: user, bank or owner; a known proposal; it is gone afterwards", async function () {
    const id = await idOf(w.connect(user).proposeUnlock(1n, user.address, "r"));
    await expect(w.connect(stranger).cancelProposal(id)).to.be.revertedWith(
      "Not authorized",
    );
    await expect(
      w.connect(owner).cancelProposal(ethers.id("x")),
    ).to.be.revertedWith("Proposal does not exist");
    await expect(w.connect(owner).cancelProposal(id))
      .to.emit(w, "ProposalCancelled")
      .withArgs(id, owner.address);
    expect((await w.proposals(id)).createdAt).to.equal(0);
    await expect(w.connect(bank).signUnlock(id)).to.be.revertedWith(
      "Proposal does not exist",
    );
    const id2 = await idOf(
      w.connect(bank).proposeUnlock(1n, user.address, "r"),
    );
    await w.connect(user).cancelProposal(id2);
    const id3 = await idOf(
      w.connect(bank).proposeUnlock(1n, user.address, "r"),
    );
    await w.connect(bank).cancelProposal(id3);
    expect((await w.proposals(id3)).createdAt).to.equal(0);
  });

  it("an unlock that outgrew the balance: Insufficient wallet balance (176)", async function () {
    const a = await idOf(
      w.connect(user).proposeUnlock(LOCK, user.address, "a"),
    );
    const b = await idOf(
      w.connect(user).proposeUnlock(LOCK, user.address, "b"),
    );
    await w.connect(bank).signUnlock(a);
    await w.connect(user).signUnlock(a);
    expect(await tok.balanceOf(wAddr)).to.equal(0);
    await w.connect(bank).signUnlock(b);
    await expect(w.connect(user).signUnlock(b)).to.be.revertedWith(
      "Insufficient wallet balance",
    );
    expect((await w.proposals(b)).executed).to.equal(false);
  });

  it("the free balance pays first, then the lock", async function () {
    await tok.mint(wAddr, 100n); // escrow fees routed to the wallet
    const a = await idOf(
      w.connect(user).proposeUnlock(60n, user.address, "fees"),
    );
    await w.connect(bank).signUnlock(a);
    await w.connect(user).signUnlock(a);
    expect(await w.lockedAmount()).to.equal(LOCK);
    const b = await idOf(
      w.connect(user).proposeUnlock(140n, user.address, "both"),
    );
    await w.connect(bank).signUnlock(b);
    await w.connect(user).signUnlock(b);
    expect(await w.lockedAmount()).to.equal(LOCK - 100n);
    expect(await tok.balanceOf(wAddr)).to.equal(LOCK - 100n);
  });
});
