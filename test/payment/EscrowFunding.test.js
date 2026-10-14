const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  PAYMENT_AMOUNT,
  TOTAL_AMOUNT,
  signProof,
  deployEscrowSystem,
} = require("../helpers/escrowFixture");

describe("Enhanced Escrow System", function () {
  let vscToken;
  let factory;
  let investor;
  let payer;
  let payee;
  let investorWallet;
  let ownerWallet;
  let signers;

  beforeEach(async function () {
    ({
      vscToken,
      factory,
      investor,
      payer,
      payee,
      investorWallet,
      ownerWallet,
      signers,
    } = await deployEscrowSystem());
  });

  describe("Funding Escrow Wallet", function () {
    let walletAddress;

    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      walletAddress = await factory.getWalletAddress(1);
    });

    it("Should fund escrow wallet successfully", async function () {
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);

      const balance = await vscToken.balanceOf(walletAddress);
      expect(balance).to.equal(TOTAL_AMOUNT);
    });

    // Funding used to be gated only on `state == Active`, which is true
    // both before AND after funding. A second call therefore went through
    // and the extra tokens were stranded: release and refund pay fixed
    // sums (amount and fees are immutable) and there is no sweep.
    it("rejects a second funding of the same escrow", async function () {
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT * 3n);
      await factory.connect(payer).fundEscrowWallet(1);
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      expect(await W.attach(walletAddress).funded()).to.be.true;

      await expect(
        factory.connect(payer).fundEscrowWallet(1),
      ).to.be.revertedWithCustomError(factory, "EscrowAlreadyFunded");

      expect(await vscToken.balanceOf(walletAddress)).to.equal(TOTAL_AMOUNT);
    });

    it("leaves no stranded balance after release", async function () {
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT * 3n);
      await factory.connect(payer).fundEscrowWallet(1);
      try {
        await factory.connect(payer).fundEscrowWallet(1);
      } catch (e) {
        /* must revert */
      }

      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const wallet = W.attach(walletAddress);
      const data = "shipped";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(data));
      await wallet
        .connect(payee)
        .submitShipmentProof(
          data,
          dataHash,
          await signProof(payee, walletAddress, dataHash),
        );
      await time.increase(15 * 24 * 60 * 60);
      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);

      expect(await vscToken.balanceOf(walletAddress)).to.equal(0n);
    });

    it("markFunded is callable only by the factory", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const wallet = W.attach(walletAddress);
      await expect(
        wallet.connect(payer).markFunded(),
      ).to.be.revertedWithCustomError(wallet, "OnlyFactory");
    });

    // Found reviewing PR #4: `funded` stops a second FACTORY funding, but
    // any verified holder can transfer straight to the escrow. Release and
    // refund pay fixed sums, so whatever else arrived sat there forever.
    it("returns tokens sent directly to the escrow to the payer once settled", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const wallet = W.attach(walletAddress);
      await vscToken.connect(payer).transfer(walletAddress, TOTAL_AMOUNT); // direct, not via factory
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);
      expect(await vscToken.balanceOf(walletAddress)).to.equal(
        TOTAL_AMOUNT * 2n,
      );

      const data = "shipped";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(data));
      await wallet
        .connect(payee)
        .submitShipmentProof(
          data,
          dataHash,
          await signProof(payee, walletAddress, dataHash),
        );
      await time.increase(15 * 24 * 60 * 60);
      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);
      expect(
        await vscToken.balanceOf(walletAddress),
        "release pays fixed sums",
      ).to.equal(TOTAL_AMOUNT);

      // Escrow parties only (2F.4, H4): a public sweep let any holder relay
      // tokens through a settled escrow.
      await expect(
        wallet.connect(signers[9]).sweepExcess(),
      ).to.be.revertedWithCustomError(wallet, "NotEscrowParty");

      const before = await vscToken.balanceOf(payer.address);
      await expect(wallet.connect(payee).sweepExcess()) // any party may trigger it
        .to.emit(wallet, "ExcessSwept")
        .withArgs(payer.address, TOTAL_AMOUNT);
      expect(await vscToken.balanceOf(walletAddress)).to.equal(0n);
      expect((await vscToken.balanceOf(payer.address)) - before).to.equal(
        TOTAL_AMOUNT,
      );
    });

    it("does not sweep while the escrow is still live", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const wallet = W.attach(walletAddress);
      await vscToken.connect(payer).transfer(walletAddress, TOTAL_AMOUNT);
      await expect(wallet.sweepExcess()).to.be.revertedWithCustomError(
        wallet,
        "EscrowStillActive",
      );
      // The party check comes first: a stranger never learns the state.
      await expect(
        wallet.connect(signers[9]).sweepExcess(),
      ).to.be.revertedWithCustomError(wallet, "NotEscrowParty");
    });

    it("sweeps to the platform fee wallet when no payer ever identified themselves", async function () {
      // Marketplace escrow settled purely from direct transfers: payer is
      // still address(0), where a transfer would revert and strand it.
      // The fee wallet is the fallback because release already pays it.
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const wallet = W.attach(await factory.getWalletAddress(2));
      await vscToken
        .connect(payer)
        .transfer(
          await wallet.getAddress(),
          TOTAL_AMOUNT + ethers.parseEther("3"),
        );

      const data = "shipped";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(data));
      await wallet
        .connect(payee)
        .submitShipmentProof(
          data,
          dataHash,
          await signProof(payee, await wallet.getAddress(), dataHash),
        );
      await time.increase(15 * 24 * 60 * 60);
      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);
      expect(await wallet.payerSet()).to.be.false;

      await expect(wallet.sweepExcess())
        .to.emit(wallet, "ExcessSwept")
        .withArgs(ownerWallet.address, ethers.parseEther("3"));
    });

    it("sweeps after a refund too, and only once", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const wallet = W.attach(walletAddress);
      await vscToken
        .connect(payer)
        .transfer(walletAddress, ethers.parseEther("7"));
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);
      await wallet.connect(investor).manualRefund();

      const before = await vscToken.balanceOf(payer.address);
      await wallet.sweepExcess();
      expect((await vscToken.balanceOf(payer.address)) - before).to.equal(
        ethers.parseEther("7"),
      );
      await expect(wallet.sweepExcess()).to.be.revertedWithCustomError(
        wallet,
        "NothingToSweep",
      );
    });

    it("Should only allow payer to fund", async function () {
      await vscToken
        .connect(payee)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await expect(
        factory.connect(payee).fundEscrowWallet(1),
      ).to.be.revertedWith("Only payer can fund");
    });

    it("Should reject funding from unverified payer", async function () {
      const unverifiedPayer = signers[12];
      await vscToken.transfer(unverifiedPayer.address, TOTAL_AMOUNT);

      // Create wallet with unknown payer
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);

      await vscToken
        .connect(unverifiedPayer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await expect(
        factory.connect(unverifiedPayer).fundEscrowWallet(2),
      ).to.be.revertedWith("Payer must have valid KYC/AML (OnchainID)");
    });
  });
});
