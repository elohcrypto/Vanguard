const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  PAYMENT_AMOUNT,
  INVESTOR_FEE,
  OWNER_FEE,
  UNAUTH,
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

  describe("Deployment", function () {
    it("Should deploy factory with correct parameters", async function () {
      expect(await factory.vscToken()).to.equal(await vscToken.getAddress());
      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.ownerWallet()).to.equal(ownerWallet.address);
    });

    // Plan 2F.5 (M4): the factory is Ownable2Step; the owner surface (fee
    // wallet, registry, rules) and DEFAULT_ADMIN_ROLE move only on accept.
    it("Should move ownership and the role admin in two steps", async function () {
      const DEFAULT_ADMIN = await factory.DEFAULT_ADMIN_ROLE();
      const next = signers[7];
      await factory.transferOwnership(next.address);
      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.pendingOwner()).to.equal(next.address);
      await expect(
        factory.connect(investor).acceptOwnership(),
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      await factory.connect(next).acceptOwnership();
      expect(await factory.owner()).to.equal(next.address);
      expect(await factory.hasRole(DEFAULT_ADMIN, next.address)).to.be.true;
      expect(await factory.hasRole(DEFAULT_ADMIN, owner.address)).to.be.false;
      await expect(
        factory.setOwnerWallet(payer.address),
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await factory.connect(next).setOwnerWallet(payer.address);
      expect(await factory.ownerWallet()).to.equal(payer.address);
      // ADMIN_ROLE is operational and stays where it was granted.
      await factory.registerInvestor(investor.address, investorWallet.address);
      expect(await factory.isInvestor(investor.address)).to.be.true;
    });

    it("Should have correct fee rates", async function () {
      expect(await factory.INVESTOR_FEE_RATE()).to.equal(300); // 3%
      expect(await factory.OWNER_FEE_RATE()).to.equal(200); // 2%
      expect(await factory.TOTAL_FEE_RATE()).to.equal(500); // 5%
    });
  });

  describe("Investor Registration", function () {
    it("Should register investor successfully", async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);

      const profile = await factory.getInvestorProfile(investor.address);
      expect(profile.investorAddress).to.equal(investor.address);
      expect(profile.walletAddress).to.equal(investorWallet.address);
      expect(profile.isActive).to.be.true;
      expect(profile.totalEscrowsCreated).to.equal(0);
    });

    it("Should check if address is investor", async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      expect(await factory.isInvestor(investor.address)).to.be.true;
      expect(await factory.isInvestor(payer.address)).to.be.false;
    });

    it("Should not allow duplicate registration", async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await expect(
        factory.registerInvestor(investor.address, investorWallet.address),
      ).to.be.revertedWith("Already registered");
    });

    it("Should deactivate investor", async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
      await factory.deactivateInvestor(investor.address);

      expect(await factory.isInvestor(investor.address)).to.be.false;
    });
  });

  describe("Escrow Wallet Creation", function () {
    beforeEach(async function () {
      await factory.registerInvestor(investor.address, investorWallet.address);
    });

    it("Should create escrow wallet successfully", async function () {
      const tx = await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);

      const receipt = await tx.wait();
      const event = receipt.logs.find((log) => {
        try {
          return factory.interface.parseLog(log).name === "EscrowWalletCreated";
        } catch (e) {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
    });

    it("Should assign unique payment ID", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);

      const walletAddress = await factory.getWalletAddress(1);
      expect(walletAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("Should deploy wallet with correct parameters", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);

      const walletAddress = await factory.getWalletAddress(1);
      const MultiSigEscrowWallet = await ethers.getContractFactory(
        "MultiSigEscrowWallet",
      );
      const wallet = MultiSigEscrowWallet.attach(walletAddress);

      expect(await wallet.paymentId()).to.equal(1);
      expect(await wallet.payer()).to.equal(payer.address);
      expect(await wallet.payee()).to.equal(payee.address);
      expect(await wallet.investor()).to.equal(investor.address);
      expect(await wallet.amount()).to.equal(PAYMENT_AMOUNT);
      expect(await wallet.investorFee()).to.equal(INVESTOR_FEE);
      expect(await wallet.ownerFee()).to.equal(OWNER_FEE);
    });
    it("Should only allow registered investors to create wallets", async function () {
      await expect(
        factory
          .connect(payer)
          .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT),
      ).to.be.revertedWithCustomError(factory, UNAUTH);
    });

    it("Should update investor statistics", async function () {
      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, PAYMENT_AMOUNT);

      const profile = await factory.getInvestorProfile(investor.address);
      expect(profile.totalEscrowsCreated).to.equal(1);
    });

    it("Should reject payee without KYC/AML", async function () {
      const unverifiedPayee = signers[10];

      await expect(
        factory
          .connect(investor)
          .createEscrowWallet(
            payer.address,
            unverifiedPayee.address,
            PAYMENT_AMOUNT,
          ),
      ).to.be.revertedWith("Payee must have valid KYC/AML (OnchainID)");
    });

    it("Should reject payer without KYC/AML (known payer)", async function () {
      const unverifiedPayer = signers[11];

      await expect(
        factory
          .connect(investor)
          .createEscrowWallet(
            unverifiedPayer.address,
            payee.address,
            PAYMENT_AMOUNT,
          ),
      ).to.be.revertedWith("Payer must have valid KYC/AML (OnchainID)");
    });

    it("Should allow unknown payer (address(0)) for marketplace", async function () {
      const tx = await factory
        .connect(investor)
        .createEscrowWallet(ethers.ZeroAddress, payee.address, PAYMENT_AMOUNT);

      const receipt = await tx.wait();
      const event = receipt.logs.find((log) => {
        try {
          return factory.interface.parseLog(log).name === "EscrowWalletCreated";
        } catch (e) {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
    });
  });
});
