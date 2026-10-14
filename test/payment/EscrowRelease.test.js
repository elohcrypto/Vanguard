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
  let owner;
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
      owner,
      investor,
      payer,
      payee,
      investorWallet,
      ownerWallet,
      signers,
    } = await deployEscrowSystem());
  });

  describe("Multi-Signature Release (2-of-3)", function () {
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

      // Wait 14 days
      await time.increase(15 * 24 * 60 * 60);
    });

    it("Should allow payer to sign (for refund path)", async function () {
      await wallet.connect(payer).signAsPayer();
      expect(await wallet.payerSigned()).to.be.true;
    });

    it("Should allow payee to sign after dispute window", async function () {
      await wallet.connect(payee).signAsPayee();
      expect(await wallet.payeeSigned()).to.be.true;
    });

    it("Should allow investor to sign", async function () {
      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);
      expect(await wallet.investorSigned()).to.be.true;
    });

    // Escrow review 2.5.1: each release is recorded in the factory ledger.
    it("records the investor fee in the factory on release", async function () {
      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);
      const p = await factory.getInvestorProfile(investor.address);
      expect(p.totalFeesEarned).to.equal(INVESTOR_FEE);
      const call = factory.updateInvestorFeesEarned(investor.address, 1n);
      await expect(call).to.be.revertedWithoutReason(); // EOA: no paymentId()
    });

    // Review L3: the ledger accepts only the wallet the factory recorded
    // for that paymentId: an EOA and a look-alike escrow are refused.
    it("refuses a stranger in updateInvestorFeesEarned", async function () {
      await expect(
        factory.connect(payer).updateInvestorFeesEarned(investor.address, 1n),
      ).to.be.revertedWithoutReason(); // an EOA has no paymentId() to decode
      const W = await ethers.getContractFactory("MultiSigEscrowWallet");
      const fake = await W.deploy(
        1, // the id of the factory's real escrow
        payer.address,
        payee.address,
        investor.address,
        await vscToken.getAddress(),
        PAYMENT_AMOUNT,
        0,
        0,
        owner.address,
        investorWallet.address,
        ownerWallet.address,
      );
      const fAddr = await fake.getAddress();
      await ethers.provider.send("hardhat_setBalance", [
        fAddr,
        "0xDE0B6B3A7640000",
      ]);
      const asFake = await ethers.getImpersonatedSigner(fAddr);
      await expect(
        factory.connect(asFake).updateInvestorFeesEarned(investor.address, 1n),
      ).to.be.revertedWith("Only escrow wallet");
      expect(
        (await factory.getInvestorProfile(investor.address)).totalFeesEarned,
      ).to.equal(0);
    });

    // Task 4.3: the fee lands in the investor's 2-of-2 MultiSigWallet and
    // leaves it only with both signatures.
    it("routes the investor fee to a MultiSigWallet, released 2-of-2", async function () {
      const bank = signers[7];
      const msw = await (
        await ethers.getContractFactory("MultiSigWallet")
      ).deploy(bank.address, investor.address, await vscToken.getAddress());
      const mAddr = await msw.getAddress();
      await factory.deactivateInvestor(investor.address);
      await factory.registerInvestor(investor.address, mAddr);
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      const w2 = await ethers.getContractAt(
        "MultiSigEscrowWallet",
        await factory.getWalletAddress(2),
      );
      expect(await w2.investorWallet()).to.equal(mAddr);
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(2);
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("p2"));
      await w2
        .connect(payee)
        .submitShipmentProof(
          "p2",
          dataHash,
          await signProof(payee, await w2.getAddress(), dataHash),
        );
      await time.increase(15 * 24 * 60 * 60);
      await w2.connect(payee).signAsPayee();
      await w2.connect(investor).signAsInvestor(true);
      expect(await vscToken.balanceOf(mAddr)).to.equal(INVESTOR_FEE);
      expect(await msw.lockedAmount()).to.equal(0);

      const rc = await (
        await msw
          .connect(investor)
          .proposeUnlock(INVESTOR_FEE, investor.address, "fees")
      ).wait();
      const id = rc.logs
        .map((l) => {
          try {
            return msw.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((x) => x && x.name === "UnlockProposalCreated").args[0];
      await msw.connect(investor).signUnlock(id);
      expect(await vscToken.balanceOf(mAddr)).to.equal(INVESTOR_FEE);
      await msw.connect(bank).signUnlock(id);
      expect(await vscToken.balanceOf(mAddr)).to.equal(0);
      expect(await vscToken.balanceOf(investor.address)).to.equal(INVESTOR_FEE);
    });

    it("Should not allow payee signing during dispute window", async function () {
      // Create new wallet
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      const walletAddress2 = await factory.getWalletAddress(2);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      const wallet2 = MultiSigEscrowWallet.attach(walletAddress2);

      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(2);

      const proofData = "test";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
      const signature = await signProof(
        payee,
        await wallet2.getAddress(),
        dataHash,
      );
      await wallet2
        .connect(payee)
        .submitShipmentProof(proofData, dataHash, signature);

      await expect(wallet2.connect(payee).signAsPayee()).to.be.revertedWith(
        "Dispute window still open",
      );
    });

    it("Should auto-release to payee when investor + payee sign", async function () {
      const payeeBalanceBefore = await vscToken.balanceOf(payee.address);
      const investorBalanceBefore = await vscToken.balanceOf(
        investorWallet.address,
      );
      const ownerBalanceBefore = await vscToken.balanceOf(ownerWallet.address);

      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);

      const payeeBalanceAfter = await vscToken.balanceOf(payee.address);
      const investorBalanceAfter = await vscToken.balanceOf(
        investorWallet.address,
      );
      const ownerBalanceAfter = await vscToken.balanceOf(ownerWallet.address);

      expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(PAYMENT_AMOUNT);
      expect(investorBalanceAfter - investorBalanceBefore).to.equal(
        INVESTOR_FEE,
      );
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(OWNER_FEE);
      expect(await wallet.state()).to.equal(1); // Released
    });

    it("Should auto-refund to payer when investor + payer sign", async function () {
      const payerBalanceBefore = await vscToken.balanceOf(payer.address);

      await wallet.connect(payer).signAsPayer();
      await wallet.connect(investor).signAsInvestor(false);

      const payerBalanceAfter = await vscToken.balanceOf(payer.address);
      expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
      expect(await wallet.state()).to.equal(2); // Refunded
    });

    it("Should prioritize payee release if investor signs after payee", async function () {
      const payeeBalanceBefore = await vscToken.balanceOf(payee.address);

      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true);

      const payeeBalanceAfter = await vscToken.balanceOf(payee.address);
      expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(PAYMENT_AMOUNT);
      expect(await wallet.state()).to.equal(1); // Released
    });

    it("Should refund if investor signs after payer", async function () {
      const payerBalanceBefore = await vscToken.balanceOf(payer.address);

      await wallet.connect(payer).signAsPayer();
      await wallet.connect(investor).signAsInvestor(false);

      const payerBalanceAfter = await vscToken.balanceOf(payer.address);
      expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
      expect(await wallet.state()).to.equal(2); // Refunded
    });

    it("Should check if ready for signatures", async function () {
      expect((await wallet.getWalletStatus()).readyForSignatures).to.be.true;
    });
  });
});
