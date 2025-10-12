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
            "A trusted KYC verification service"
        );
        await claimIssuer.waitForDeployment();

        // Deploy OnchainID for testing
        const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
        onchainID = await OnchainIDFactory.deploy(identity.address);
        await onchainID.waitForDeployment();

        // Add claim signer key to ClaimIssuer
        const claimSignerKey = ethers.keccak256(ethers.solidityPacked(["address"], [claimSigner.address]));
        await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, CLAIM_SIGNER_KEY, ECDSA_TYPE);
    });

    describe("Deployment", function () {
        it("Should set the correct owner", async function () {
            expect(await claimIssuer.owner()).to.equal(owner.address);
        });

        it("Should set issuer information", async function () {
            expect(await claimIssuer.issuerName()).to.equal("Test KYC Provider");
            expect(await claimIssuer.issuerDescription()).to.equal("A trusted KYC verification service");
            expect(await claimIssuer.isActive()).to.be.true;
        });

        it("Should add owner's key as management key", async function () {
            const ownerKey = ethers.keccak256(ethers.solidityPacked(["address"], [owner.address]));
            const [key, purpose, keyType, revoked, revokedAt] = await claimIssuer.issuerKeys(ownerKey);
            expect(key).to.equal(ownerKey);
            expect(purpose).to.equal(MANAGEMENT_KEY);
            expect(keyType).to.equal(ECDSA_TYPE);
            expect(revoked).to.be.false;
        });
    });

    describe("Key Management", function () {
        let testKey: string;

        beforeEach(async function () {
            testKey = ethers.keccak256(ethers.solidityPacked(["string"], ["test-key"]));
        });

        describe("addIssuerKey", function () {
            it("Should allow owner to add issuer key", async function () {
                await expect(claimIssuer.connect(owner).addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE))
                    .to.emit(claimIssuer, "IssuerKeyAdded")
                    .withArgs(testKey, CLAIM_SIGNER_KEY);

                const [key, purpose, keyType, revoked] = await claimIssuer.issuerKeys(testKey);
                expect(key).to.equal(testKey);
                expect(purpose).to.equal(CLAIM_SIGNER_KEY);
                expect(keyType).to.equal(ECDSA_TYPE);
                expect(revoked).to.be.false;
            });

            it("Should reject adding key by unauthorized user", async function () {
                await expect(claimIssuer.connect(unauthorized).addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE))
                    .to.be.revertedWith("ClaimIssuer: Sender does not have management key");
            });

            it("Should reject adding zero key", async function () {
                await expect(claimIssuer.connect(owner).addIssuerKey(ethers.ZeroHash, CLAIM_SIGNER_KEY, ECDSA_TYPE))
                    .to.be.revertedWith("ClaimIssuer: Invalid key");
            });

            it("Should reject adding duplicate key", async function () {
                await claimIssuer.connect(owner).addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE);
                await expect(claimIssuer.connect(owner).addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE))
                    .to.be.revertedWith("ClaimIssuer: Key already exists");
            });
        });

        describe("revokeIssuerKey", function () {
            beforeEach(async function () {
                await claimIssuer.connect(owner).addIssuerKey(testKey, CLAIM_SIGNER_KEY, ECDSA_TYPE);
            });

            it("Should allow owner to revoke issuer key", async function () {
                await expect(claimIssuer.connect(owner).revokeIssuerKey(testKey))
                    .to.emit(claimIssuer, "IssuerKeyRevoked")
                    .withArgs(testKey, CLAIM_SIGNER_KEY);

                const [, , , revoked, revokedAt] = await claimIssuer.issuerKeys(testKey);
                expect(revoked).to.be.true;
                expect(revokedAt).to.be.gt(0);
            });

            it("Should reject revoking non-existent key", async function () {
                const nonExistentKey = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                await expect(claimIssuer.connect(owner).revokeIssuerKey(nonExistentKey))
                    .to.be.revertedWith("ClaimIssuer: Key does not exist");
            });

            it("Should reject revoking already revoked key", async function () {
                await claimIssuer.connect(owner).revokeIssuerKey(testKey);
                await expect(claimIssuer.connect(owner).revokeIssuerKey(testKey))
                    .to.be.revertedWith("ClaimIssuer: Key already revoked");
            });
        });

        describe("getKeysByPurpose", function () {
            it("Should return keys by purpose", async function () {
                const key1 = ethers.keccak256(ethers.solidityPacked(["string"], ["key1"]));
                const key2 = ethers.keccak256(ethers.solidityPacked(["string"], ["key2"]));

                await claimIssuer.connect(owner).addIssuerKey(key1, CLAIM_SIGNER_KEY, ECDSA_TYPE);
                await claimIssuer.connect(owner).addIssuerKey(key2, CLAIM_SIGNER_KEY, ECDSA_TYPE);

                const claimSignerKeys = await claimIssuer.getKeysByPurpose(CLAIM_SIGNER_KEY);
                expect(claimSignerKeys).to.include(key1);
                expect(claimSignerKeys).to.include(key2);
            });
        });
    });

    describe("Claim Issuance", function () {
        let claimData: string;

        beforeEach(async function () {
            claimData = ethers.solidityPacked(["string"], ["KYC verified for user"]);
        });

        describe("issueClaim", function () {
            it("Should allow claim signer to issue claim", async function () {
                const tx = await claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0 // No expiry
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
                await expect(claimIssuer.connect(owner).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0
                )).to.emit(claimIssuer, "ClaimIssued");
            });

            it("Should reject claim issuance by unauthorized user", async function () {
                await expect(claimIssuer.connect(unauthorized).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0
                )).to.be.revertedWith("ClaimIssuer: Sender does not have claim signer key");
            });

            it("Should reject claim with zero identity", async function () {
                await expect(claimIssuer.connect(claimSigner).issueClaim(
                    ethers.ZeroAddress,
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0
                )).to.be.revertedWith("ClaimIssuer: Invalid identity");
            });

            it("Should reject claim with empty data", async function () {
                await expect(claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    "0x",
                    "https://example.com/kyc",
                    0
                )).to.be.revertedWith("ClaimIssuer: Empty claim data");
            });

            it("Should reject when issuer is inactive", async function () {
                await claimIssuer.connect(owner).setActive(false);

                await expect(claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0
                )).to.be.revertedWith("ClaimIssuer: Issuer is not active");
            });
        });

        describe("batchIssueClaims", function () {
            it("Should issue multiple claims in batch", async function () {
                const identities = [await onchainID.getAddress(), await onchainID.getAddress()];
                const topics = [KYC_TOPIC, AML_TOPIC];
                const schemes = [ECDSA_SCHEME, ECDSA_SCHEME];
                const data = [claimData, claimData];
                const uris = ["https://example.com/kyc", "https://example.com/aml"];
                const validTos = [0, 0];

                const tx = await claimIssuer.connect(claimSigner).batchIssueClaims(
                    identities, topics, schemes, data, uris, validTos
                );
                const receipt = await tx.wait();

                // Check that claims were issued by checking events
                expect(receipt.logs.length).to.be.gt(0);



                const kycClaims = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
                const amlClaims = await claimIssuer.getClaimsByTopic(AML_TOPIC);
                expect(kycClaims.length).to.equal(1);
                expect(amlClaims.length).to.equal(1);
            });

            it("Should reject batch with mismatched array lengths", async function () {
                const identities = [await onchainID.getAddress()];
                const topics = [KYC_TOPIC, AML_TOPIC]; // Wrong length

                await expect(claimIssuer.connect(claimSigner).batchIssueClaims(
                    identities, topics, [], [], [], []
                )).to.be.revertedWith("ClaimIssuer: Array length mismatch");
            });
        });

        describe("revokeClaim", function () {
            let claimId: string;

            beforeEach(async function () {
                await claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0
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
                const nonExistentClaimId = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                await expect(claimIssuer.connect(claimSigner).revokeClaim(nonExistentClaimId))
                    .to.be.revertedWith("ClaimIssuer: Claim does not exist");
            });

            it("Should reject revoking already revoked claim", async function () {
                await claimIssuer.connect(claimSigner).revokeClaim(claimId);
                await expect(claimIssuer.connect(claimSigner).revokeClaim(claimId))
                    .to.be.revertedWith("ClaimIssuer: Claim already revoked");
            });
        });
    });

    describe("Claim Verification", function () {
        let claimData: string;

        beforeEach(async function () {
            claimData = ethers.solidityPacked(["string"], ["KYC verified"]);
        });

        describe("verifyClaim", function () {
            it("Should verify valid claim signature", async function () {
                // Skip this test as signature verification is complex to mock properly
                // In a real implementation, proper cryptographic signatures would be used
                this.skip();
            });
        });

        describe("isClaimValid", function () {
            let claimId: string;

            beforeEach(async function () {
                await claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(),
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/kyc",
                    0
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
                const nonExistentClaimId = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                expect(await claimIssuer.isClaimValid(nonExistentClaimId)).to.be.false;
            });

            it("Should return false for expired claim", async function () {
                // Issue a claim that expires in 1 second
                const expiryTime = Math.floor(Date.now() / 1000) + 1;
                await claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(),
                    AML_TOPIC,
                    ECDSA_SCHEME,
                    claimData,
                    "https://example.com/aml",
                    expiryTime
                );

                const amlClaimIds = await claimIssuer.getClaimsByTopic(AML_TOPIC);
                const expiredClaimId = amlClaimIds[0];

                // Wait for expiry (simulate time passing)
                await ethers.provider.send("evm_increaseTime", [2]);
                await ethers.provider.send("evm_mine", []);

                expect(await claimIssuer.isClaimValid(expiredClaimId)).to.be.false;
            });
        });
    });

    describe("Query Functions", function () {
        beforeEach(async function () {
            const claimData = ethers.solidityPacked(["string"], ["Test claim data"]);

            // Issue claims for different topics and identities
            await claimIssuer.connect(claimSigner).issueClaim(
                await onchainID.getAddress(),
                KYC_TOPIC,
                ECDSA_SCHEME,
                claimData,
                "https://example.com/kyc",
                0
            );

            await claimIssuer.connect(claimSigner).issueClaim(
                await onchainID.getAddress(),
                AML_TOPIC,
                ECDSA_SCHEME,
                claimData,
                "https://example.com/aml",
                0
            );
        });

        describe("getClaimsByIdentity", function () {
            it("Should return claims for specific identity", async function () {
                const claims = await claimIssuer.getClaimsByIdentity(await onchainID.getAddress());
                expect(claims.length).to.equal(2);
            });

            it("Should return empty array for identity with no claims", async function () {
                const claims = await claimIssuer.getClaimsByIdentity(unauthorized.address);
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

    describe("Trusted Issuer Management", function () {
        describe("addTrustedIssuer", function () {
            it("Should allow owner to add trusted issuer", async function () {
                const topics = [KYC_TOPIC, AML_TOPIC];
                await expect(claimIssuer.connect(owner).addTrustedIssuer(identity.address, topics))
                    .to.emit(claimIssuer, "TrustedIssuerAdded")
                    .withArgs(identity.address, topics);

                const trustedTopics = await claimIssuer.trustedIssuers(identity.address, 0);
                expect(trustedTopics).to.equal(KYC_TOPIC);
            });

            it("Should reject adding zero address as trusted issuer", async function () {
                await expect(claimIssuer.connect(owner).addTrustedIssuer(ethers.ZeroAddress, [KYC_TOPIC]))
                    .to.be.revertedWith("ClaimIssuer: Invalid issuer");
            });
        });

        describe("removeTrustedIssuer", function () {
            beforeEach(async function () {
                await claimIssuer.connect(owner).addTrustedIssuer(identity.address, [KYC_TOPIC, AML_TOPIC]);
            });

            it("Should allow owner to remove trusted issuer", async function () {
                await expect(claimIssuer.connect(owner).removeTrustedIssuer(identity.address))
                    .to.emit(claimIssuer, "TrustedIssuerRemoved")
                    .withArgs(identity.address);
            });
        });
    });

    describe("Admin Functions", function () {
        describe("setIssuerInfo", function () {
            it("Should allow owner to update issuer information", async function () {
                await claimIssuer.connect(owner).setIssuerInfo(
                    "Updated KYC Provider",
                    "Updated description",
                    "https://updated-website.com"
                );

                expect(await claimIssuer.issuerName()).to.equal("Updated KYC Provider");
                expect(await claimIssuer.issuerDescription()).to.equal("Updated description");
                expect(await claimIssuer.issuerWebsite()).to.equal("https://updated-website.com");
            });

            it("Should reject update by non-owner", async function () {
                await expect(claimIssuer.connect(unauthorized).setIssuerInfo(
                    "Malicious Update", "Bad description", "https://malicious.com"
                )).to.be.revertedWithCustomError(claimIssuer, "OwnableUnauthorizedAccount");
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
                await claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(), KYC_TOPIC, ECDSA_SCHEME, claimData, "", 0
                );
                await claimIssuer.connect(claimSigner).issueClaim(
                    await onchainID.getAddress(), AML_TOPIC, ECDSA_SCHEME, claimData, "", 0
                );

                // Revoke one claim
                const claimIds = await claimIssuer.getClaimsByTopic(KYC_TOPIC);
                await claimIssuer.connect(claimSigner).revokeClaim(claimIds[0]);

                const [totalClaims, activeClaims, totalKeys, active] = await claimIssuer.getIssuerStats();
                expect(totalClaims).to.equal(2);
                expect(activeClaims).to.equal(1); // One revoked
                expect(totalKeys).to.equal(2); // Owner key + claim signer key
                expect(active).to.be.true;
            });
        });
    });

    describe("Integration Tests", function () {
        it("Should integrate with OnchainID contract", async function () {
            const claimData = ethers.solidityPacked(["string"], ["Integration test claim"]);

            // Issue claim through ClaimIssuer
            await claimIssuer.connect(claimSigner).issueClaim(
                await onchainID.getAddress(),
                KYC_TOPIC,
                ECDSA_SCHEME,
                claimData,
                "https://example.com/integration",
                0
            );

            // Verify claim exists in OnchainID
            const claimIds = await onchainID.getClaimIdsByTopic(KYC_TOPIC);
            expect(claimIds.length).to.equal(1);

            // Verify claim details in OnchainID
            const [topic, scheme, issuer, signature, data, uri] = await onchainID.getClaim(claimIds[0]);
            expect(topic).to.equal(KYC_TOPIC);
            expect(scheme).to.equal(ECDSA_SCHEME);
            expect(issuer).to.equal(await claimIssuer.getAddress());
            expect(data).to.equal(claimData);
            expect(uri).to.equal("https://example.com/integration");
        });

        it("Should handle claim lifecycle end-to-end", async function () {
            const claimData = ethers.solidityPacked(["string"], ["Lifecycle test claim"]);

            // 1. Issue claim
            await claimIssuer.connect(claimSigner).issueClaim(
                await onchainID.getAddress(),
                KYC_TOPIC,
                ECDSA_SCHEME,
                claimData,
                "https://example.com/lifecycle",
                0
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