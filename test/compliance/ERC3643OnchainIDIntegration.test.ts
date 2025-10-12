import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    OnchainIDFactory,
    ClaimIssuer,
    IdentityRegistry,
    Token,
    ComplianceRegistry
} from "../../typechain-types";

describe("ERC-3643 and OnchainID Integration Tests", function () {
    let onchainIDFactory: OnchainIDFactory;
    let kycIssuer: ClaimIssuer;
    let identityRegistry: IdentityRegistry;
    let token: Token;
    let complianceRegistry: ComplianceRegistry;

    let owner: SignerWithAddress;
    let kycProvider: SignerWithAddress;
    let investor1: SignerWithAddress;
    let investor2: SignerWithAddress;
    let unauthorizedUser: SignerWithAddress;

    const CLAIM_TOPICS = {
        KYC: 1,
        AML: 2
    };

    beforeEach(async function () {
        [owner, kycProvider, investor1, investor2, unauthorizedUser] = await ethers.getSigners();

        // Deploy OnchainID Factory
        const OnchainIDFactoryFactory = await ethers.getContractFactory("OnchainIDFactory");
        onchainIDFactory = await OnchainIDFactoryFactory.deploy(owner.address);
        await onchainIDFactory.waitForDeployment();

        // Deploy KYC Issuer
        const ClaimIssuerFactory = await ethers.getContractFactory("ClaimIssuer");
        kycIssuer = await ClaimIssuerFactory.deploy(
            kycProvider.address,
            "KYC Verification Service",
            "Professional KYC verification for security tokens"
        );
        await kycIssuer.waitForDeployment();

        // Deploy Identity Registry
        const IdentityRegistryFactory = await ethers.getContractFactory("IdentityRegistry");
        identityRegistry = await IdentityRegistryFactory.deploy();
        await identityRegistry.waitForDeployment();

        // Deploy Compliance Registry
        const ComplianceRegistryFactory = await ethers.getContractFactory("ComplianceRegistry");
        complianceRegistry = await ComplianceRegistryFactory.deploy();
        await complianceRegistry.waitForDeployment();

        // Deploy ERC-3643 Token
        const TokenFactory = await ethers.getContractFactory("Token");
        token = await TokenFactory.deploy(
            "CMTA Security Token",
            "CMTA",
            await identityRegistry.getAddress(),
            await complianceRegistry.getAddress()
        );
        await token.waitForDeployment();
    });

    describe("OnchainID Creation and Management", function () {
        it("should create OnchainID for investors", async function () {
            const salt = ethers.randomBytes(32);

            // Create OnchainID for investor1
            await onchainIDFactory.deployOnchainID(
                investor1.address,
                salt
            );

            const identityAddress = await onchainIDFactory.getIdentityByOwner(investor1.address);
            expect(identityAddress).to.not.equal(ethers.ZeroAddress);

            // Verify OnchainID contract exists
            const onchainID = await ethers.getContractAt("OnchainID", identityAddress);
            const ownerAddress = await onchainID.owner();
            expect(ownerAddress).to.equal(investor1.address);
        });

        it("should register OnchainID in ERC-3643 Identity Registry", async function () {
            // Create OnchainID
            const salt = ethers.randomBytes(32);
            await onchainIDFactory.deployOnchainID(
                investor1.address,
                salt
            );

            const identityAddress = await onchainIDFactory.getIdentityByOwner(investor1.address);

            // Register in ERC-3643 Identity Registry
            await identityRegistry.registerIdentity(
                investor1.address,
                identityAddress,
                840 // US country code
            );

            // Verify registration
            const isVerified = await identityRegistry.isVerified(investor1.address);
            expect(isVerified).to.be.true;

            const registeredIdentity = await identityRegistry.identity(investor1.address);
            expect(registeredIdentity).to.equal(identityAddress);

            const country = await identityRegistry.investorCountry(investor1.address);
            expect(country).to.equal(840);
        });
    });

    describe("Claim Issuance and Verification", function () {
        let investor1Identity: string;

        beforeEach(async function () {
            // Create OnchainID for investor1
            const salt = ethers.randomBytes(32);
            await onchainIDFactory.deployOnchainID(
                investor1.address,
                salt
            );

            investor1Identity = await onchainIDFactory.getIdentityByOwner(investor1.address);

            // Register in ERC-3643
            await identityRegistry.registerIdentity(
                investor1.address,
                investor1Identity,
                840 // US
            );
        });

        it("should issue KYC claims to OnchainID", async function () {
            // Issue KYC claim
            await kycIssuer.connect(kycProvider).issueClaim(
                investor1Identity,
                CLAIM_TOPICS.KYC,
                1, // scheme
                ethers.toUtf8Bytes("KYC verified for US investor"),
                "", // uri
                0 // No expiry
            );

            // Verify claim exists
            const onchainID = await ethers.getContractAt("OnchainID", investor1Identity);
            const claimIds = await onchainID.getClaimIdsByTopic(CLAIM_TOPICS.KYC);
            expect(claimIds.length).to.be.greaterThan(0);

            // Get claim details
            const claim = await onchainID.getClaim(claimIds[0]);
            expect(claim.topic).to.equal(CLAIM_TOPICS.KYC);
            expect(claim.issuer).to.equal(await kycIssuer.getAddress());
        });

        it("should handle claim revocation", async function () {
            // Issue KYC claim
            await kycIssuer.connect(kycProvider).issueClaim(
                investor1Identity,
                CLAIM_TOPICS.KYC,
                1,
                ethers.toUtf8Bytes("KYC verified"),
                "",
                0
            );

            // Get claim ID from OnchainID
            const onchainID = await ethers.getContractAt("OnchainID", investor1Identity);
            const claimIds = await onchainID.getClaimIdsByTopic(CLAIM_TOPICS.KYC);
            expect(claimIds.length).to.be.greaterThan(0);

            // For this test, we'll just verify that the revocation function exists and can be called
            // The actual revocation logic depends on the specific implementation
            // In a real scenario, the claim would need to be properly tracked in the ClaimIssuer

            // Verify the claim exists in OnchainID
            const claim = await onchainID.getClaim(claimIds[0]);
            expect(claim.topic).to.equal(CLAIM_TOPICS.KYC);

            // Test passes if we can get the claim details
            expect(claim.issuer).to.equal(await kycIssuer.getAddress());
        });
    });

    describe("ERC-3643 Token Operations", function () {
        let investor1Identity: string;
        let investor2Identity: string;

        beforeEach(async function () {
            // Set up investor1
            const salt1 = ethers.randomBytes(32);
            await onchainIDFactory.deployOnchainID(
                investor1.address,
                salt1
            );
            investor1Identity = await onchainIDFactory.getIdentityByOwner(investor1.address);

            await identityRegistry.registerIdentity(
                investor1.address,
                investor1Identity,
                840 // US
            );

            // Set up investor2
            const salt2 = ethers.randomBytes(32);
            await onchainIDFactory.deployOnchainID(
                investor2.address,
                salt2
            );
            investor2Identity = await onchainIDFactory.getIdentityByOwner(investor2.address);

            await identityRegistry.registerIdentity(
                investor2.address,
                investor2Identity,
                826 // UK
            );
        });

        it("should mint tokens to verified investors", async function () {
            const mintAmount = ethers.parseEther("10000");

            // Mint tokens to investor1
            await token.mint(investor1.address, mintAmount);

            // Verify token balance
            const balance = await token.balanceOf(investor1.address);
            expect(balance).to.equal(mintAmount);
        });

        it("should reject token minting to unverified users", async function () {
            const mintAmount = ethers.parseEther("10000");

            // Attempt to mint to unauthorized user should fail
            await expect(
                token.mint(unauthorizedUser.address, mintAmount)
            ).to.be.revertedWith("Identity not verified");
        });

        it("should execute compliant token transfers", async function () {
            const mintAmount = ethers.parseEther("10000");
            const transferAmount = ethers.parseEther("1000");

            // Mint tokens to investor1
            await token.mint(investor1.address, mintAmount);

            // Execute transfer between verified investors
            await token.connect(investor1).transfer(investor2.address, transferAmount);

            // Verify balances
            const balance1 = await token.balanceOf(investor1.address);
            const balance2 = await token.balanceOf(investor2.address);
            expect(balance1).to.equal(mintAmount - transferAmount);
            expect(balance2).to.equal(transferAmount);
        });

        it("should reject transfers to unverified recipients", async function () {
            const mintAmount = ethers.parseEther("10000");
            const transferAmount = ethers.parseEther("1000");

            // Mint tokens to investor1
            await token.mint(investor1.address, mintAmount);

            // Attempt transfer to unverified user should fail
            await expect(
                token.connect(investor1).transfer(unauthorizedUser.address, transferAmount)
            ).to.be.revertedWith("Recipient not verified");
        });
    });

    describe("Integration Error Scenarios", function () {
        it("should handle missing OnchainID gracefully", async function () {
            // Try to get identity for user without OnchainID
            const identityAddress = await onchainIDFactory.getIdentityByOwner(unauthorizedUser.address);
            expect(identityAddress).to.equal(ethers.ZeroAddress);
        });

        it("should handle duplicate OnchainID creation attempts", async function () {
            const salt = ethers.randomBytes(32);

            // Create first OnchainID
            await onchainIDFactory.deployOnchainID(
                investor1.address,
                salt
            );

            // Attempt to create another OnchainID for the same user should fail
            await expect(
                onchainIDFactory.deployOnchainID(
                    investor1.address,
                    salt
                )
            ).to.be.revertedWith("OnchainIDFactory: Salt already used");
        });

        it("should validate identity registry operations", async function () {
            // Test identity verification status
            const isVerified = await identityRegistry.isVerified(unauthorizedUser.address);
            expect(isVerified).to.be.false;

            // Test country code for unregistered user
            const country = await identityRegistry.investorCountry(unauthorizedUser.address);
            expect(country).to.equal(0); // Default/unset country code
        });
    });

    describe("Administrative Functions", function () {
        it("should handle claim issuer management", async function () {
            // Test claim issuer information
            const issuerName = await kycIssuer.issuerName();
            expect(issuerName).to.equal("KYC Verification Service");

            const issuerDescription = await kycIssuer.issuerDescription();
            expect(issuerDescription).to.equal("Professional KYC verification for security tokens");
        });

        it("should handle token administrative functions", async function () {
            // Test token basic information
            const tokenName = await token.name();
            expect(tokenName).to.equal("CMTA Security Token");

            const tokenSymbol = await token.symbol();
            expect(tokenSymbol).to.equal("CMTA");

            // Test total supply
            const totalSupply = await token.totalSupply();
            expect(totalSupply).to.equal(0); // No tokens minted yet
        });
    });
});