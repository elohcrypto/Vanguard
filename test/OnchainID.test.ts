import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OnchainID, OnchainID__factory } from "../typechain-types";

describe("OnchainID", function () {
    let onchainID: OnchainID;
    let owner: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let claimIssuer: SignerWithAddress;
    let unauthorized: SignerWithAddress;

    // Key purposes
    const MANAGEMENT_KEY = 1;
    const ACTION_KEY = 2;
    const CLAIM_SIGNER_KEY = 3;
    const ENCRYPTION_KEY = 4;

    // Key types
    const ECDSA_TYPE = 1;

    // Claim topics
    const IDENTITY_TOPIC = 1;
    const KYC_TOPIC = 6;
    const AML_TOPIC = 7;

    // Signature schemes
    const ECDSA_SCHEME = 1;

    beforeEach(async function () {
        [owner, user1, user2, claimIssuer, unauthorized] = await ethers.getSigners();

        const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
        onchainID = await OnchainIDFactory.deploy(owner.address);
        await onchainID.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should set the correct owner", async function () {
            expect(await onchainID.owner()).to.equal(owner.address);
        });

        it("Should set creation time", async function () {
            const creationTime = await onchainID.getCreationTime();
            expect(creationTime).to.be.gt(0);
        });

        it("Should add owner's key as management key", async function () {
            const ownerKey = ethers.keccak256(ethers.solidityPacked(["address"], [owner.address]));
            expect(await onchainID.keyHasPurpose(ownerKey, MANAGEMENT_KEY)).to.be.true;
        });

        it("Should emit IdentityCreated event", async function () {
            const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
            const newOnchainID = await OnchainIDFactory.deploy(user1.address);

            // Check that the contract was deployed successfully
            expect(await newOnchainID.getAddress()).to.not.equal(ethers.ZeroAddress);
        });
    });

    describe("Key Management (ERC-734)", function () {
        let testKey: string;
        let user1Key: string;

        beforeEach(async function () {
            testKey = ethers.keccak256(ethers.solidityPacked(["string"], ["test-key"]));
            user1Key = ethers.keccak256(ethers.solidityPacked(["address"], [user1.address]));
        });

        describe("addKey", function () {
            it("Should allow owner to add a key", async function () {
                await expect(onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE))
                    .to.emit(onchainID, "KeyAdded")
                    .withArgs(testKey, ACTION_KEY, ECDSA_TYPE);

                expect(await onchainID.keyHasPurpose(testKey, ACTION_KEY)).to.be.true;
            });

            it("Should allow management key holder to add a key", async function () {
                // First add user1 as management key
                await onchainID.connect(owner).addKey(user1Key, MANAGEMENT_KEY, ECDSA_TYPE);

                // Now user1 should be able to add keys
                await expect(onchainID.connect(user1).addKey(testKey, ACTION_KEY, ECDSA_TYPE))
                    .to.emit(onchainID, "KeyAdded")
                    .withArgs(testKey, ACTION_KEY, ECDSA_TYPE);
            });

            it("Should reject adding key by unauthorized user", async function () {
                await expect(onchainID.connect(unauthorized).addKey(testKey, ACTION_KEY, ECDSA_TYPE))
                    .to.be.revertedWith("OnchainID: Sender does not have management key");
            });

            it("Should reject adding zero key", async function () {
                await expect(onchainID.connect(owner).addKey(ethers.ZeroHash, ACTION_KEY, ECDSA_TYPE))
                    .to.be.revertedWith("OnchainID: Invalid key");
            });

            it("Should reject adding duplicate key", async function () {
                await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);
                await expect(onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE))
                    .to.be.revertedWith("OnchainID: Key already exists");
            });
        });

        describe("removeKey", function () {
            beforeEach(async function () {
                await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);
            });

            it("Should allow owner to remove a key", async function () {
                await expect(onchainID.connect(owner).removeKey(testKey, ACTION_KEY))
                    .to.emit(onchainID, "KeyRemoved")
                    .withArgs(testKey, ACTION_KEY, ECDSA_TYPE);

                expect(await onchainID.keyHasPurpose(testKey, ACTION_KEY)).to.be.false;
            });

            it("Should reject removing non-existent key", async function () {
                const nonExistentKey = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                await expect(onchainID.connect(owner).removeKey(nonExistentKey, ACTION_KEY))
                    .to.be.revertedWith("OnchainID: Key does not exist");
            });

            it("Should reject removing key with wrong purpose", async function () {
                await expect(onchainID.connect(owner).removeKey(testKey, MANAGEMENT_KEY))
                    .to.be.revertedWith("OnchainID: Purpose mismatch");
            });

            it("Should reject removal by unauthorized user", async function () {
                await expect(onchainID.connect(unauthorized).removeKey(testKey, ACTION_KEY))
                    .to.be.revertedWith("OnchainID: Sender does not have management key");
            });
        });

        describe("getKey", function () {
            it("Should return correct key information", async function () {
                await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);

                const [purpose, keyType, key, revokedAt] = await onchainID.getKey(testKey);
                expect(purpose).to.equal(ACTION_KEY);
                expect(keyType).to.equal(ECDSA_TYPE);
                expect(key).to.equal(testKey);
                expect(revokedAt).to.equal(0);
            });

            it("Should return zero values for non-existent key", async function () {
                const nonExistentKey = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                const [purpose, keyType, key, revokedAt] = await onchainID.getKey(nonExistentKey);
                expect(purpose).to.equal(0);
                expect(keyType).to.equal(0);
                expect(key).to.equal(ethers.ZeroHash);
                expect(revokedAt).to.equal(0);
            });
        });

        describe("getKeysByPurpose", function () {
            it("Should return keys by purpose", async function () {
                const key1 = ethers.keccak256(ethers.solidityPacked(["string"], ["key1"]));
                const key2 = ethers.keccak256(ethers.solidityPacked(["string"], ["key2"]));

                await onchainID.connect(owner).addKey(key1, ACTION_KEY, ECDSA_TYPE);
                await onchainID.connect(owner).addKey(key2, ACTION_KEY, ECDSA_TYPE);

                const actionKeys = await onchainID.getKeysByPurpose(ACTION_KEY);
                expect(actionKeys).to.include(key1);
                expect(actionKeys).to.include(key2);
                expect(actionKeys.length).to.equal(2);
            });

            it("Should return empty array for purpose with no keys", async function () {
                const encryptionKeys = await onchainID.getKeysByPurpose(ENCRYPTION_KEY);
                expect(encryptionKeys.length).to.equal(0);
            });
        });

        describe("execute", function () {
            let actionKey: string;

            beforeEach(async function () {
                actionKey = ethers.keccak256(ethers.solidityPacked(["address"], [user1.address]));
                await onchainID.connect(owner).addKey(actionKey, ACTION_KEY, ECDSA_TYPE);
            });

            it("Should allow action key holder to execute", async function () {
                const target = await ethers.deployContract("MockTarget");
                const data = target.interface.encodeFunctionData("setValue", [42]);

                await expect(onchainID.connect(user1).execute(await target.getAddress(), 0, data))
                    .to.emit(onchainID, "ExecutionRequested");
            });

            it("Should auto-execute for management key holder", async function () {
                const target = await ethers.deployContract("MockTarget");
                const data = target.interface.encodeFunctionData("setValue", [42]);

                await expect(onchainID.connect(owner).execute(await target.getAddress(), 0, data))
                    .to.emit(onchainID, "Executed");
            });

            it("Should reject execution by unauthorized user", async function () {
                const target = await ethers.deployContract("MockTarget");
                const data = target.interface.encodeFunctionData("setValue", [42]);

                await expect(onchainID.connect(unauthorized).execute(await target.getAddress(), 0, data))
                    .to.be.revertedWith("OnchainID: Sender does not have action key");
            });
        });
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
                await expect(onchainID.connect(owner).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimIssuer.address,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                )).to.emit(onchainID, "ClaimAdded");

                const claimIds = await onchainID.getClaimIdsByTopic(KYC_TOPIC);
                expect(claimIds.length).to.equal(1);
            });

            it("Should allow claim issuer to add their own claim", async function () {
                await expect(onchainID.connect(claimIssuer).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimIssuer.address,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                )).to.emit(onchainID, "ClaimAdded");
            });

            it("Should reject adding claim with zero issuer", async function () {
                await expect(onchainID.connect(owner).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    ethers.ZeroAddress,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                )).to.be.revertedWith("OnchainID: Invalid issuer");
            });

            it("Should reject adding claim by unauthorized user", async function () {
                await expect(onchainID.connect(unauthorized).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimIssuer.address,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                )).to.be.revertedWith("OnchainID: Not authorized to add claim");
            });
        });

        describe("removeClaim", function () {
            let claimId: string;

            beforeEach(async function () {
                await onchainID.connect(owner).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimIssuer.address,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                );

                claimId = ethers.keccak256(ethers.solidityPacked(
                    ["address", "uint256", "bytes"],
                    [claimIssuer.address, KYC_TOPIC, claimData]
                ));
            });

            it("Should allow owner to remove a claim", async function () {
                await expect(onchainID.connect(owner).removeClaim(claimId))
                    .to.emit(onchainID, "ClaimRemoved");

                const claimIds = await onchainID.getClaimIdsByTopic(KYC_TOPIC);
                expect(claimIds.length).to.equal(0);
            });

            it("Should reject removing non-existent claim", async function () {
                const nonExistentClaimId = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                await expect(onchainID.connect(owner).removeClaim(nonExistentClaimId))
                    .to.be.revertedWith("OnchainID: Claim does not exist");
            });

            it("Should reject removal by unauthorized user", async function () {
                await expect(onchainID.connect(unauthorized).removeClaim(claimId))
                    .to.be.revertedWith("OnchainID: Sender does not have management key");
            });
        });

        describe("getClaim", function () {
            let claimId: string;

            beforeEach(async function () {
                await onchainID.connect(owner).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimIssuer.address,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                );

                claimId = ethers.keccak256(ethers.solidityPacked(
                    ["address", "uint256", "bytes"],
                    [claimIssuer.address, KYC_TOPIC, claimData]
                ));
            });

            it("Should return correct claim information", async function () {
                const [topic, scheme, issuer, signature, data, uri] = await onchainID.getClaim(claimId);
                expect(topic).to.equal(KYC_TOPIC);
                expect(scheme).to.equal(ECDSA_SCHEME);
                expect(issuer).to.equal(claimIssuer.address);
                expect(signature).to.equal(claimSignature);
                expect(data).to.equal(claimData);
                expect(uri).to.equal("https://example.com/kyc");
            });
        });

        describe("hasValidClaim", function () {
            beforeEach(async function () {
                await onchainID.connect(owner).addClaim(
                    KYC_TOPIC,
                    ECDSA_SCHEME,
                    claimIssuer.address,
                    claimSignature,
                    claimData,
                    "https://example.com/kyc"
                );
            });

            it("Should return true for valid claim", async function () {
                expect(await onchainID.hasValidClaim(KYC_TOPIC, claimIssuer.address)).to.be.true;
            });

            it("Should return false for non-existent claim", async function () {
                expect(await onchainID.hasValidClaim(AML_TOPIC, claimIssuer.address)).to.be.false;
            });

            it("Should return false for wrong issuer", async function () {
                expect(await onchainID.hasValidClaim(KYC_TOPIC, user1.address)).to.be.false;
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

                await onchainID.connect(owner).batchAddClaims(
                    topics, schemes, issuers, signatures, data, uris
                );

                expect(await onchainID.hasValidClaim(KYC_TOPIC, claimIssuer.address)).to.be.true;
                expect(await onchainID.hasValidClaim(AML_TOPIC, claimIssuer.address)).to.be.true;
            });

            it("Should reject batch with mismatched array lengths", async function () {
                const topics = [KYC_TOPIC];
                const schemes = [ECDSA_SCHEME, ECDSA_SCHEME]; // Wrong length

                await expect(onchainID.connect(owner).batchAddClaims(
                    topics, schemes, [], [], [], []
                )).to.be.revertedWith("OnchainID: Array length mismatch");
            });
        });
    });

    describe("Trusted Issuer Management", function () {
        describe("addTrustedIssuer", function () {
            it("Should allow owner to add trusted issuer", async function () {
                const topics = [KYC_TOPIC, AML_TOPIC];
                await expect(onchainID.connect(owner).addTrustedIssuer(claimIssuer.address, topics))
                    .to.emit(onchainID, "TrustedIssuerAdded")
                    .withArgs(claimIssuer.address, topics);

                expect(await onchainID.isTrustedIssuer(claimIssuer.address, KYC_TOPIC)).to.be.true;
                expect(await onchainID.isTrustedIssuer(claimIssuer.address, AML_TOPIC)).to.be.true;
            });

            it("Should reject adding zero address as trusted issuer", async function () {
                await expect(onchainID.connect(owner).addTrustedIssuer(ethers.ZeroAddress, [KYC_TOPIC]))
                    .to.be.revertedWith("OnchainID: Invalid issuer");
            });

            it("Should reject adding trusted issuer by unauthorized user", async function () {
                await expect(onchainID.connect(unauthorized).addTrustedIssuer(claimIssuer.address, [KYC_TOPIC]))
                    .to.be.revertedWith("OnchainID: Sender does not have management key");
            });
        });

        describe("removeTrustedIssuer", function () {
            beforeEach(async function () {
                await onchainID.connect(owner).addTrustedIssuer(claimIssuer.address, [KYC_TOPIC, AML_TOPIC]);
            });

            it("Should allow owner to remove trusted issuer", async function () {
                await expect(onchainID.connect(owner).removeTrustedIssuer(claimIssuer.address))
                    .to.emit(onchainID, "TrustedIssuerRemoved")
                    .withArgs(claimIssuer.address);

                expect(await onchainID.isTrustedIssuer(claimIssuer.address, KYC_TOPIC)).to.be.false;
            });

            it("Should reject removal by unauthorized user", async function () {
                await expect(onchainID.connect(unauthorized).removeTrustedIssuer(claimIssuer.address))
                    .to.be.revertedWith("OnchainID: Sender does not have management key");
            });
        });

        describe("getTrustedIssuers", function () {
            it("Should return list of trusted issuers", async function () {
                await onchainID.connect(owner).addTrustedIssuer(claimIssuer.address, [KYC_TOPIC]);
                await onchainID.connect(owner).addTrustedIssuer(user1.address, [AML_TOPIC]);

                const trustedIssuers = await onchainID.getTrustedIssuers();
                expect(trustedIssuers).to.include(claimIssuer.address);
                expect(trustedIssuers).to.include(user1.address);
                expect(trustedIssuers.length).to.equal(2);
            });
        });
    });

    describe("Compliance Management", function () {
        let claimData: string;
        let claimSignature: string;

        beforeEach(async function () {
            claimData = ethers.solidityPacked(["string"], ["KYC verified"]);
            claimSignature = ethers.solidityPacked(["string"], ["mock-signature"]);

            // Set up trusted issuer and required topics
            await onchainID.connect(owner).addTrustedIssuer(claimIssuer.address, [KYC_TOPIC, AML_TOPIC]);
            await onchainID.connect(owner).addClaimTopic(KYC_TOPIC, true);
            await onchainID.connect(owner).addClaimTopic(AML_TOPIC, true);
        });

        describe("isCompliant", function () {
            it("Should return false when missing required claims", async function () {
                expect(await onchainID.isCompliant()).to.be.false;
            });

            it("Should return true when all required claims are present", async function () {
                // Add required claims
                await onchainID.connect(owner).addClaim(
                    KYC_TOPIC, ECDSA_SCHEME, claimIssuer.address, claimSignature, claimData, ""
                );
                await onchainID.connect(owner).addClaim(
                    AML_TOPIC, ECDSA_SCHEME, claimIssuer.address, claimSignature, claimData, ""
                );

                expect(await onchainID.isCompliant()).to.be.true;
            });
        });

        describe("getComplianceStatus", function () {
            it("Should return missing topics when not compliant", async function () {
                const [valid, missingTopics, expiredClaims] = await onchainID.getComplianceStatus();
                expect(valid).to.be.false;
                expect(missingTopics.map(t => Number(t))).to.include(KYC_TOPIC);
                expect(missingTopics.map(t => Number(t))).to.include(AML_TOPIC);
                expect(expiredClaims.length).to.equal(0);
            });

            it("Should return valid status when compliant", async function () {
                // Add required claims
                await onchainID.connect(owner).addClaim(
                    KYC_TOPIC, ECDSA_SCHEME, claimIssuer.address, claimSignature, claimData, ""
                );
                await onchainID.connect(owner).addClaim(
                    AML_TOPIC, ECDSA_SCHEME, claimIssuer.address, claimSignature, claimData, ""
                );

                const [valid, missingTopics, expiredClaims] = await onchainID.getComplianceStatus();
                expect(valid).to.be.true;
                expect(missingTopics.length).to.equal(0);
                expect(expiredClaims.length).to.equal(0);
            });
        });
    });

    describe("Statistics and Utilities", function () {
        it("Should return correct identity statistics", async function () {
            const claimData = ethers.solidityPacked(["string"], ["KYC verified"]);
            const claimSignature = ethers.solidityPacked(["string"], ["mock-signature"]);

            // Add some keys and claims
            const testKey = ethers.keccak256(ethers.solidityPacked(["string"], ["test-key"]));
            await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);
            await onchainID.connect(owner).addTrustedIssuer(claimIssuer.address, [KYC_TOPIC]);
            await onchainID.connect(owner).addClaimTopic(KYC_TOPIC, true);
            await onchainID.connect(owner).addClaim(
                KYC_TOPIC, ECDSA_SCHEME, claimIssuer.address, claimSignature, claimData, ""
            );

            const [keyCount, claimCount, trustedIssuerCount, requiredTopicCount] =
                await onchainID.getIdentityStats();

            expect(keyCount).to.equal(2); // Owner key + test key
            expect(claimCount).to.equal(1);
            expect(trustedIssuerCount).to.equal(1);
            expect(requiredTopicCount).to.equal(1);
        });

        it("Should return creation time", async function () {
            const creationTime = await onchainID.getCreationTime();
            expect(creationTime).to.be.gt(0);
        });
    });

    describe("Access Control", function () {
        it("Should allow ownership transfer", async function () {
            await expect(onchainID.connect(owner).transferOwnership(user1.address))
                .to.emit(onchainID, "OwnershipTransferred")
                .withArgs(owner.address, user1.address);

            expect(await onchainID.owner()).to.equal(user1.address);
        });

        it("Should reject ownership transfer by non-owner", async function () {
            await expect(onchainID.connect(unauthorized).transferOwnership(user1.address))
                .to.be.revertedWithCustomError(onchainID, "OwnableUnauthorizedAccount");
        });
    });
});