import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ClaimIssuer, OnchainID } from "../typechain-types";

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

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await claimIssuer.owner()).to.equal(owner.address);
    });

    it("Should set issuer information", async function () {
      expect(await claimIssuer.issuerName()).to.equal("Test KYC Provider");
      expect(await claimIssuer.issuerDescription()).to.equal(
        "A trusted KYC verification service",
      );
      expect(await claimIssuer.isActive()).to.be.true;
    });

    it("Should add owner's key as management key", async function () {
      const ownerKey = ethers.keccak256(
        ethers.solidityPacked(["address"], [owner.address]),
      );
      const [key, purpose, keyType, revoked, revokedAt] =
        await claimIssuer.issuerKeys(ownerKey);
      expect(key).to.equal(ownerKey);
      expect(purpose).to.equal(MANAGEMENT_KEY);
      expect(keyType).to.equal(ECDSA_TYPE);
      expect(revoked).to.be.false;
    });
  });

  describe("Key Management", function () {
    let testKey: string;

    beforeEach(async function () {
      testKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["test-key"]),
      );
    });

    describe("addIssuerKey", function () {
      it("Should allow owner to add issuer key", async function () {
        await expect(
          claimIssuer
            .connect(owner)
            .addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE),
        )
          .to.emit(claimIssuer, "IssuerKeyAdded")
          .withArgs(testKey, CLAIM_SIGNER_KEY);

        const [key, purpose, keyType, revoked] =
          await claimIssuer.issuerKeys(testKey);
        expect(key).to.equal(testKey);
        expect(purpose).to.equal(CLAIM_SIGNER_KEY);
        expect(keyType).to.equal(ECDSA_TYPE);
        expect(revoked).to.be.false;
      });

      it("Should reject adding key by unauthorized user", async function () {
        await expect(
          claimIssuer
            .connect(unauthorized)
            .addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE),
        ).to.be.revertedWith(
          "ClaimIssuer: Sender does not have management key",
        );
      });

      it("Should reject adding zero key", async function () {
        await expect(
          claimIssuer
            .connect(owner)
            .addIssuerKey(ethers.ZeroHash, CLAIM_SIGNER_KEY, ECDSA_TYPE),
        ).to.be.revertedWith("ClaimIssuer: Invalid key");
      });

      it("Should reject adding duplicate key", async function () {
        await claimIssuer
          .connect(owner)
          .addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE);
        await expect(
          claimIssuer
            .connect(owner)
            .addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE),
        ).to.be.revertedWith("ClaimIssuer: Key already exists");
      });
    });

    describe("revokeIssuerKey", function () {
      beforeEach(async function () {
        await claimIssuer
          .connect(owner)
          .addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE);
      });

      it("Should allow owner to revoke issuer key", async function () {
        await expect(claimIssuer.connect(owner).revokeIssuerKey(testKey))
          .to.emit(claimIssuer, "IssuerKeyRevoked")
          .withArgs(testKey, CLAIM_SIGNER_KEY);

        const [, , , revoked, revokedAt] =
          await claimIssuer.issuerKeys(testKey);
        expect(revoked).to.be.true;
        expect(revokedAt).to.be.gt(0);
      });

      it("Should reject revoking non-existent key", async function () {
        const nonExistentKey = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        await expect(
          claimIssuer.connect(owner).revokeIssuerKey(nonExistentKey),
        ).to.be.revertedWith("ClaimIssuer: Key does not exist");
      });

      it("Should reject revoking already revoked key", async function () {
        await claimIssuer.connect(owner).revokeIssuerKey(testKey);
        await expect(
          claimIssuer.connect(owner).revokeIssuerKey(testKey),
        ).to.be.revertedWith("ClaimIssuer: Key already revoked");
      });
    });

    describe("getKeysByPurpose", function () {
      it("Should return keys by purpose", async function () {
        const key1 = ethers.keccak256(
          ethers.solidityPacked(["string"], ["key1"]),
        );
        const key2 = ethers.keccak256(
          ethers.solidityPacked(["string"], ["key2"]),
        );

        await claimIssuer
          .connect(owner)
          .addIssuerKey(key1, CLAIM_SIGNER_KEY, ECDSA_TYPE);
        await claimIssuer
          .connect(owner)
          .addIssuerKey(key2, CLAIM_SIGNER_KEY, ECDSA_TYPE);

        const claimSignerKeys =
          await claimIssuer.getKeysByPurpose(CLAIM_SIGNER_KEY);
        expect(claimSignerKeys).to.include(key1);
        expect(claimSignerKeys).to.include(key2);
      });
    });
  });
});
