import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
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

  describe("Claim Verification", function () {
    let claimData: string;

    beforeEach(async function () {
      claimData = ethers.solidityPacked(["string"], ["KYC verified"]);
    });

    describe("verifyClaim", function () {
      // verifyClaim recovers the signer of claimDigest (signClaim signs it
      // with the EIP-191 prefix) and applies issueClaim's signer rule.
      const verify = async (signer: SignerWithAddress, data = claimData) => {
        const id = await onchainID.getAddress();
        const sig = await sign(signer, id, KYC_TOPIC, claimData);
        return claimIssuer.verifyClaim(id, KYC_TOPIC, 1, data, "", 0, sig);
      };

      it("Should accept a CLAIM_SIGNER and the MANAGEMENT key (owner)", async function () {
        expect(await verify(claimSigner)).to.be.true;
        expect(await verify(owner)).to.be.true;
      });

      it("Should reject a signature from an address with no issuer key", async function () {
        expect(await verify(unauthorized)).to.be.false;
      });

      it("Should reject a valid signature bound to different claim data", async function () {
        const other = ethers.solidityPacked(["string"], ["AML cleared"]);
        expect(await verify(claimSigner, other)).to.be.false;
      });
    });

    describe("isClaimValid", function () {
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

      it("Should return true for valid claim", async function () {
        expect(await claimIssuer.isClaimValid(claimId)).to.be.true;
      });

      it("Should return false for revoked claim", async function () {
        await claimIssuer.connect(claimSigner).revokeClaim(claimId);
        expect(await claimIssuer.isClaimValid(claimId)).to.be.false;
      });

      it("Should return false for non-existent claim", async function () {
        const nonExistentClaimId = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        expect(await claimIssuer.isClaimValid(nonExistentClaimId)).to.be.false;
      });

      // Task 5.17 (deep review, timing-dependent tests): the expiry came
      // from the wall clock (Date.now()), which the chain's clock need not
      // follow, and only the expired case was asserted. Expiry is now set
      // on block time, and the claim is checked valid before it too.
      it("Should return false for expired claim", async function () {
        const now = (await ethers.provider.getBlock("latest"))!.timestamp;
        const expiryTime = now + 100;
        await issueSigned(
          claimIssuer,
          claimSigner,
          await onchainID.getAddress(),
          AML_TOPIC,
          claimData,
          "https://example.com/aml",
          expiryTime,
        );

        const amlClaimIds = await claimIssuer.getClaimsByTopic(AML_TOPIC);
        const expiredClaimId = amlClaimIds[0];

        expect(await claimIssuer.isClaimValid(expiredClaimId)).to.be.true;
        await time.increaseTo(expiryTime - 10);
        expect(await claimIssuer.isClaimValid(expiredClaimId)).to.be.true;
        await time.increaseTo(expiryTime + 1);
        expect(await claimIssuer.isClaimValid(expiredClaimId)).to.be.false;
      });
    });
  });

  describe("Query Functions", function () {
    beforeEach(async function () {
      const claimData = ethers.solidityPacked(["string"], ["Test claim data"]);

      // Issue claims for different topics and identities
      await issueSigned(
        claimIssuer,
        claimSigner,
        await onchainID.getAddress(),
        KYC_TOPIC,
        claimData,
        "https://example.com/kyc",
        0,
      );

      await issueSigned(
        claimIssuer,
        claimSigner,
        await onchainID.getAddress(),
        AML_TOPIC,
        claimData,
        "https://example.com/aml",
        0,
      );
    });

    describe("getClaimsByIdentity", function () {
      it("Should return claims for specific identity", async function () {
        const claims = await claimIssuer.getClaimsByIdentity(
          await onchainID.getAddress(),
        );
        expect(claims.length).to.equal(2);
      });

      it("Should return empty array for identity with no claims", async function () {
        const claims = await claimIssuer.getClaimsByIdentity(
          unauthorized.address,
        );
        expect(claims.length).to.equal(0);
      });
    });

    describe("getClaimsByTopic", function () {
      it("Should return claims for specific topic", async function () {
        const kycClaims = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
        const amlClaims = await claimIssuer.getClaimsByTopic(AML_TOPIC);

        expect(kycClaims.length).to.equal(1);
        expect(amlClaims.length).to.equal(1);
      });

      it("Should return empty array for topic with no claims", async function () {
        const claims = await claimIssuer.getClaimsByTopic(INVESTOR_TYPE_TOPIC);
        expect(claims.length).to.equal(0);
      });
    });
  });
});
