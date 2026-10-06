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
  ClaimIssuer,
} from "../../typechain-types";
import {
  attest,
  configureKyc,
  KYC_TOPIC as REGISTRY_KYC_TOPIC,
  AML_TOPIC as REGISTRY_AML_TOPIC,
  issueSigned,
} from "../helpers/kyc";
import { addRegistrar } from "../helpers/registrars";

describe("Investor Onboarding System", function () {
  let multiSigWallet: MultiSigWallet;
  let investorRequestManager: InvestorRequestManager;
  let investorTypeRegistry: InvestorTypeRegistry;
  let identityRegistry: IdentityRegistry;
  let token: Token;
  let rules: ComplianceRules;
  let onchainID: OnchainID;
  let kycIssuer: ClaimIssuer;
  let amlIssuer: ClaimIssuer;

  let owner: SignerWithAddress;
  let bank: SignerWithAddress;
  let user: SignerWithAddress;
  let otherUser: SignerWithAddress;

  const RETAIL_LOCK = ethers.parseEther("10000"); // Matches InvestorRequestManager default
  const ACCREDITED_LOCK = ethers.parseEther("100000"); // Matches InvestorRequestManager default
  const INSTITUTIONAL_LOCK = ethers.parseEther("1000000"); // Matches InvestorRequestManager default

  beforeEach(async function () {
    [owner, bank, user, otherUser] = await ethers.getSigners();

    // Deploy OnchainID system
    const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
    onchainID = await OnchainIDFactory.deploy(user.address);
    await onchainID.waitForDeployment();

    // Deploy ClaimIssuers
    const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
    kycIssuer = await ClaimIssuerFactory.deploy(
      owner.address,
      "KYC Issuer",
      "Know Your Customer verification service",
    );
    await kycIssuer.waitForDeployment();

    amlIssuer = await ClaimIssuerFactory.deploy(
      owner.address,
      "AML Issuer",
      "Anti-Money Laundering verification service",
    );
    await amlIssuer.waitForDeployment();

    // Deploy IdentityRegistry
    const IdentityRegistryFactory =
      await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistryFactory.deploy();
    await identityRegistry.waitForDeployment();
    // Registration alone no longer verifies (plan Task 1R.2): require
    // both the KYC and AML topics this fixture already issues claims for.
    await configureKyc(
      identityRegistry,
      await kycIssuer.getAddress(),
      await amlIssuer.getAddress(),
    );

    // Deploy InvestorTypeRegistry
    const InvestorTypeRegistryFactory = await ethers.getContractFactory(
      "InvestorTypeRegistry",
    );
    investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
    await investorTypeRegistry.waitForDeployment();

    // Real ComplianceRules (Task 4.3): the MultiSigWallet holds tokens as a
    // contract trusted on this token, registered by the manager at creation.
    rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [], []);
    await rules.waitForDeployment();

    // Deploy Token
    const TokenFactory = await ethers.getContractFactory("Token");
    token = await TokenFactory.deploy(
      "Test Token",
      "TEST",
      await identityRegistry.getAddress(),
      await rules.getAddress(),
    );
    await token.waitForDeployment();
    await rules.setTokenIdentityRegistry(
      await token.getAddress(),
      await identityRegistry.getAddress(),
    );

    // Set InvestorTypeRegistry on token
    await token.setInvestorTypeRegistry(
      await investorTypeRegistry.getAddress(),
    );

    // Register user identity
    await identityRegistry.addAgent(owner.address);
    await identityRegistry.registerIdentity(
      user.address,
      await onchainID.getAddress(),
      840, // US
    );

    // Issue KYC and AML claims
    await issueSigned(
      kycIssuer,
      owner,
      await onchainID.getAddress(),
      1, // KYC topic
      ethers.toUtf8Bytes("KYC verified"),
      "",
      0,
    );

    await issueSigned(
      amlIssuer,
      owner,
      await onchainID.getAddress(),
      2, // AML topic
      ethers.toUtf8Bytes("AML verified"),
      "",
      0,
    );
    await attest(
      kycIssuer,
      owner,
      await onchainID.getAddress(),
      REGISTRY_KYC_TOPIC,
    );
    await attest(
      amlIssuer,
      owner,
      await onchainID.getAddress(),
      REGISTRY_AML_TOPIC,
    );

    // Deploy InvestorRequestManager
    const InvestorRequestManagerFactory = await ethers.getContractFactory(
      "InvestorRequestManager",
    );
    investorRequestManager = await InvestorRequestManagerFactory.deploy(
      bank.address,
      await token.getAddress(),
      await investorTypeRegistry.getAddress(),
      await identityRegistry.getAddress(),
    );
    await investorRequestManager.waitForDeployment();
    // The manager trusts each MultiSigWallet it creates on this token.
    await addRegistrar(rules, token, investorRequestManager, "MultiSigWallet");

    // Authorize InvestorRequestManager as compliance officer
    await investorTypeRegistry.setComplianceOfficer(
      await investorRequestManager.getAddress(),
      true,
    );

    // Update investor type configs to allow higher transfer amounts for testing
    await investorTypeRegistry.updateInvestorTypeConfig(0, {
      // Normal
      maxTransferAmount: ethers.parseEther("1000000"),
      maxHoldingAmount: ethers.parseEther("5000000"),
      requiredWhitelistTier: 1,
      transferCooldownMinutes: 60,
      largeTransferThreshold: ethers.parseEther("100000"),
      enhancedLogging: false,
      enhancedPrivacy: false,
    });

    await investorTypeRegistry.updateInvestorTypeConfig(1, {
      // Retail
      maxTransferAmount: ethers.parseEther("1000000"),
      maxHoldingAmount: ethers.parseEther("5000000"),
      requiredWhitelistTier: 2,
      transferCooldownMinutes: 60,
      largeTransferThreshold: ethers.parseEther("100000"),
      enhancedLogging: false,
      enhancedPrivacy: false,
    });

    await investorTypeRegistry.updateInvestorTypeConfig(2, {
      // Accredited
      maxTransferAmount: ethers.parseEther("1000000"),
      maxHoldingAmount: ethers.parseEther("5000000"),
      requiredWhitelistTier: 3,
      transferCooldownMinutes: 30,
      largeTransferThreshold: ethers.parseEther("100000"),
      enhancedLogging: true,
      enhancedPrivacy: true,
    });

    // Mint tokens to user
    await token.addAgent(owner.address);
    await token.mint(user.address, ethers.parseEther("2000000"));
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
      const lockAmount = ethers.parseEther("10000");

      await token
        .connect(user)
        .approve(await multiSigWallet.getAddress(), lockAmount);
      await expect(
        multiSigWallet.connect(bank).lockTokens(lockAmount),
      ).to.be.revertedWith("Only user can lock tokens");
    });

    it("Should create unlock proposal", async function () {
      const lockAmount = ethers.parseEther("5000"); // Under 8000 Yuan limit

      await token
        .connect(user)
        .approve(await multiSigWallet.getAddress(), lockAmount);
      await multiSigWallet.connect(user).lockTokens(lockAmount);

      const tx = await multiSigWallet
        .connect(user)
        .proposeUnlock(lockAmount, user.address, "Test unlock");
      const receipt = await tx.wait();

      // Check event was emitted
      expect(receipt).to.not.be.null;
    });

    it("Should require both signatures to unlock", async function () {
      const lockAmount = RETAIL_LOCK;

      await token
        .connect(user)
        .approve(await multiSigWallet.getAddress(), lockAmount);
      await multiSigWallet.connect(user).lockTokens(lockAmount);

      const tx = await multiSigWallet
        .connect(user)
        .proposeUnlock(lockAmount, user.address, "Test unlock");
      const receipt = await tx.wait();

      // Get proposal ID from event
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            multiSigWallet.interface.parseLog(log)?.name ===
            "UnlockProposalCreated"
          );
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
      const parsedEvent = multiSigWallet.interface.parseLog(event!);
      const proposalId = parsedEvent?.args[0];

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
      const tx = await wallet
        .connect(user)
        .proposeUnlock(RETAIL_LOCK, user.address, "Downgrade to normal user");
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            wallet.interface.parseLog(log)?.name === "UnlockProposalCreated"
          );
        } catch {
          return false;
        }
      });

      const parsedEvent = wallet.interface.parseLog(event!);
      const proposalId = parsedEvent?.args[0];

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

  // Plan v2 Task 4.3 (D13 b): custody is the on-chain 2-of-2 wallet.
  describe("Custody: tokens move into the MultiSigWallet (Task 4.3)", function () {
    /** Request, wallet by the bank, lock by the user; returns the wallet. */
    async function lockedWallet(amount = RETAIL_LOCK) {
      await investorRequestManager.connect(user).requestInvestorStatus(1);
      await investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);
      const addr = (await investorRequestManager.requests(user.address))
        .multiSigWallet;
      const wallet = (await ethers.getContractAt(
        "MultiSigWallet",
        addr,
      )) as unknown as MultiSigWallet;
      await token.connect(user).approve(addr, amount);
      await wallet.connect(user).lockTokens(amount);
      return wallet;
    }

    /** Proposal id from the proposeUnlock receipt. */
    async function proposalId(wallet: MultiSigWallet, tx: any) {
      const receipt = await (await tx).wait();
      for (const log of receipt.logs) {
        const parsed = wallet.interface.parseLog(log);
        if (parsed?.name === "UnlockProposalCreated") return parsed.args[0];
      }
      throw new Error("no UnlockProposalCreated");
    }

    /** otherUser becomes a verified identity (a lawful recipient). */
    async function verifyOtherUser() {
      const id = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(otherUser.address);
      await identityRegistry.registerIdentity(
        otherUser.address,
        await id.getAddress(),
        840,
      );
      for (const issuer of [kycIssuer, amlIssuer]) {
        const topic =
          issuer === kycIssuer ? REGISTRY_KYC_TOPIC : REGISTRY_AML_TOPIC;
        await attest(issuer, owner, await id.getAddress(), topic);
      }
    }

    it("the registrar trusts the wallet on the token at creation", async function () {
      await investorRequestManager.connect(user).requestInvestorStatus(1);
      const tokenAddr = await token.getAddress();
      const tx = investorRequestManager
        .connect(bank)
        .createMultiSigWallet(user.address);
      await expect(tx).to.emit(rules, "TrustedContractAdded");
      const w = (await investorRequestManager.requests(user.address))
        .multiSigWallet;
      expect(
        await rules["isTrustedContract(address,address)"](tokenAddr, w),
      ).to.equal(true);
      expect(await rules.isTrustedOnAnyToken(w)).to.equal(true);
      // No identity: trust, not a registry entry, lets it hold tokens.
      expect(await identityRegistry.identity(w)).to.equal(ethers.ZeroAddress);
    });

    it("a manager that is not a registrar cannot create a wallet", async function () {
      await rules.setTrustedRegistrar(
        await token.getAddress(),
        await investorRequestManager.getAddress(),
        ethers.ZeroHash,
      );
      await investorRequestManager.connect(user).requestInvestorStatus(1);
      await expect(
        investorRequestManager.connect(bank).createMultiSigWallet(user.address),
      ).to.be.revertedWith("ComplianceRules: not owner or registrar");
    });

    it("the lock moves tokens from the user into the wallet", async function () {
      const before = await token.balanceOf(user.address);
      const wallet = await lockedWallet();
      const w = await wallet.getAddress();
      expect(await token.balanceOf(w)).to.equal(RETAIL_LOCK);
      expect(await token.balanceOf(user.address)).to.equal(
        before - RETAIL_LOCK,
      );
      expect(await token.frozenTokens(user.address)).to.equal(0);
      await investorRequestManager.connect(user).confirmTokensLocked();
      expect(
        (await investorRequestManager.requests(user.address)).status,
      ).to.equal(3); // TokensLocked
    });

    it("the bank alone cannot unlock", async function () {
      const wallet = await lockedWallet();
      const w = await wallet.getAddress();
      const id = await proposalId(
        wallet,
        wallet
          .connect(bank)
          .proposeUnlock(RETAIL_LOCK, bank.address, "bank alone"),
      );
      await wallet.connect(bank).signUnlock(id);
      await expect(wallet.connect(bank).signUnlock(id)).to.be.revertedWith(
        "Bank already signed",
      );
      expect(await token.balanceOf(w)).to.equal(RETAIL_LOCK);
      expect(await wallet.lockedAmount()).to.equal(RETAIL_LOCK);
      expect(await wallet.isFullySigned(id)).to.equal(false);
      await expect(wallet.connect(otherUser).signUnlock(id)).to.be.revertedWith(
        "Not authorized",
      );
    });

    it("both signatures release to a verified recipient", async function () {
      await verifyOtherUser();
      const wallet = await lockedWallet();
      const id = await proposalId(
        wallet,
        wallet
          .connect(user)
          .proposeUnlock(RETAIL_LOCK, otherUser.address, "release"),
      );
      await wallet.connect(user).signUnlock(id);
      await expect(wallet.connect(bank).signUnlock(id))
        .to.emit(wallet, "TokensUnlocked")
        .withArgs(id, otherUser.address, RETAIL_LOCK);
      expect(await token.balanceOf(otherUser.address)).to.equal(RETAIL_LOCK);
      expect(await token.balanceOf(await wallet.getAddress())).to.equal(0);
      expect(await wallet.lockedAmount()).to.equal(0);
    });

    it("an unverified recipient is refused by the token's gate", async function () {
      const wallet = await lockedWallet();
      const id = await proposalId(
        wallet,
        wallet
          .connect(user)
          .proposeUnlock(RETAIL_LOCK, otherUser.address, "to a stranger"),
      );
      await wallet.connect(user).signUnlock(id);
      expect(
        await token.canTransfer(
          await wallet.getAddress(),
          otherUser.address,
          RETAIL_LOCK,
        ),
      ).to.equal(false);
      // Trusted path: ComplianceRules checks the human counterparty.
      await expect(wallet.connect(bank).signUnlock(id)).to.be.revertedWith(
        "Compliance check failed",
      );
      expect(await token.balanceOf(await wallet.getAddress())).to.equal(
        RETAIL_LOCK,
      );
      expect(await wallet.lockedAmount()).to.equal(RETAIL_LOCK);
    });

    it("fees routed to the wallet are paid out before the lock", async function () {
      const wallet = await lockedWallet();
      const w = await wallet.getAddress();
      const fee = ethers.parseEther("30");
      // As an escrow release pays the fee wallet: a transfer in.
      await token.connect(user).transfer(w, fee);
      expect(await token.balanceOf(w)).to.equal(RETAIL_LOCK + fee);
      // The fee alone: the lock stays whole.
      let id = await proposalId(
        wallet,
        wallet.connect(user).proposeUnlock(fee, user.address, "fees"),
      );
      await wallet.connect(user).signUnlock(id);
      await wallet.connect(bank).signUnlock(id);
      expect(await wallet.lockedAmount()).to.equal(RETAIL_LOCK);
      // More than the wallet holds is refused at proposal.
      await expect(
        wallet
          .connect(user)
          .proposeUnlock(RETAIL_LOCK + 1n, user.address, "too much"),
      ).to.be.revertedWith("Invalid amount");
      // A second fee plus part of the lock: the lock shrinks by the rest.
      await token.connect(user).transfer(w, fee);
      const part = ethers.parseEther("1000");
      id = await proposalId(
        wallet,
        wallet.connect(bank).proposeUnlock(fee + part, user.address, "mix"),
      );
      await wallet.connect(bank).signUnlock(id);
      await wallet.connect(user).signUnlock(id);
      expect(await wallet.lockedAmount()).to.equal(RETAIL_LOCK - part);
      expect(await token.balanceOf(w)).to.equal(RETAIL_LOCK - part);
    });

    it("a lock reduced below the holdings by an agent burn still pays out", async function () {
      const wallet = await lockedWallet();
      const w = await wallet.getAddress();
      const burnt = ethers.parseEther("4000");
      await token.burn(w, burnt);
      const left = RETAIL_LOCK - burnt;
      const id = await proposalId(
        wallet,
        wallet.connect(user).proposeUnlock(left, user.address, "rest"),
      );
      await wallet.connect(user).signUnlock(id);
      await wallet.connect(bank).signUnlock(id);
      expect(await wallet.lockedAmount()).to.equal(burnt);
      expect(await token.balanceOf(w)).to.equal(0);
    });
  });
});
