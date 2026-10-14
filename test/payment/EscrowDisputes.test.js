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

  beforeEach(async function () {
    ({ vscToken, factory, investor, payer, payee, investorWallet } =
      await deployEscrowSystem());
  });

  describe("Shipment Proof Submission", function () {
    let wallet;
    let walletAddress;

    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      walletAddress = await factory.getWalletAddress(1);

      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(walletAddress);

      // Fund the wallet
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);
    });

    it("Should submit shipment proof successfully", async function () {
      const proofData = JSON.stringify({
        trackingNumber: "1Z999AA10123456784",
        carrier: "UPS",
        shipDate: "2024-01-15",
        photos: ["ipfs://Qm..."],
      });

      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
      const signature = await signProof(
        payee,
        await wallet.getAddress(),
        dataHash,
      );

      await wallet
        .connect(payee)
        .submitShipmentProof(proofData, dataHash, signature);

      const proof = await wallet.shipmentProof();
      expect(proof.exists).to.be.true;
      expect(proof.data).to.equal(proofData);
      expect(proof.dataHash).to.equal(dataHash);
    });

    it("Should only allow payee to submit proof", async function () {
      const proofData = "test";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
      const signature = "0x00";

      await expect(
        wallet
          .connect(payer)
          .submitShipmentProof(proofData, dataHash, signature),
      ).to.be.revertedWith("Only payee can submit proof");
    });

    it("Should verify hash matches data", async function () {
      const proofData = "test data";
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong data"));
      const signature = "0x00";

      await expect(
        wallet
          .connect(payee)
          .submitShipmentProof(proofData, wrongHash, signature),
      ).to.be.revertedWith("Hash mismatch");
    });
  });

  describe("Dispute Window", function () {
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

      // Submit proof
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
    });

    it("Should allow payer to raise dispute within 14 days", async function () {
      await wallet.connect(payer).raiseDispute();
      expect(await wallet.state()).to.equal(3); // Disputed
    });

    it("Should not allow dispute after 14 days", async function () {
      await time.increase(15 * 24 * 60 * 60); // 15 days

      await expect(wallet.connect(payer).raiseDispute()).to.be.revertedWith(
        "Dispute window closed",
      );
    });

    it("Should check if dispute window is open", async function () {
      expect((await wallet.getWalletStatus()).disputeWindowOpen).to.be.true;

      await time.increase(15 * 24 * 60 * 60);
      expect((await wallet.getWalletStatus()).disputeWindowOpen).to.be.false;
    });
  });

  describe("Dispute Resolution", function () {
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

      await wallet.connect(payer).raiseDispute();
    });

    it("Should allow investor to resolve dispute with refund", async function () {
      const payerBalanceBefore = await vscToken.balanceOf(payer.address);

      await wallet.connect(investor).resolveDispute(true);

      const payerBalanceAfter = await vscToken.balanceOf(payer.address);
      expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
      expect(await wallet.state()).to.equal(2); // Refunded
    });

    it("Should allow investor to resolve dispute without refund", async function () {
      await wallet.connect(investor).resolveDispute(false);
      expect(await wallet.state()).to.equal(0); // Active
    });

    it("Should only allow investor to resolve", async function () {
      await expect(
        wallet.connect(payer).resolveDispute(true),
      ).to.be.revertedWith("Only investor can resolve");
    });
  });
});
