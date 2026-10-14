import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MultiSigWallet,
  InvestorRequestManager,
  InvestorTypeRegistry,
  IdentityRegistry,
  Token,
  ComplianceRules,
  OnchainID,
} from "../../typechain-types";
import {
  RETAIL_LOCK,
  ACCREDITED_LOCK,
  idOf,
  deployOnboarding,
} from "../helpers/onboardingFixture";

describe("Investor Onboarding System", function () {
  let multiSigWallet: MultiSigWallet;
  let investorRequestManager: InvestorRequestManager;
  let investorTypeRegistry: InvestorTypeRegistry;
  let identityRegistry: IdentityRegistry;
  let token: Token;
  let rules: ComplianceRules;
  let owner: SignerWithAddress;
  let bank: SignerWithAddress;
  let user: SignerWithAddress;
  let otherUser: SignerWithAddress;

  beforeEach(async function () {
    ({
      investorRequestManager,
      investorTypeRegistry,
      identityRegistry,
      token,
      rules,
      owner,
      bank,
      user,
      otherUser,
    } = await deployOnboarding());
  });

  describe("MultiSigWallet", function () {
    beforeEach(async function () {
      const MultiSigWalletFactory =
        await ethers.getContractFactory("MultiSigWallet");
      multiSigWallet = await MultiSigWalletFactory.deploy(
        bank.address,
        user.address,
        await token.getAddress(),
      );
      await multiSigWallet.waitForDeployment();

      // A wallet deployed outside the manager: the owner trusts it.
      await rules.addTrustedContract(
        await token.getAddress(),
        await multiSigWallet.getAddress(),
      );
    });

    it("Should deploy with correct parameters", async function () {
      expect(await multiSigWallet.bank()).to.equal(bank.address);
      expect(await multiSigWallet.user()).to.equal(user.address);
      expect(await multiSigWallet.token()).to.equal(await token.getAddress());
      expect(await multiSigWallet.lockedAmount()).to.equal(0);
    });

    it("Should allow user to lock tokens", async function () {
      const lockAmount = ethers.parseEther("5000"); // Under 8000 Yuan limit

      await token
        .connect(user)
        .approve(await multiSigWallet.getAddress(), lockAmount);
      await multiSigWallet.connect(user).lockTokens(lockAmount);

      expect(await multiSigWallet.lockedAmount()).to.equal(lockAmount);
      expect(await token.balanceOf(await multiSigWallet.getAddress())).to.equal(
        lockAmount,
      );
    });

    it("Should not allow non-user to lock tokens", async function () {
      // Refused on the sender before any token movement.
      await expect(
        multiSigWallet.connect(bank).lockTokens(RETAIL_LOCK),
      ).to.be.revertedWith("Only user can lock tokens");
    });

    it("Should create unlock proposal", async function () {
      const lockAmount = ethers.parseEther("5000"); // Under 8000 Yuan limit

      await token
        .connect(user)
        .approve(await multiSigWallet.getAddress(), lockAmount);
      await multiSigWallet.connect(user).lockTokens(lockAmount);

      await expect(
        multiSigWallet
          .connect(user)
          .proposeUnlock(lockAmount, user.address, "Test unlock"),
      ).to.emit(multiSigWallet, "UnlockProposalCreated");
    });

    it("Should require both signatures to unlock", async function () {
      const lockAmount = RETAIL_LOCK;

      await token
        .connect(user)
        .approve(await multiSigWallet.getAddress(), lockAmount);
      await multiSigWallet.connect(user).lockTokens(lockAmount);

      const proposalId = await idOf(
        multiSigWallet,
        multiSigWallet
          .connect(user)
          .proposeUnlock(lockAmount, user.address, "Test unlock"),
      );

      // User signs
      await multiSigWallet.connect(user).signUnlock(proposalId);

      // Check not yet unlocked
      expect(await multiSigWallet.lockedAmount()).to.equal(lockAmount);

      // Bank signs (should auto-execute)
      await multiSigWallet.connect(bank).signUnlock(proposalId);

      // Check unlocked
      expect(await multiSigWallet.lockedAmount()).to.equal(0);
      expect(await token.balanceOf(user.address)).to.be.gt(0);
    });
  });

  describe("InvestorRequestManager", function () {
    it("Should create investor request", async function () {
      await investorRequestManager.connect(user).requestInvestorStatus(1); // Retail

      const request = await investorRequestManager.getRequest(user.address);
      expect(request.requestedType).to.equal(1); // Retail
      expect(request.requiredLockAmount).to.equal(RETAIL_LOCK);
      expect(request.status).to.equal(1); // Pending
    });

    it("Should not allow request without KYC/AML", async function () {
      // The registry now requires a live claim on its configured topics
      // (plan Task 1R.2): a wallet that is only registered, with no
      // claim, is not verified, so requestInvestorStatus genuinely
      // reverts instead of the previous permissive pass.

      // Register user without KYC/AML
      const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
      const newOnchainID = await OnchainIDFactory.deploy(otherUser.address);
      await newOnchainID.waitForDeployment();

      await identityRegistry.registerIdentity(
        otherUser.address,
        await newOnchainID.getAddress(),
        840,
      );

      // Registered but unattested: request must be rejected.
      await expect(
        investorRequestManager.connect(otherUser).requestInvestorStatus(1),
      ).to.be.revertedWith("KYC/AML verification required");
      expect(await investorRequestManager.hasActiveRequest(otherUser.address))
        .to.be.false;
    });

    it("Should create multi-sig wallet for user", async function () {
      await investorRequestManager.connect(user).requestInvestorStatus(1);

      await investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);

      const request = await investorRequestManager.getRequest(user.address);
      expect(request.multiSigWallet).to.not.equal(ethers.ZeroAddress);
      expect(request.status).to.equal(2); // WalletCreated
    });

    it("Should confirm tokens locked", async function () {
      await investorRequestManager.connect(user).requestInvestorStatus(1);
      await investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);

      const request = await investorRequestManager.getRequest(user.address);
      const walletAddress = request.multiSigWallet;

      // Lock tokens
      await token.connect(user).approve(walletAddress, RETAIL_LOCK);
      const MultiSigWalletFactory =
        await ethers.getContractFactory("MultiSigWallet");
      const wallet = MultiSigWalletFactory.attach(
        walletAddress,
      ) as unknown as MultiSigWallet;
      await wallet.connect(user).lockTokens(RETAIL_LOCK);

      // Confirm locked
      await investorRequestManager.connect(user).confirmTokensLocked();

      const updatedRequest = await investorRequestManager.getRequest(
        user.address,
      );
      expect(updatedRequest.status).to.equal(3); // TokensLocked
    });

    it("Should approve investor request and assign type", async function () {
      await investorRequestManager.connect(user).requestInvestorStatus(2); // Accredited
      await investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);

      const request = await investorRequestManager.getRequest(user.address);
      const walletAddress = request.multiSigWallet;

      // Lock tokens
      await token.connect(user).approve(walletAddress, ACCREDITED_LOCK);
      const MultiSigWalletFactory =
        await ethers.getContractFactory("MultiSigWallet");
      const wallet = MultiSigWalletFactory.attach(
        walletAddress,
      ) as unknown as MultiSigWallet;
      await wallet.connect(user).lockTokens(ACCREDITED_LOCK);

      await investorRequestManager.connect(user).confirmTokensLocked();

      // Approve request
      await investorRequestManager.connect(bank).approveRequest(user.address);

      const updatedRequest = await investorRequestManager.getRequest(
        user.address,
      );
      expect(updatedRequest.status).to.equal(4); // Approved

      // Check investor type assigned
      const investorType = await investorTypeRegistry.getInvestorType(
        user.address,
      );
      expect(investorType).to.equal(2); // Accredited
    });
  });
});
