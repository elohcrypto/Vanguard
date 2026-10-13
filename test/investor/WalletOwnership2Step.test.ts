import { expect } from "chai";
import { ethers } from "hardhat";
import { T, deployCustody } from "../helpers/custody";

// Plan v2 Task 5.2 (Q7, A1 N10): MultiSigWallet is Ownable2Step. The
// manager that deploys a wallet owns it and nothing moves that ownership;
// a transfer, if one is ever made, only nominates.
describe("MultiSigWallet two-step ownership (Task 5.2, Q7)", function () {
  it("a manager-created wallet is owned by the manager, nothing pending", async function () {
    const f = await deployCustody();
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await f.m.connect(f.bank).createMultiSigWallet(f.user.address);
    const w = await ethers.getContractAt(
      "MultiSigWallet",
      (await f.m.requests(f.user.address)).multiSigWallet,
    );
    expect(await w.owner()).to.equal(await f.m.getAddress());
    expect(await w.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("transferOwnership nominates; only the nominee accepts", async function () {
    const [owner, bank, user, nominee, stranger] = await ethers.getSigners();
    const token = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("T", "T", 0);
    const w = await (
      await ethers.getContractFactory("MultiSigWallet")
    ).deploy(bank.address, user.address, await token.getAddress());
    await w.transferOwnership(nominee.address);
    expect(await w.owner()).to.equal(owner.address);
    expect(await w.pendingOwner()).to.equal(nominee.address);
    await expect(w.connect(stranger).acceptOwnership())
      .to.be.revertedWithCustomError(w, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await w.connect(nominee).acceptOwnership();
    expect(await w.owner()).to.equal(nominee.address);
    expect(await w.pendingOwner()).to.equal(ethers.ZeroAddress);
  });
});
