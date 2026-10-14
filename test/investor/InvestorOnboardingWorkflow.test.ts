import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MultiSigWallet,
  InvestorRequestManager,
  InvestorTypeRegistry,
  Token,
} from "../../typechain-types";
import {
  RETAIL_LOCK,
  idOf,
  deployOnboarding,
} from "../helpers/onboardingFixture";

describe("Investor Onboarding System", function () {
  let investorRequestManager: InvestorRequestManager;
  let investorTypeRegistry: InvestorTypeRegistry;
  let token: Token;
  let owner: SignerWithAddress;
  let bank: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    ({
      investorRequestManager,
      investorTypeRegistry,
      token,
      owner,
      bank,
      user,
    } = await deployOnboarding());
  });

  describe("Complete Workflow", function () {
    it("Should complete full investor onboarding workflow", async function () {
      // Step 1: User requests Retail investor status
      await investorRequestManager.connect(user).requestInvestorStatus(1);

      let request = await investorRequestManager.getRequest(user.address);
      expect(request.status).to.equal(1); // Pending

      // Step 2: Bank creates multi-sig wallet
      await investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);

      request = await investorRequestManager.getRequest(user.address);
      expect(request.status).to.equal(2); // WalletCreated

      // Step 3: Lock tokens (the wallet is already trusted)
      const walletAddress = request.multiSigWallet;

      await token.connect(user).approve(walletAddress, RETAIL_LOCK);

      const MultiSigWalletFactory =
        await ethers.getContractFactory("MultiSigWallet");
      const wallet = MultiSigWalletFactory.attach(
        walletAddress,
      ) as unknown as MultiSigWallet;
      await wallet.connect(user).lockTokens(RETAIL_LOCK);

      // Step 4: User confirms tokens locked
      await investorRequestManager.connect(user).confirmTokensLocked();

      request = await investorRequestManager.getRequest(user.address);
      expect(request.status).to.equal(3); // TokensLocked

      // Step 5: Bank approves request
      await investorRequestManager.connect(bank).approveRequest(user.address);

      request = await investorRequestManager.getRequest(user.address);
      expect(request.status).to.equal(4); // Approved

      // Verify investor type
      const investorType = await investorTypeRegistry.getInvestorType(
        user.address,
      );
      expect(investorType).to.equal(1); // Retail

      // Verify tokens still locked
      expect(await wallet.lockedAmount()).to.equal(RETAIL_LOCK);
    });

    it("Should complete downgrade workflow with 2-of-2 signatures", async function () {
      // Complete onboarding first
      await investorRequestManager.connect(user).requestInvestorStatus(1);
      await investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);

      const request = await investorRequestManager.getRequest(user.address);
      const walletAddress = request.multiSigWallet;

      await token.connect(user).approve(walletAddress, RETAIL_LOCK);
      const MultiSigWalletFactory =
        await ethers.getContractFactory("MultiSigWallet");
      const wallet = MultiSigWalletFactory.attach(
        walletAddress,
      ) as unknown as MultiSigWallet;
      await wallet.connect(user).lockTokens(RETAIL_LOCK);

      await investorRequestManager.connect(user).confirmTokensLocked();
      await investorRequestManager.connect(bank).approveRequest(user.address);

      // Now downgrade
      const userBalanceBefore = await token.balanceOf(user.address);

      // Create unlock proposal
      const proposalId = await idOf(
        wallet,
        wallet
          .connect(user)
          .proposeUnlock(RETAIL_LOCK, user.address, "Downgrade to normal user"),
      );

      // User signs
      await wallet.connect(user).signUnlock(proposalId);

      // Bank signs (auto-executes)
      await wallet.connect(bank).signUnlock(proposalId);

      // Verify tokens unlocked
      expect(await wallet.lockedAmount()).to.equal(0);
      const userBalanceAfter = await token.balanceOf(user.address);
      expect(userBalanceAfter).to.equal(userBalanceBefore + RETAIL_LOCK);

      // Downgrade investor type (owner is compliance officer)
      await investorTypeRegistry
        .connect(owner)
        .downgradeInvestorType(user.address, 0);
      expect(await investorTypeRegistry.getInvestorType(user.address)).to.equal(
        0,
      ); // Normal
    });
  });
});
