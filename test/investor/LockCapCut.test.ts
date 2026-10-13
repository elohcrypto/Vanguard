import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  T,
  deployCustody,
  lockedRequest,
  setNormalCaps,
} from "../helpers/custody";

// Plan v2 Task 5.1, A1F-6: InvestorRequestManager checked a lock against
// the Normal cap only when the lock requirement was set. After the
// registry's Normal cap was cut, a request made earlier carried a lock no
// Normal holder can make or hold (review probe P7) and sat there until
// the bank rejected it. Every forward step now re-reads the cap and
// refuses by name (LockAboveNormalCap); rejectRequest stays open.

describe("Task 5.1: request locks after a Normal cap cut", function () {
  async function setup() {
    const f = await deployCustody();
    await f.token.mint(f.user.address, f.cap * 2n);
    await time.increase(3601);
    return f;
  }
  const cut = (f: any, to: bigint) => setNormalCaps(f.types, to, to);
  const status = async (f: any) =>
    Number((await f.m.requests(f.user.address)).status);
  const REJECTED = 5;

  it("a request made after the cut is refused", async function () {
    const f = await setup();
    await cut(f, f.cap / 8n);
    await expect(f.m.connect(f.user).requestInvestorStatus(T.Retail))
      .to.be.revertedWithCustomError(f.m, "LockAboveNormalCap")
      .withArgs(f.cap / 4n, f.cap / 8n);
  });

  it("wallet creation after the cut is refused; the bank can still reject", async function () {
    const f = await setup();
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await cut(f, f.cap / 8n);
    await expect(f.m.connect(f.bank).createMultiSigWallet(f.user.address))
      .to.be.revertedWithCustomError(f.m, "LockAboveNormalCap")
      .withArgs(f.cap / 4n, f.cap / 8n);
    await f.m.connect(f.bank).rejectRequest(f.user.address, "cap cut");
    expect(await status(f)).to.equal(REJECTED);
    expect(await f.m.hasActiveRequest(f.user.address)).to.equal(false);
  });

  it("P7 regression: lockTokens refuses a lock above the cut cap", async function () {
    const f = await setup();
    await f.m.connect(f.user).requestInvestorStatus(T.Institutional);
    await f.m.connect(f.bank).createMultiSigWallet(f.user.address);
    await cut(f, f.cap / 8n);
    const w = (await f.m.requests(f.user.address)).multiSigWallet;
    await f.token.connect(f.user).approve(w, f.cap);
    const wallet = await ethers.getContractAt("MultiSigWallet", w);
    await expect(wallet.connect(f.user).lockTokens(f.cap))
      .to.be.revertedWithCustomError(wallet, "LockAboveNormalCap")
      .withArgs(f.cap, f.cap / 8n);
    await f.m.connect(f.bank).rejectRequest(f.user.address, "cap cut");
    expect(await status(f)).to.equal(REJECTED);
  });

  it("a holding-only cut: lockTokens refuses a lock above the new cap", async function () {
    // R-51-1: the token's per-transfer cap alone let this lock through.
    const f = await setup();
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await f.m.connect(f.bank).createMultiSigWallet(f.user.address);
    const r = await f.m.requests(f.user.address);
    const c = await f.types.getInvestorTypeConfig(0);
    await setNormalCaps(f.types, c.maxTransferAmount, f.cap / 8n);
    await f.token
      .connect(f.user)
      .approve(r.multiSigWallet, r.requiredLockAmount);
    const wallet = await ethers.getContractAt(
      "MultiSigWallet",
      r.multiSigWallet,
    );
    await expect(wallet.connect(f.user).lockTokens(r.requiredLockAmount))
      .to.be.revertedWithCustomError(wallet, "LockAboveNormalCap")
      .withArgs(r.requiredLockAmount, f.cap / 8n);
    await wallet.connect(f.user).lockTokens(f.cap / 8n);
    expect(await wallet.getLockedBalance()).to.equal(f.cap / 8n);
  });

  it("confirming a lock made before the cut is refused", async function () {
    const f = await setup();
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await f.m.connect(f.bank).createMultiSigWallet(f.user.address);
    const r = await f.m.requests(f.user.address);
    await f.token
      .connect(f.user)
      .approve(r.multiSigWallet, r.requiredLockAmount);
    const wallet = await ethers.getContractAt(
      "MultiSigWallet",
      r.multiSigWallet,
    );
    await wallet.connect(f.user).lockTokens(r.requiredLockAmount);
    await cut(f, f.cap / 8n);
    await expect(f.m.connect(f.user).confirmTokensLocked())
      .to.be.revertedWithCustomError(f.m, "LockAboveNormalCap")
      .withArgs(f.cap / 4n, f.cap / 8n);
  });

  it("cut-then-reject: approval of a locked request is refused, rejection works", async function () {
    const f = await setup();
    const { wallet, lock } = await lockedRequest(f, T.Retail);
    await cut(f, f.cap / 8n);
    await expect(f.m.connect(f.bank).approveRequest(f.user.address))
      .to.be.revertedWithCustomError(f.m, "LockAboveNormalCap")
      .withArgs(lock, f.cap / 8n);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Normal);
    await f.m.connect(f.bank).rejectRequest(f.user.address, "cap cut");
    expect(await status(f)).to.equal(REJECTED);
    expect(await wallet.getLockedBalance()).to.equal(lock);
  });

  it("a cut down to exactly the lock leaves the request moving", async function () {
    const f = await setup();
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await cut(f, f.cap / 4n);
    await f.m.connect(f.bank).createMultiSigWallet(f.user.address);
    const r = await f.m.requests(f.user.address);
    await f.token
      .connect(f.user)
      .approve(r.multiSigWallet, r.requiredLockAmount);
    const wallet = await ethers.getContractAt(
      "MultiSigWallet",
      r.multiSigWallet,
    );
    await wallet.connect(f.user).lockTokens(r.requiredLockAmount);
    await f.m.connect(f.user).confirmTokensLocked();
    await f.m.connect(f.bank).approveRequest(f.user.address);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Retail);
  });

  describe("MultiSigWallet's own read of the cap", function () {
    async function wallet() {
      const [, bank, user] = await ethers.getSigners();
      const tok = await (
        await ethers.getContractFactory("MockTypedToken")
      ).deploy();
      const w = await (
        await ethers.getContractFactory("MultiSigWallet")
      ).deploy(bank.address, user.address, await tok.getAddress());
      await tok.mint(user.address, 10n ** 30n);
      await tok.connect(user).approve(await w.getAddress(), 10n ** 30n);
      return { tok, w: w.connect(user) };
    }

    it("a token whose investor-type registry is unset applies no cap", async function () {
      const { w } = await wallet();
      await w.lockTokens(10n ** 30n);
      expect(await w.getLockedBalance()).to.equal(10n ** 30n);
    });

    it("the cap is the registry's smaller Normal cap, read at the lock", async function () {
      const { tok, w } = await wallet();
      const types = await (
        await ethers.getContractFactory("InvestorTypeRegistry")
      ).deploy();
      await tok.setInvestorTypeRegistry(await types.getAddress());
      await setNormalCaps(types, 700n, 500n);
      await expect(w.lockTokens(501n))
        .to.be.revertedWithCustomError(w, "LockAboveNormalCap")
        .withArgs(501n, 500n);
      await setNormalCaps(types, 400n, 500n);
      await expect(w.lockTokens(401n))
        .to.be.revertedWithCustomError(w, "LockAboveNormalCap")
        .withArgs(401n, 400n);
      await w.lockTokens(400n);
    });
  });
});
