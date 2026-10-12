import { expect } from "chai";
import { ethers } from "hardhat";
import { T, deployCustody, lockedRequest } from "../helpers/custody";

// Task 4.17 slice A (review C CF-1, mutants C01-C04, C07, C08, C11, C13,
// W01): the bank gates of the request workflow, the lock setter's owner
// gate and the workflow refusals each have a negative test. Every case
// names the exact refusal and shows the permitted caller still works.
describe("Custody request guards (Task 4.17)", function () {
  const e = ethers.parseEther;

  async function funded() {
    const f = await deployCustody();
    await f.token.mint(f.user.address, e("8000"));
    return f;
  }

  const idOf = async (wallet: any, tx: any) => {
    const rec = await (await tx).wait();
    const ev = rec.logs
      .map((l: any) => {
        try {
          return wallet.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((x: any) => x?.name === "UnlockProposalCreated");
    return ev.args[0] as string;
  };

  it("createMultiSigWallet is the bank's or the owner's (C02)", async function () {
    const f = await funded();
    const { m, bank, user, stranger, owner, other } = f;
    await m.connect(user).requestInvestorStatus(T.Retail);
    for (const who of [stranger, user])
      await expect(
        m.connect(who).createMultiSigWallet(user.address),
      ).to.be.revertedWith("Only bank can create wallet");
    expect((await m.requests(user.address)).multiSigWallet).to.equal(
      ethers.ZeroAddress,
    );
    await m.connect(bank).createMultiSigWallet(user.address);
    await f.token.mint(other.address, e("8000"));
    await m.connect(other).requestInvestorStatus(T.Retail);
    await m.connect(owner).createMultiSigWallet(other.address);
    expect((await m.requests(other.address)).status).to.equal(2n); // WalletCreated
  });

  it("approveRequest is the bank's or the owner's (C01)", async function () {
    const f = await funded();
    const { m, bank, user, stranger, types } = f;
    await lockedRequest(f, T.Retail);
    for (const who of [stranger, user])
      await expect(
        m.connect(who).approveRequest(user.address),
      ).to.be.revertedWith("Only bank can approve");
    expect(await types.getInvestorType(user.address)).to.equal(T.Normal);
    await m.connect(bank).approveRequest(user.address);
    expect(await types.getInvestorType(user.address)).to.equal(T.Retail);
  });

  it("the owner approves too", async function () {
    const f = await funded();
    await lockedRequest(f, T.Retail);
    await f.m.connect(f.owner).approveRequest(f.user.address);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Retail);
  });

  it("rejectRequest is the bank's or the owner's (C03)", async function () {
    const f = await funded();
    const { m, bank, owner, user, stranger } = f;
    await m.connect(user).requestInvestorStatus(T.Retail);
    for (const who of [stranger, user])
      await expect(
        m.connect(who).rejectRequest(user.address, "no"),
      ).to.be.revertedWith("Only bank can reject");
    expect(await m.hasActiveRequest(user.address)).to.equal(true);
    await m.connect(bank).rejectRequest(user.address, "no");
    expect(await m.hasActiveRequest(user.address)).to.equal(false);
    await m.connect(user).requestInvestorStatus(T.Retail);
    await m.connect(owner).rejectRequest(user.address, "again");
    expect((await m.requests(user.address)).rejectionReason).to.equal("again");
  });

  it("updateLockRequirement is the owner's (W01)", async function () {
    const { m, bank, stranger } = await deployCustody();
    for (const who of [bank, stranger])
      await expect(m.connect(who).updateLockRequirement(T.Retail, e("1")))
        .to.be.revertedWithCustomError(m, "OwnableUnauthorizedAccount")
        .withArgs(who.address);
    expect(await m.lockRequirements(T.Retail)).to.equal(e("2000"));
  });

  it("one active request per user (C07); an investor cannot request again (C08)", async function () {
    const f = await funded();
    const { m, user, owner, types } = f;
    await m.connect(user).requestInvestorStatus(T.Retail);
    await expect(
      m.connect(user).requestInvestorStatus(T.Accredited),
    ).to.be.revertedWith("Active request already exists");
    expect((await m.requests(user.address)).requestedType).to.equal(T.Retail);
    // `other` is already Retail by the compliance officer's upgrade.
    await types.setComplianceOfficer(owner.address, true);
    await types.upgradeInvestorType(f.other.address, T.Retail);
    await expect(
      m.connect(f.other).requestInvestorStatus(T.Accredited),
    ).to.be.revertedWith("Already an investor");
    expect(await m.hasActiveRequest(f.other.address)).to.equal(false);
  });

  it("confirmTokensLocked refuses a lock below the requirement (C13); a second lock is refused (C11)", async function () {
    const f = await funded();
    const { m, bank, user, token } = f;
    await m.connect(user).requestInvestorStatus(T.Retail);
    await m.connect(bank).createMultiSigWallet(user.address);
    const r = await m.requests(user.address);
    const wallet = await ethers.getContractAt(
      "MultiSigWallet",
      r.multiSigWallet,
    );
    await token.connect(user).approve(r.multiSigWallet, r.requiredLockAmount);
    await wallet.connect(user).lockTokens(r.requiredLockAmount - 1n);
    await expect(m.connect(user).confirmTokensLocked()).to.be.revertedWith(
      "Insufficient tokens locked",
    );
    expect((await m.requests(user.address)).status).to.equal(2n); // WalletCreated
    await expect(wallet.connect(user).lockTokens(1n)).to.be.revertedWith(
      "Tokens already locked",
    );
    expect(await wallet.lockedAmount()).to.equal(r.requiredLockAmount - 1n);
  });

  it("approveRequest refuses once the lock was unlocked below the requirement (C04)", async function () {
    const f = await funded();
    const { m, bank, user, types } = f;
    const { wallet } = await lockedRequest(f, T.Retail);
    const id = await idOf(
      wallet,
      wallet.connect(user).proposeUnlock(1n, user.address, "back out"),
    );
    await wallet.connect(user).signUnlock(id);
    await wallet.connect(bank).signUnlock(id);
    await expect(
      m.connect(bank).approveRequest(user.address),
    ).to.be.revertedWith("Tokens no longer locked");
    expect(await types.getInvestorType(user.address)).to.equal(T.Normal);
  });
});
