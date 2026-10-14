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

  describe("Shipment proof signature is verified on-chain", function () {
    // The proof used to be accepted on `signature.length > 0` alone: no
    // ecrecover, and nothing binding it to this wallet or chain. A payee
    // could release funds on a fabricated proof, and a real signature was
    // replayable across escrows because it was scoped to nothing.
    let wallet, walletAddr, chainId;
    const DATA = "shipped";

    // The signed payload binds the escrow, the chain and the content.
    async function proofSignature(signer, addr, id, dataHash) {
      const digest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "address", "uint256", "bytes32"],
          ["VanguardShipmentProof", addr, id, dataHash],
        ),
      );
      return signer.signMessage(ethers.getBytes(digest));
    }

    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      walletAddr = await factory.getWalletAddress(1);
      const F = await ethers.getContractFactory("MultiSigEscrowWallet");
      wallet = F.attach(walletAddr);
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);
      chainId = (await ethers.provider.getNetwork()).chainId;
    });

    it("accepts a correctly scoped signature from the payee", async function () {
      const dh = ethers.keccak256(ethers.toUtf8Bytes(DATA));
      const sig = await proofSignature(payee, walletAddr, chainId, dh);
      await expect(wallet.connect(payee).submitShipmentProof(DATA, dh, sig)).to
        .not.be.reverted;
      expect((await wallet.shipmentProof()).exists).to.be.true;
    });

    it("rejects a fabricated signature", async function () {
      const junk = "0x" + "11".repeat(65);
      await expect(
        wallet.connect(payee).submitShipmentProof(DATA, ethers.id(DATA), junk),
      ).to.be.revertedWithCustomError(wallet, "ECDSAInvalidSignature");
    });

    it("rejects a signature from someone other than the payee", async function () {
      const dh = ethers.keccak256(ethers.toUtf8Bytes(DATA));
      const sig = await proofSignature(payer, walletAddr, chainId, dh);
      await expect(
        wallet.connect(payee).submitShipmentProof(DATA, dh, sig),
      ).to.be.revertedWithCustomError(wallet, "ProofNotSignedByPayee");
    });

    it("rejects a signature replayed from a different escrow wallet", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      const otherAddr = await factory.getWalletAddress(2);
      const dh = ethers.keccak256(ethers.toUtf8Bytes(DATA));
      // Genuine payee signature, but scoped to the OTHER wallet.
      const sig = await proofSignature(payee, otherAddr, chainId, dh);
      await expect(
        wallet.connect(payee).submitShipmentProof(DATA, dh, sig),
      ).to.be.revertedWithCustomError(wallet, "ProofNotSignedByPayee");
    });

    it("rejects a signature scoped to a different chain", async function () {
      const dh = ethers.keccak256(ethers.toUtf8Bytes(DATA));
      const sig = await proofSignature(payee, walletAddr, 999999n, dh);
      await expect(
        wallet.connect(payee).submitShipmentProof(DATA, dh, sig),
      ).to.be.revertedWithCustomError(wallet, "ProofNotSignedByPayee");
    });
  });

  describe("Investor intent is explicit (misdirection regression)", function () {
    // The investor used to express no intent: signAsInvestor() inferred the
    // direction from whoever signed first. A payer could pre-sign silently,
    // and the investor's release then refunded the payer instead of paying
    // the payee who had shipped. Direction is now an explicit argument.
    let wallet;

    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      wallet = MultiSigEscrowWallet.attach(await factory.getWalletAddress(1));

      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(1);

      const proofData = "shipped";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
      const signature = await signProof(
        payee,
        await wallet.getAddress(),
        dataHash,
      );
      await wallet
        .connect(payee)
        .submitShipmentProof(proofData, dataHash, signature);
      await time.increase(15 * 24 * 60 * 60);
    });

    it("a pre-signing payer cannot divert the investor's release", async function () {
      // The attack: payer signs first, quietly. The investor then signs
      // intending to pay the payee.
      await wallet.connect(payer).signAsPayer();

      const payeeBefore = await vscToken.balanceOf(payee.address);
      const payerBefore = await vscToken.balanceOf(payer.address);

      await wallet.connect(payee).signAsPayee();
      await wallet.connect(investor).signAsInvestor(true); // true = release to payee

      expect((await vscToken.balanceOf(payee.address)) - payeeBefore).to.equal(
        PAYMENT_AMOUNT,
      );
      expect((await vscToken.balanceOf(payer.address)) - payerBefore).to.equal(
        0n,
      );
      expect(await wallet.state()).to.equal(1); // Released
    });

    it("releasing to the payee requires the payee's signature", async function () {
      await expect(
        wallet.connect(investor).signAsInvestor(true),
      ).to.be.revertedWithCustomError(wallet, "PayeeHasNotSigned");
    });

    it("refunding the payer requires the payer's signature", async function () {
      await expect(
        wallet.connect(investor).signAsInvestor(false),
      ).to.be.revertedWithCustomError(wallet, "PayerHasNotSigned");
    });

    it("an explicit refund still works when the payer has signed", async function () {
      await wallet.connect(payer).signAsPayer();
      const payerBefore = await vscToken.balanceOf(payer.address);
      await wallet.connect(investor).signAsInvestor(false);
      expect((await vscToken.balanceOf(payer.address)) - payerBefore).to.equal(
        TOTAL_AMOUNT,
      );
      expect(await wallet.state()).to.equal(2); // Refunded
    });

    it("resolving a dispute for the payee clears the payer's stale signature", async function () {
      // Needs its own wallet: the shared setup has already advanced past
      // the dispute window, and raiseDispute requires it to still be open.
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      const w2 = MultiSigEscrowWallet.attach(await factory.getWalletAddress(2));
      await vscToken
        .connect(payer)
        .approve(await factory.getAddress(), TOTAL_AMOUNT);
      await factory.connect(payer).fundEscrowWallet(2);
      const d = "shipped";
      const dh = ethers.keccak256(ethers.toUtf8Bytes(d));
      await w2
        .connect(payee)
        .submitShipmentProof(
          d,
          dh,
          await signProof(payee, await w2.getAddress(), dh),
        );

      await w2.connect(payer).signAsPayer();
      await w2.connect(payer).raiseDispute();
      await w2.connect(investor).resolveDispute(false); // payee deserves payment

      expect(await w2.payerSigned()).to.be.false;
      await expect(
        w2.connect(investor).signAsInvestor(false),
      ).to.be.revertedWithCustomError(w2, "PayerHasNotSigned");
    });
  });
});
