import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ClaimIssuer, OnchainID } from "../typechain-types";
import { issueSigned, signClaim } from "./helpers/kyc";

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

  // Signed for this issuer on this chain (Task 5.2, review L-1).
  const sign = (...a: [SignerWithAddress, string, number, string, object?]) =>
    signClaim(a[0], claimIssuer, a[1], a[2], a[3], a[4]);

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

  describe("Claim Issuance", function () {
    let claimData: string;

    beforeEach(async function () {
      claimData = ethers.solidityPacked(["string"], ["KYC verified for user"]);
    });

    describe("issueClaim", function () {
      it("Should allow claim signer to issue claim", async function () {
        const tx = await issueSigned(
          claimIssuer,
          claimSigner,
          await onchainID.getAddress(),
          KYC_TOPIC,
          claimData,
          "https://example.com/kyc",
          0, // No expiry
        );

        await expect(tx).to.emit(claimIssuer, "ClaimIssued");

        // Check that claim was stored
        const claimIds = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
        expect(claimIds.length).to.equal(1);

        const claim = await claimIssuer.getClaim(claimIds[0]);
        expect(claim.identity).to.equal(await onchainID.getAddress());
        expect(claim.topic).to.equal(KYC_TOPIC);
        expect(claim.scheme).to.equal(ECDSA_SCHEME);
        expect(claim.data).to.equal(claimData);
        expect(claim.uri).to.equal("https://example.com/kyc");
        expect(claim.revoked).to.be.false;
      });

      it("Should allow owner to issue claim", async function () {
        await expect(
          issueSigned(
            claimIssuer,
            owner,
            await onchainID.getAddress(),
            KYC_TOPIC,
            claimData,
            "https://example.com/kyc",
            0,
          ),
        ).to.emit(claimIssuer, "ClaimIssued");
      });

      it("Should reject claim issuance by unauthorized user", async function () {
        await expect(
          issueSigned(
            claimIssuer,
            unauthorized,
            await onchainID.getAddress(),
            KYC_TOPIC,
            claimData,
            "https://example.com/kyc",
            0,
          ),
        ).to.be.revertedWith(
          "ClaimIssuer: Sender does not have claim signer key",
        );
      });

      it("Should reject claim with zero identity", async function () {
        await expect(
          issueSigned(
            claimIssuer,
            claimSigner,
            ethers.ZeroAddress,
            KYC_TOPIC,
            claimData,
            "https://example.com/kyc",
            0,
          ),
        ).to.be.revertedWith("ClaimIssuer: Invalid identity");
      });

      it("Should reject claim with empty data", async function () {
        await expect(
          issueSigned(
            claimIssuer,
            claimSigner,
            await onchainID.getAddress(),
            KYC_TOPIC,
            "0x",
            "https://example.com/kyc",
            0,
          ),
        ).to.be.revertedWith("ClaimIssuer: Empty claim data");
      });

      it("Should reject when issuer is inactive", async function () {
        await claimIssuer.connect(owner).setActive(false);

        await expect(
          issueSigned(
            claimIssuer,
            claimSigner,
            await onchainID.getAddress(),
            KYC_TOPIC,
            claimData,
            "https://example.com/kyc",
            0,
          ),
        ).to.be.revertedWith("ClaimIssuer: Issuer is not active");
      });
    });

    describe("batchIssueClaims", function () {
      it("Should issue multiple claims in batch", async function () {
        const identities = [
          await onchainID.getAddress(),
          await onchainID.getAddress(),
        ];
        const topics = [KYC_TOPIC, AML_TOPIC];
        const schemes = [ECDSA_SCHEME, ECDSA_SCHEME];
        const data = [claimData, claimData];
        const uris = ["https://example.com/kyc", "https://example.com/aml"];
        const validTos = [0, 0];
        const sigs = [];
        for (const i of [0, 1])
          sigs.push(
            await sign(claimSigner, identities[i], topics[i], claimData, {
              uri: uris[i],
            }),
          );

        const tx = await claimIssuer
          .connect(claimSigner)
          .batchIssueClaims(
            identities,
            topics,
            schemes,
            data,
            uris,
            validTos,
            sigs,
          );
        const receipt = await tx.wait();

        // Check that claims were issued by checking events
        expect(receipt!.logs.length).to.be.gt(0);

        const kycClaims = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
        const amlClaims = await claimIssuer.getClaimsByTopic(AML_TOPIC);
        expect(kycClaims.length).to.equal(1);
        expect(amlClaims.length).to.equal(1);
      });

      it("Should reject batch with mismatched array lengths", async function () {
        const identities = [await onchainID.getAddress()];
        const topics = [KYC_TOPIC, AML_TOPIC]; // Wrong length

        await expect(
          claimIssuer
            .connect(claimSigner)
            .batchIssueClaims(identities, topics, [], [], [], [], []),
        ).to.be.revertedWith("ClaimIssuer: Array length mismatch");
      });

      it("Should revert the whole batch if one signature is bad", async function () {
        const id = await onchainID.getAddress();
        const good = await sign(claimSigner, id, KYC_TOPIC, claimData);
        const bad = await sign(unauthorized, id, AML_TOPIC, claimData);

        await expect(
          claimIssuer
            .connect(claimSigner)
            .batchIssueClaims(
              [id, id],
              [KYC_TOPIC, AML_TOPIC],
              [ECDSA_SCHEME, ECDSA_SCHEME],
              [claimData, claimData],
              ["", ""],
              [0, 0],
              [good, bad],
            ),
        ).to.be.revertedWith(
          "ClaimIssuer: Signer does not have claim signer key",
        );
        expect(await claimIssuer.getClaimsByTopic(KYC_TOPIC)).to.have.length(0);
      });
    });

    describe("signed issuance (D15)", function () {
      // issueClaim stores the caller-supplied ECDSA signature and only
      // accepts it if the recovered signer holds a CLAIM_SIGNER or
      // MANAGEMENT key (or is the owner), the same rule verifyClaim applies.
      it("Should reject a signature from a key with no signing purpose", async function () {
        const id = await onchainID.getAddress();
        const sig = await sign(unauthorized, id, KYC_TOPIC, claimData);
        await expect(
          claimIssuer
            .connect(claimSigner)
            .issueClaim(id, KYC_TOPIC, ECDSA_SCHEME, claimData, "", 0, sig),
        ).to.be.revertedWith(
          "ClaimIssuer: Signer does not have claim signer key",
        );
      });

      it("Should reject a malformed signature", async function () {
        const id = await onchainID.getAddress();
        await expect(
          claimIssuer
            .connect(claimSigner)
            .issueClaim(
              id,
              KYC_TOPIC,
              ECDSA_SCHEME,
              claimData,
              "",
              0,
              "0x1234",
            ),
        ).to.be.revertedWithCustomError(
          claimIssuer,
          "ECDSAInvalidSignatureLength",
        );
      });

      it("Should reject a valid signature over different claim data", async function () {
        const id = await onchainID.getAddress();
        const sig = await sign(claimSigner, id, AML_TOPIC, claimData);
        await expect(
          claimIssuer
            .connect(claimSigner)
            .issueClaim(id, KYC_TOPIC, ECDSA_SCHEME, claimData, "", 0, sig),
        ).to.be.revertedWith(
          "ClaimIssuer: Signer does not have claim signer key",
        );
      });

      it("Should store a signature that verifyClaim accepts until revoked", async function () {
        const id = await onchainID.getAddress();
        await issueSigned(claimIssuer, claimSigner, id, KYC_TOPIC, claimData);
        const [claimId] = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
        const stored = (await claimIssuer.issuedClaims(claimId)).signature;

        expect(await claimIssuer.isClaimValid(claimId)).to.be.true;
        const v = () =>
          claimIssuer.verifyClaim(id, KYC_TOPIC, 1, claimData, "", 0, stored);
        expect(await v()).to.be.true;
        // Revocation kills the record and the signature (epoch, L-2).
        await claimIssuer.connect(claimSigner).revokeClaim(claimId);
        expect(await claimIssuer.isClaimValid(claimId)).to.be.false;
        expect(await v()).to.be.false;
      });
    });

    describe("revokeClaim", function () {
      let claimId: string;

      beforeEach(async function () {
        await issueSigned(
          claimIssuer,
          claimSigner,
          await onchainID.getAddress(),
          KYC_TOPIC,
          claimData,
          "https://example.com/kyc",
          0,
        );

        const claimIds = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
        claimId = claimIds[0];
      });

      it("Should allow claim signer to revoke claim", async function () {
        await expect(claimIssuer.connect(claimSigner).revokeClaim(claimId))
          .to.emit(claimIssuer, "ClaimRevoked")
          .withArgs(await onchainID.getAddress(), claimId, KYC_TOPIC);

        const claim = await claimIssuer.getClaim(claimId);
        expect(claim.revoked).to.be.true;
        expect(claim.revokedAt).to.be.gt(0);
      });

      it("Should reject revoking non-existent claim", async function () {
        const nonExistentClaimId = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        await expect(
          claimIssuer.connect(claimSigner).revokeClaim(nonExistentClaimId),
        ).to.be.revertedWith("ClaimIssuer: Claim does not exist");
      });

      it("Should reject revoking already revoked claim", async function () {
        await claimIssuer.connect(claimSigner).revokeClaim(claimId);
        await expect(
          claimIssuer.connect(claimSigner).revokeClaim(claimId),
        ).to.be.revertedWith("ClaimIssuer: Claim already revoked");
      });
    });
  });
});
