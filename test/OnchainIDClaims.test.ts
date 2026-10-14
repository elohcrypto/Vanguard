import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OnchainID } from "../typechain-types";
import { signClaim } from "./helpers/kyc";

// A real ClaimIssuer owned by `signer` issues `data` on each topic to
// `identity`. Verification asks the issuer (IdentityRegistry calls
// ClaimIssuer.hasValidClaim; 2F.2 review, N1), so a claim the owner
// writes naming an issuer counts for nothing.
async function issueVia(
  signer: SignerWithAddress,
  identity: string,
  topics: number[],
  data: string,
): Promise<string> {
  const iss = await (
    await ethers.getContractFactory("ClaimIssuer")
  ).deploy(signer.address, "KYC", "kyc");
  for (const topic of topics) {
    const sig = await signClaim(signer, iss, identity, topic, data);
    await iss.connect(signer).issueClaim(identity, topic, 1, data, "", 0, sig);
  }
  return iss.getAddress();
}

describe("OnchainID", function () {
  let onchainID: OnchainID;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let claimIssuer: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  // Claim topics
  const IDENTITY_TOPIC = 1;
  const KYC_TOPIC = 6;
  const AML_TOPIC = 7;

  // Signature schemes
  const ECDSA_SCHEME = 1;

  beforeEach(async function () {
    [owner, user1, user2, claimIssuer, unauthorized] =
      await ethers.getSigners();

    const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
    onchainID = await OnchainIDFactory.deploy(owner.address);
    await onchainID.waitForDeployment();
  });

  describe("Claim Management (ERC-735)", function () {
    let claimData: string;
    let claimSignature: string;

    beforeEach(async function () {
      claimData = ethers.solidityPacked(["string"], ["KYC verified"]);
      claimSignature = ethers.solidityPacked(["string"], ["mock-signature"]);
    });

    describe("addClaim", function () {
      it("Should allow owner to add a claim", async function () {
        await expect(
          onchainID
            .connect(owner)
            .addClaim(
              KYC_TOPIC,
              ECDSA_SCHEME,
              claimIssuer.address,
              claimSignature,
              claimData,
              "https://example.com/kyc",
            ),
        ).to.emit(onchainID, "ClaimAdded");

        const claimIds = await onchainID.getClaimIdsByTopic(KYC_TOPIC);
        expect(claimIds.length).to.equal(1);
      });

      it("Should allow claim issuer to add their own claim", async function () {
        await expect(
          onchainID
            .connect(claimIssuer)
            .addClaim(
              KYC_TOPIC,
              ECDSA_SCHEME,
              claimIssuer.address,
              claimSignature,
              claimData,
              "https://example.com/kyc",
            ),
        ).to.emit(onchainID, "ClaimAdded");
      });

      it("Should reject adding claim with zero issuer", async function () {
        await expect(
          onchainID
            .connect(owner)
            .addClaim(
              KYC_TOPIC,
              ECDSA_SCHEME,
              ethers.ZeroAddress,
              claimSignature,
              claimData,
              "https://example.com/kyc",
            ),
        ).to.be.revertedWith("OnchainID: Invalid issuer");
      });

      it("Should reject adding claim by unauthorized user", async function () {
        await expect(
          onchainID
            .connect(unauthorized)
            .addClaim(
              KYC_TOPIC,
              ECDSA_SCHEME,
              claimIssuer.address,
              claimSignature,
              claimData,
              "https://example.com/kyc",
            ),
        ).to.be.revertedWith("OnchainID: Not authorized to add claim");
      });
    });

    describe("removeClaim", function () {
      let claimId: string;

      beforeEach(async function () {
        await onchainID
          .connect(owner)
          .addClaim(
            KYC_TOPIC,
            ECDSA_SCHEME,
            claimIssuer.address,
            claimSignature,
            claimData,
            "https://example.com/kyc",
          );

        claimId = ethers.keccak256(
          ethers.solidityPacked(
            ["address", "uint256", "bytes"],
            [claimIssuer.address, KYC_TOPIC, claimData],
          ),
        );
      });

      it("Should allow owner to remove a claim", async function () {
        await expect(onchainID.connect(owner).removeClaim(claimId)).to.emit(
          onchainID,
          "ClaimRemoved",
        );

        const claimIds = await onchainID.getClaimIdsByTopic(KYC_TOPIC);
        expect(claimIds.length).to.equal(0);
      });

      it("Should reject removing non-existent claim", async function () {
        const nonExistentClaimId = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        await expect(
          onchainID.connect(owner).removeClaim(nonExistentClaimId),
        ).to.be.revertedWith("OnchainID: Claim does not exist");
      });

      it("Should reject removal by unauthorized user", async function () {
        await expect(
          onchainID.connect(unauthorized).removeClaim(claimId),
        ).to.be.revertedWith("OnchainID: Not authorized to remove claim");
      });
    });

    describe("getClaim", function () {
      let claimId: string;

      beforeEach(async function () {
        await onchainID
          .connect(owner)
          .addClaim(
            KYC_TOPIC,
            ECDSA_SCHEME,
            claimIssuer.address,
            claimSignature,
            claimData,
            "https://example.com/kyc",
          );

        claimId = ethers.keccak256(
          ethers.solidityPacked(
            ["address", "uint256", "bytes"],
            [claimIssuer.address, KYC_TOPIC, claimData],
          ),
        );
      });

      it("Should return correct claim information", async function () {
        const [topic, scheme, issuer, signature, data, uri] =
          await onchainID.getClaim(claimId);
        expect(topic).to.equal(KYC_TOPIC);
        expect(scheme).to.equal(ECDSA_SCHEME);
        expect(issuer).to.equal(claimIssuer.address);
        expect(signature).to.equal(claimSignature);
        expect(data).to.equal(claimData);
        expect(uri).to.equal("https://example.com/kyc");
      });
    });

    // Verification asks the issuer (ClaimIssuer.hasValidClaim), never this
    // identity's lists: IdentityRegistry does, and OnchainID keeps no
    // pass-through of its own (plan v2 Task 4.5).
    describe("a claim counts only when its issuer attests it", function () {
      let issuerAddr: string;
      let iss: any;

      beforeEach(async function () {
        issuerAddr = await issueVia(
          claimIssuer,
          await onchainID.getAddress(),
          [KYC_TOPIC],
          claimData,
        );
        iss = await ethers.getContractAt("ClaimIssuer", issuerAddr);
      });

      it("the issuer attests the claim it issued", async function () {
        const id = await onchainID.getAddress();
        expect(await iss.hasValidClaim(id, KYC_TOPIC)).to.be.true;
        expect(await onchainID.getClaimIdsByTopic(KYC_TOPIC)).to.have.length(1);
      });

      it("the issuer attests no topic it did not issue", async function () {
        const id = await onchainID.getAddress();
        expect(await iss.hasValidClaim(id, AML_TOPIC)).to.be.false;
      });

      it("an owner-written claim naming the issuer counts for nothing", async function () {
        const id = await onchainID.getAddress();
        await onchainID
          .connect(owner)
          .addClaim(
            AML_TOPIC,
            ECDSA_SCHEME,
            issuerAddr,
            claimSignature,
            ethers.toUtf8Bytes("forged"),
            "",
          );
        expect(await onchainID.getClaimIdsByTopic(AML_TOPIC)).to.have.length(1);
        expect(await iss.hasValidClaim(id, AML_TOPIC)).to.be.false;
      });
    });

    describe("batchAddClaims", function () {
      it("Should add multiple claims in batch", async function () {
        const topics = [KYC_TOPIC, AML_TOPIC];
        const schemes = [ECDSA_SCHEME, ECDSA_SCHEME];
        const issuers = [claimIssuer.address, claimIssuer.address];
        const signatures = [claimSignature, claimSignature];
        const data = [claimData, claimData];
        const uris = ["https://example.com/kyc", "https://example.com/aml"];

        await onchainID
          .connect(owner)
          .batchAddClaims(topics, schemes, issuers, signatures, data, uris);

        expect((await onchainID.getClaimIdsByTopic(KYC_TOPIC)).length).to.equal(
          1,
        );
        expect((await onchainID.getClaimIdsByTopic(AML_TOPIC)).length).to.equal(
          1,
        );
      });

      it("Should reject batch with mismatched array lengths", async function () {
        const topics = [KYC_TOPIC];
        const schemes = [ECDSA_SCHEME, ECDSA_SCHEME]; // Wrong length

        await expect(
          onchainID
            .connect(owner)
            .batchAddClaims(topics, schemes, [], [], [], []),
        ).to.be.revertedWith("OnchainID: Array length mismatch");
      });
    });
  });

  // Plan v2 Task 4.5: the identity-level trusted-issuer, required-topic
  // and compliance store was a third copy of what IdentityRegistry holds
  // and nothing read it; authorizeContract duplicated authorizeManager.
  describe("Removed surface (plan v2 Task 4.5)", function () {
    it("answers none of the removed selectors", async function () {
      const to = await onchainID.getAddress();
      for (const sig of [
        "authorizeContract(address)",
        "addTrustedIssuer(address,uint256[])",
        "removeTrustedIssuer(address)",
        "isTrustedIssuer(address,uint256)",
        "getTrustedIssuers()",
        "addClaimTopic(uint256,bool)",
        "removeClaimTopic(uint256)",
        "isRequiredTopic(uint256)",
        "getRequiredTopics()",
        "isCompliant()",
        "getComplianceStatus()",
        "getIdentityStats()",
        "getAllClaims()",
        "hasTopic(uint256)",
        "hasValidClaim(uint256,address)",
        "MAX_ARRAY_LENGTH()",
      ]) {
        const data = ethers.id(sig).slice(0, 10).padEnd(138, "0");
        let answered = true;
        try {
          await ethers.provider.call({ to, data });
        } catch {
          answered = false;
        }
        expect(answered, sig).to.equal(false);
      }
    });
  });

  describe("Utilities", function () {
    it("Should return creation time", async function () {
      const creationTime = await onchainID.getCreationTime();
      expect(creationTime).to.be.gt(0);
    });
  });

  describe("Access Control", function () {
    it("Should allow ownership transfer (two-step, plan 2F.2)", async function () {
      await expect(onchainID.connect(owner).transferOwnership(user1.address))
        .to.emit(onchainID, "OwnershipTransferStarted")
        .withArgs(owner.address, user1.address);
      await expect(onchainID.connect(user1).acceptOwnership())
        .to.emit(onchainID, "OwnershipTransferred")
        .withArgs(owner.address, user1.address);

      expect(await onchainID.owner()).to.equal(user1.address);
    });

    it("Should reject ownership transfer by non-owner", async function () {
      await expect(
        onchainID.connect(unauthorized).transferOwnership(user1.address),
      ).to.be.revertedWithCustomError(onchainID, "OwnableUnauthorizedAccount");
    });
  });
});
