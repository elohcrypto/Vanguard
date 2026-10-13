import { expect } from "chai";
import { ethers } from "hardhat";

// Plan v2 Task 5.2: the factory paid fees with 2300-gas .transfer, so a
// contract feeRecipient (a multisig treasury, D54) blocked every paid
// deploy. The push is now a checked call; a refused fee is owed instead.
describe("OnchainIDFactory fee path (Task 5.2)", function () {
  const FEE = ethers.parseEther("0.01");

  async function setup() {
    const [owner, user, other] = await ethers.getSigners();
    const fac = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address, ethers.ZeroHash);
    await fac.setDeploymentFee(FEE);
    const rec = await (
      await ethers.getContractFactory("RefusingFeeRecipient")
    ).deploy();
    await fac.setFeeRecipient(await rec.getAddress());
    return { owner, user, other, fac, rec };
  }

  const paths = (fac: any, user: any) => [
    () =>
      fac.connect(user).deployOnchainID(user.address, ethers.id("a"), {
        value: FEE,
      }),
    () =>
      fac
        .connect(user)
        .deployOnchainIDWithKey(user.address, ethers.id("k"), ethers.id("b"), {
          value: FEE,
        }),
    () =>
      fac
        .connect(user)
        .batchDeployOnchainID(
          [ethers.Wallet.createRandom().address],
          [ethers.id("c")],
          { value: FEE },
        ),
  ];

  for (const burn of [false, true]) {
    it(`a ${burn ? "gas-burning" : "reverting"} feeRecipient blocks no deploy and withdraws later`, async function () {
      const { owner, user, other, fac, rec } = await setup();
      await rec.setBurn(burn);
      const recAddr = await rec.getAddress();
      for (const deploy of paths(fac, user)) {
        await expect(deploy())
          .to.emit(fac, "FeeDeferred")
          .withArgs(recAddr, FEE);
      }
      expect(await fac.totalIdentities()).to.equal(3n);
      expect(await fac.pendingFees(recAddr)).to.equal(FEE * 3n);
      expect(await fac.totalPendingFees()).to.equal(FEE * 3n);
      // The emergency withdrawals cannot take what is owed.
      await expect(fac.emergencyWithdraw()).to.be.revertedWith(
        "OnchainIDFactory: No balance to withdraw",
      );
      await owner.sendTransaction({ to: await fac.getAddress(), value: 7n });
      await expect(
        fac.emergencyWithdrawTo(other.address),
      ).to.changeEtherBalance(other, 7n);
      // The recipient pulls to another address, once.
      await expect(
        rec.pull(await fac.getAddress(), other.address),
      ).to.changeEtherBalance(other, FEE * 3n);
      expect(await fac.pendingFees(recAddr)).to.equal(0n);
      expect(await fac.totalPendingFees()).to.equal(0n);
      await expect(
        rec.pull(await fac.getAddress(), other.address),
      ).to.be.revertedWith("OnchainIDFactory: No fees pending");
    });
  }

  it("a recipient that accepts is paid at deploy, nothing owed", async function () {
    const { user, other, fac } = await setup();
    await fac.setFeeRecipient(other.address);
    const tx = fac.connect(user).deployOnchainID(user.address, ethers.id("p"), {
      value: FEE,
    });
    await expect(tx).to.changeEtherBalance(other, FEE);
    await expect(tx).not.to.emit(fac, "FeeDeferred");
    expect(await fac.totalPendingFees()).to.equal(0n);
  });

  it("withdrawFees refuses the zero address", async function () {
    const { user, fac } = await setup();
    await expect(
      fac.connect(user).withdrawFees(ethers.ZeroAddress),
    ).to.be.revertedWith("OnchainIDFactory: Invalid recipient");
  });
});
