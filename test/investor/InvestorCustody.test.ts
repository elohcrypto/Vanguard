import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MultiSigWallet,
  InvestorRequestManager,
  IdentityRegistry,
  Token,
  ComplianceRules,
  OnchainID,
  ClaimIssuer,
} from "../../typechain-types";
import {
  attest,
  KYC_TOPIC as REGISTRY_KYC_TOPIC,
  AML_TOPIC as REGISTRY_AML_TOPIC,
} from "../helpers/kyc";
import {
  RETAIL_LOCK,
  idOf,
  deployOnboarding,
} from "../helpers/onboardingFixture";

describe("Investor Onboarding System", function () {
  let investorRequestManager: InvestorRequestManager;
  let identityRegistry: IdentityRegistry;
  let token: Token;
  let rules: ComplianceRules;
  let kycIssuer: ClaimIssuer;
  let amlIssuer: ClaimIssuer;
  let owner: SignerWithAddress;
  let bank: SignerWithAddress;
  let user: SignerWithAddress;
  let otherUser: SignerWithAddress;

  beforeEach(async function () {
    ({
      investorRequestManager,
      identityRegistry,
      token,
      rules,
      kycIssuer,
      amlIssuer,
      owner,
      bank,
      user,
      otherUser,
    } = await deployOnboarding());
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
      const id = await idOf(
        wallet,
        wallet
          .connect(bank)
          .proposeUnlock(RETAIL_LOCK, user.address, "bank alone"),
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
      const id = await idOf(
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

    it("the token's gate still decides at execution: claims revoked after the proposal", async function () {
      await verifyOtherUser();
      const wallet = await lockedWallet();
      const id = await idOf(
        wallet,
        wallet
          .connect(user)
          .proposeUnlock(RETAIL_LOCK, otherUser.address, "release"),
      );
      await wallet.connect(user).signUnlock(id);
      // Both claims revoked before the second signature: the recipient is
      // no longer verified, so the trusted-path payout is refused.
      const otherId = await identityRegistry.identity(otherUser.address);
      for (const [issuer, topic] of [
        [kycIssuer, REGISTRY_KYC_TOPIC],
        [amlIssuer, REGISTRY_AML_TOPIC],
      ] as const)
        await issuer.revokeClaim(await issuer.latestClaimId(otherId, topic));
      expect(await identityRegistry.isVerified(otherUser.address)).to.equal(
        false,
      );
      await expect(wallet.connect(bank).signUnlock(id)).to.be.revertedWith(
        "Compliance check failed",
      );
      expect(await token.balanceOf(await wallet.getAddress())).to.equal(
        RETAIL_LOCK,
      );
    });

    it("an unverified recipient is refused at the proposal (Task 4.16, A1 L4)", async function () {
      const wallet = await lockedWallet();
      // The token's gate would refuse the payout (trusted path: the human
      // counterparty is checked); the wallet refuses the proposal first.
      expect(
        await token.canTransfer(
          await wallet.getAddress(),
          otherUser.address,
          RETAIL_LOCK,
        ),
      ).to.equal(false);
      await expect(
        wallet
          .connect(user)
          .proposeUnlock(RETAIL_LOCK, otherUser.address, "to a stranger"),
      ).to.be.revertedWithCustomError(wallet, "RecipientNotVerified");
      expect(await token.balanceOf(await wallet.getAddress())).to.equal(
        RETAIL_LOCK,
      );
      expect(await wallet.lockedAmount()).to.equal(RETAIL_LOCK);
    });

    it("fees routed to the wallet are paid out before the lock", async function () {
      const wallet = await lockedWallet();
      const w = await wallet.getAddress();
      const fee = ethers.parseEther("30");
      // As an escrow release pays the fee wallet: a transfer in, after the
      // user's lock transfer cooldown (Task 4.10, Retail: 60 minutes).
      await ethers.provider.send("evm_increaseTime", [3600]);
      await token.connect(user).transfer(w, fee);
      expect(await token.balanceOf(w)).to.equal(RETAIL_LOCK + fee);
      // The fee alone: the lock stays whole.
      let id = await idOf(
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
      await ethers.provider.send("evm_increaseTime", [3600]);
      await token.connect(user).transfer(w, fee);
      const part = ethers.parseEther("1000");
      id = await idOf(
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
      const burnt = ethers.parseEther("500");
      await token.burn(w, burnt);
      const left = RETAIL_LOCK - burnt;
      const id = await idOf(
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
