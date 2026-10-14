const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  PAYMENT_AMOUNT,
  INVESTOR_FEE,
  OWNER_FEE,
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

  beforeEach(async function () {
    ({ vscToken, factory, investor, payer, payee, investorWallet } =
      await deployEscrowSystem());
  });

  describe("Fee Calculation", function () {
    it("Should calculate fees correctly", async function () {
      const fees = await factory.calculateFees(PAYMENT_AMOUNT);

      expect(fees.investorFee).to.equal(INVESTOR_FEE);
      expect(fees.ownerFee).to.equal(OWNER_FEE);
      expect(fees.totalFee).to.equal(INVESTOR_FEE + OWNER_FEE);
      expect(fees.totalAmount).to.equal(TOTAL_AMOUNT);
    });
  });

  describe("Unknown Payer (Marketplace Scenario)", function () {
    let wallet;
    let walletAddress;

    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
    });

    it("Should create wallet with unknown payer (address(0))", async function () {
      await factory.connect(investor).createEscrowWallet(
        ethers.ZeroAddress, // Unknown payer
        payee.address,
        PAYMENT_AMOUNT,
      );

      walletAddress = await factory.getWalletAddress(1);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(walletAddress);

      expect(await wallet.payer()).to.equal(ethers.ZeroAddress);
      expect(await wallet.payerSet()).to.be.false;
    });

    it("Should set payer on first funding", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);

      walletAddress = await factory.getWalletAddress(1);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(walletAddress);

      // First buyer funds (becomes the payer automatically)
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);

      expect(await wallet.payer()).to.equal(payer.address);
      expect(await wallet.payerSet()).to.be.true;
    });

    it("Should not allow setting payer twice", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);

      walletAddress = await factory.getWalletAddress(1);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(walletAddress);

      await wallet.connect(investor).setPayer(payer.address);

      await expect(
        wallet.connect(investor).setPayer(payee.address),
      ).to.be.revertedWith("Payer already set");
    });

    it("Should complete marketplace flow with unknown payer", async function () {
      // Create wallet for seller (payer unknown)
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);

      walletAddress = await factory.getWalletAddress(1);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(walletAddress);

      // Buyer pays (becomes payer automatically via factory)
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);

      // Verify payer was set
      expect(await wallet.payer()).to.equal(payer.address);
      expect(await wallet.payerSet()).to.be.true;

      // Seller ships
      const proofData = "test";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
      const signature = await signProof(
        payee,
        await wallet.getAddress(),
        dataHash,
      );
      await wallet
        .connect(payee)
        .submitShipmentProof(proofData, dataHash, signature);

      // Wait 14 days
      await time.increase(15 * 24 * 60 * 60);

      // Both sign
      const payeeBalanceBefore = await vscToken.balanceOf(payee.address);
      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);

      const payeeBalanceAfter = await vscToken.balanceOf(payee.address);
      expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(PAYMENT_AMOUNT);
    });
  });

  describe("Wallet Status", function () {
    let wallet;

    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      const walletAddress = await factory.getWalletAddress(1);

      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(walletAddress);

      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);
    });

    it("Should get wallet status correctly", async function () {
      const status = await wallet.getWalletStatus();

      expect(status.currentState).to.equal(0); // Active
      expect(status.payerIsSet).to.be.true;
      expect(status.proofSubmitted).to.be.false;
      expect(status.disputeWindowOpen).to.be.false;
      expect(status.readyForSignatures).to.be.false;
      expect(status.payerHasSigned).to.be.false;
      expect(status.payeeHasSigned).to.be.false;
      expect(status.investorHasSigned).to.be.false;
    });

    it("Should update status after proof submission", async function () {
      const proofData = "test";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
      const signature = await signProof(
        payee,
        await wallet.getAddress(),
        dataHash,
      );
      await wallet
        .connect(payee)
        .submitShipmentProof(proofData, dataHash, signature);

      const status = await wallet.getWalletStatus();

      expect(status.proofSubmitted).to.be.true;
      expect(status.disputeWindowOpen).to.be.true;
      expect(status.readyForSignatures).to.be.false;
    });
  });
});
