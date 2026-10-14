import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ClaimIssuer, OnchainID } from "../typechain-types";
import { issueSigned } from "./helpers/kyc";

describe("ClaimIssuer", function () {
  let claimIssuer: ClaimIssuer;
  let onchainID: OnchainID;
  let owner: SignerWithAddress;
  let identity: SignerWithAddress;
  let claimSigner: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  // Key purposes
  const MANAGEMENT_KEY = 1;
  const CLAIM_SIGNER_KEY = 3;

  // Key types
  const ECDSA_TYPE = 1;

  // Claim topics
  const IDENTITY_TOPIC = 1;
  const KYC_TOPIC = 6;
  const AML_TOPIC = 7;
  const INVESTOR_TYPE_TOPIC = 8;

  // Signature schemes
  const ECDSA_SCHEME = 1;

  beforeEach(async function () {
    [owner, identity, claimSigner, unauthorized] = await ethers.getSigners();

    // Deploy ClaimIssuer
    const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
    claimIssuer = await ClaimIssuerFactory.deploy(
      owner.address,
      "Test KYC Provider",
      "A trusted KYC verification service",
    );
    await claimIssuer.waitForDeployment();

    // Deploy OnchainID for testing
    const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
    onchainID = await OnchainIDFactory.deploy(identity.address);
    await onchainID.waitForDeployment();

    // Add claim signer key to ClaimIssuer
    const claimSignerKey = ethers.keccak256(
      ethers.solidityPacked(["address"], [claimSigner.address]),
    );
    await claimIssuer
      .connect(owner)
      .addIssuerKey(claimSignerKey, CLAIM_SIGNER_KEY, ECDSA_TYPE);
  });

  describe("Trusted Issuer Management", function () {
    describe("addTrustedIssuer", function () {
      it("Should allow owner to add trusted issuer", async function () {
        const topics = [KYC_TOPIC, AML_TOPIC];
        await expect(
          claimIssuer.connect(owner).addTrustedIssuer(identity.address, topics),
        )
          .to.emit(claimIssuer, "TrustedIssuerAdded")
          .withArgs(identity.address, topics);

        const trustedTopics = await claimIssuer.trustedIssuers(
          identity.address,
          0,
        );
        expect(trustedTopics).to.equal(KYC_TOPIC);
      });

      it("Should reject adding zero address as trusted issuer", async function () {
        await expect(
          claimIssuer
            .connect(owner)
            .addTrustedIssuer(ethers.ZeroAddress, [KYC_TOPIC]),
        ).to.be.revertedWith("ClaimIssuer: Invalid issuer");
      });
    });

    describe("removeTrustedIssuer", function () {
      beforeEach(async function () {
        await claimIssuer
          .connect(owner)
          .addTrustedIssuer(identity.address, [KYC_TOPIC, AML_TOPIC]);
      });

      it("Should allow owner to remove trusted issuer", async function () {
        await expect(
          claimIssuer.connect(owner).removeTrustedIssuer(identity.address),
        )
          .to.emit(claimIssuer, "TrustedIssuerRemoved")
          .withArgs(identity.address);
      });
    });
  });

  describe("Admin Functions", function () {
    describe("setIssuerInfo", function () {
      it("Should allow owner to update issuer information", async function () {
        await claimIssuer
          .connect(owner)
          .setIssuerInfo(
            "Updated KYC Provider",
            "Updated description",
            "https://updated-website.com",
          );

        expect(await claimIssuer.issuerName()).to.equal("Updated KYC Provider");
        expect(await claimIssuer.issuerDescription()).to.equal(
          "Updated description",
        );
        expect(await claimIssuer.issuerWebsite()).to.equal(
          "https://updated-website.com",
        );
      });

      it("Should reject update by non-owner", async function () {
        await expect(
          claimIssuer
            .connect(unauthorized)
            .setIssuerInfo(
              "Malicious Update",
              "Bad description",
              "https://malicious.com",
            ),
        ).to.be.revertedWithCustomError(
          claimIssuer,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("setActive", function () {
      it("Should allow owner to deactivate issuer", async function () {
        await claimIssuer.connect(owner).setActive(false);
        expect(await claimIssuer.isActive()).to.be.false;
      });

      it("Should allow owner to reactivate issuer", async function () {
        await claimIssuer.connect(owner).setActive(false);
        await claimIssuer.connect(owner).setActive(true);
        expect(await claimIssuer.isActive()).to.be.true;
      });
    });

    describe("getIssuerStats", function () {
      it("Should return correct issuer statistics", async function () {
        const claimData = ethers.solidityPacked(["string"], ["Test claim"]);

        // Issue some claims
        await issueSigned(
          claimIssuer,
          claimSigner,
          await onchainID.getAddress(),
          KYC_TOPIC,
          claimData,
          "",
          0,
        );
        await issueSigned(
          claimIssuer,
          claimSigner,
          await onchainID.getAddress(),
          AML_TOPIC,
          claimData,
          "",
          0,
        );

        // Revoke one claim
        const claimIds = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
        await claimIssuer.connect(claimSigner).revokeClaim(claimIds[0]);

        const [totalClaims, activeClaims, totalKeys, active] =
          await claimIssuer.getIssuerStats();
        expect(totalClaims).to.equal(2);
        expect(activeClaims).to.equal(1); // One revoked
        expect(totalKeys).to.equal(2); // Owner key + claim signer key
        expect(active).to.be.true;
      });
    });
  });

  describe("Integration Tests", function () {
    it("Should integrate with OnchainID contract", async function () {
      const claimData = ethers.solidityPacked(
        ["string"],
        ["Integration test claim"],
      );

      // Issue claim through ClaimIssuer
      await issueSigned(
        claimIssuer,
        claimSigner,
        await onchainID.getAddress(),
        KYC_TOPIC,
        claimData,
        "https://example.com/integration",
        0,
      );

      // Verify claim exists in OnchainID
      const claimIds = await onchainID.getClaimIdsByTopic(KYC_TOPIC);
      expect(claimIds.length).to.equal(1);

      // Verify claim details in OnchainID
      const [topic, scheme, issuer, signature, data, uri] =
        await onchainID.getClaim(claimIds[0]);
      expect(topic).to.equal(KYC_TOPIC);
      expect(scheme).to.equal(ECDSA_SCHEME);
      expect(issuer).to.equal(await claimIssuer.getAddress());
      expect(data).to.equal(claimData);
      expect(uri).to.equal("https://example.com/integration");
    });

    it("Should handle claim lifecycle end-to-end", async function () {
      const claimData = ethers.solidityPacked(
        ["string"],
        ["Lifecycle test claim"],
      );

      // 1. Issue claim
      await issueSigned(
        claimIssuer,
        claimSigner,
        await onchainID.getAddress(),
        KYC_TOPIC,
        claimData,
        "https://example.com/lifecycle",
        0,
      );

      // 2. Verify claim is valid
      const claimIds = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
      const claimId = claimIds[0];
      expect(await claimIssuer.isClaimValid(claimId)).to.be.true;

      // 3. Revoke claim
      await claimIssuer.connect(claimSigner).revokeClaim(claimId);

      // 4. Verify claim is no longer valid
      expect(await claimIssuer.isClaimValid(claimId)).to.be.false;

      // 5. Verify claim still exists but is marked as revoked
      const claim = await claimIssuer.getClaim(claimId);
      expect(claim.revoked).to.be.true;
      expect(claim.revokedAt).to.be.gt(0);
    });
  });
});
