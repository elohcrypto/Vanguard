const { expect } = require("chai");
const { ethers } = require("hardhat");
const { attest } = require("../helpers/kyc");
const {
  PAYMENT_AMOUNT,
  TOTAL_AMOUNT,
  signProof,
  deployEscrowSystem,
} = require("../helpers/escrowFixture");

describe("Enhanced Escrow System", function () {
  let vscToken;
  let factory;
  let identityRegistry;
  let kycIssuer;
  let owner;
  let investor;
  let payer;
  let payee;
  let investorWallet;
  let ownerWallet;

  beforeEach(async function () {
    ({
      vscToken,
      factory,
      identityRegistry,
      kycIssuer,
      owner,
      investor,
      payer,
      payee,
      investorWallet,
      ownerWallet,
    } = await deployEscrowSystem());
  });

  describe("Manual Refund", function () {
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

    it("Should allow investor to manually refund", async function () {
      const payerBalanceBefore = await vscToken.balanceOf(payer.address);

      await wallet.connect(investor).manualRefund();

      const payerBalanceAfter = await vscToken.balanceOf(payer.address);
      expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
      expect(await wallet.state()).to.equal(2); // Refunded
    });

    it("Should only allow investor to manually refund", async function () {
      await expect(wallet.connect(payer).manualRefund()).to.be.revertedWith(
        "Only investor can refund",
      );
    });
  });

  describe("Investor cannot be a counterparty (self-dealing)", function () {
    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
    });

    it("rejects creating an escrow where the investor is the payee", async function () {
      await expect(
        factory
          .connect(investor)
          .createEscrowWallet(payer.address, investor.address, PAYMENT_AMOUNT),
      ).to.be.revertedWithCustomError(factory, "InvestorCannotBePayee");
    });

    it("rejects creating an escrow where the investor is the payer", async function () {
      await expect(
        factory
          .connect(investor)
          .createEscrowWallet(investor.address, payee.address, PAYMENT_AMOUNT),
      ).to.be.revertedWithCustomError(factory, "InvestorCannotBePayer");
    });

    it("still allows a normal three-party escrow", async function () {
      await expect(
        factory
          .connect(investor)
          .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT),
      ).to.not.be.reverted;
    });

    // Qodo/Augment on PR #7: a marketplace escrow (payer unknown) skipped
    // the constructor check, and setPayer accepted the investor.
    it("marketplace: the investor cannot fund an unknown-payer escrow (would become payer)", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);
      const wallet = (
        await ethers.getContractFactory("MultiSigEscrowWallet")
      ).attach(await factory.getWalletAddress(1));
      const investorId = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(investor.address);
      await identityRegistry.registerIdentity(
        investor.address,
        await investorId.getAddress(),
        840,
      );
      await attest(kycIssuer, owner, await investorId.getAddress());
      await vscToken.transfer(investor.address, TOTAL_AMOUNT);
      await vscToken
        .connect(investor)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await expect(
        factory.connect(investor).fundEscrowWallet(1),
      ).to.be.revertedWithCustomError(wallet, "InvestorCannotBePayer");
      expect(await wallet.payerSet()).to.equal(false);
    });

    it("marketplace: setPayer(investor) is rejected, a distinct payer is accepted", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);
      const wallet = (
        await ethers.getContractFactory("MultiSigEscrowWallet")
      ).attach(await factory.getWalletAddress(1));
      await expect(
        wallet.connect(investor).setPayer(investor.address),
      ).to.be.revertedWithCustomError(wallet, "InvestorCannotBePayer");
      await wallet.connect(investor).setPayer(payer.address);
      expect(await wallet.payer()).to.equal(payer.address);
    });

    // Integration review: the factory rejects payer == payee at creation, but a
    // marketplace payee could fund first and become its own payer via setPayer.
    it("marketplace: the payee cannot fund first and become its own payer", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);
      const wallet = (
        await ethers.getContractFactory("MultiSigEscrowWallet")
      ).attach(await factory.getWalletAddress(1));
      await vscToken.transfer(payee.address, TOTAL_AMOUNT);
      await vscToken
        .connect(payee)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await expect(
        factory.connect(payee).fundEscrowWallet(1),
      ).to.be.revertedWithCustomError(wallet, "PayerCannotBePayee");
      await expect(
        wallet.connect(investor).setPayer(payee.address),
      ).to.be.revertedWithCustomError(wallet, "PayerCannotBePayee");
      expect(await wallet.payerSet()).to.equal(false);
    });

    it("wallet constructor rejects investor == payee (defence in depth)", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      await expect(
        W.deploy(
          1,
          payer.address,
          investor.address /* payee==investor */,
          investor.address,
          await vscToken.getAddress(),
          PAYMENT_AMOUNT,
          0,
          0,
          owner.address,
          investorWallet.address,
          ownerWallet.address,
        ),
      ).to.be.revertedWithCustomError(W, "InvestorCannotBePayee");
    });

    // Augment on PR #7: the payer guard at construction was only reached
    // through the factory, which rejects first. Exercise it directly.
    it("wallet constructor rejects investor == payer (defence in depth)", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      await expect(
        W.deploy(
          1,
          investor.address /* payer==investor */,
          payee.address,
          investor.address,
          await vscToken.getAddress(),
          PAYMENT_AMOUNT,
          0,
          0,
          owner.address,
          investorWallet.address,
          ownerWallet.address,
        ),
      ).to.be.revertedWithCustomError(W, "InvestorCannotBePayer");
    });

    // Escrow review 2.3.1: payer == payee was refused only by the factory.
    it("wallet constructor rejects payer == payee (defence in depth)", async function () {
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      await expect(
        W.deploy(
          1,
          payee.address /* payer==payee */,
          payee.address,
          investor.address,
          await vscToken.getAddress(),
          PAYMENT_AMOUNT,
          0,
          0,
          owner.address,
          investorWallet.address,
          ownerWallet.address,
        ),
      ).to.be.revertedWithCustomError(W, "PayerCannotBePayee");
    });
  });

  describe("Manual refund cannot rug a shipped payee", function () {
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

    async function ship() {
      const data = JSON.stringify({ tracking: "1Z", carrier: "UPS" });
      const hash = ethers.keccak256(ethers.toUtf8Bytes(data));
      const sig = await signProof(payee, await wallet.getAddress(), hash);
      await wallet.connect(payee).submitShipmentProof(data, hash, sig);
    }

    it("blocks manualRefund once the payee has shipped (Active + proof)", async function () {
      await ship();
      await expect(
        wallet.connect(investor).manualRefund(),
      ).to.be.revertedWithCustomError(wallet, "RefundBlockedAfterShipment");
      expect(await wallet.state()).to.equal(0); // still Active, funds untouched
    });

    it("still allows manualRefund before shipment (Active, no proof)", async function () {
      const before = await vscToken.balanceOf(payer.address);
      await wallet.connect(investor).manualRefund();
      expect((await vscToken.balanceOf(payer.address)) - before).to.equal(
        TOTAL_AMOUNT,
      );
      expect(await wallet.state()).to.equal(2); // Refunded
    });

    it("still allows manualRefund on a raised dispute (Disputed)", async function () {
      await ship();
      await wallet.connect(payer).raiseDispute();
      expect(await wallet.state()).to.equal(3); // Disputed
      const before = await vscToken.balanceOf(payer.address);
      await wallet.connect(investor).manualRefund();
      expect((await vscToken.balanceOf(payer.address)) - before).to.equal(
        TOTAL_AMOUNT,
      );
      expect(await wallet.state()).to.equal(2); // Refunded
    });
  });
});
