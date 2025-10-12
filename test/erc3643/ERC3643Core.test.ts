import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    Token,
    IdentityRegistry,
    ComplianceRegistry,
    TrustedIssuersRegistry,
    ClaimTopicsRegistry,
    OnchainIDFactory,
    OnchainID,
    ClaimIssuer
} from "../../typechain-types";

describe("ERC-3643 Core Implementation", function () {
    let token: Token;
    let identityRegistry: IdentityRegistry;
    let complianceRegistry: ComplianceRegistry;
    let trustedIssuersRegistry: TrustedIssuersRegistry;
    let claimTopicsRegistry: ClaimTopicsRegistry;
    let onchainIDFactory: OnchainIDFactory;
    let claimIssuer: ClaimIssuer;

    let owner: SignerWithAddress;
    let investor1: SignerWithAddress;
    let investor2: SignerWithAddress;
    let agent: SignerWithAddress;

    let investor1OnchainID: OnchainID;
    let investor2OnchainID: OnchainID;

    const CLAIM_TOPIC_KYC = 1;
    const CLAIM_TOPIC_AML = 2;
    const COUNTRY_US = 840;
    const COUNTRY_UK = 826;

    beforeEach(async function () {
        [owner, investor1, investor2, agent] = await ethers.getSigners();

        // Deploy OnchainID system
        const OnchainIDFactory = await ethers.getContractFactory("OnchainIDFactory");
        onchainIDFactory = await OnchainIDFactory.deploy(owner.address);

        const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
        claimIssuer = await ClaimIssuer.deploy(owner.address, "Test Claim Issuer", "Test issuer for ERC-3643 compliance");

        // Deploy ERC-3643 registries
        const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
        identityRegistry = await IdentityRegistry.deploy();
        await identityRegistry.waitForDeployment();

        const identityRegistryAddress = await identityRegistry.getAddress();

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
        complianceRegistry = await ComplianceRegistry.deploy();
        await complianceRegistry.waitForDeployment();

        const TrustedIssuersRegistry = await ethers.getContractFactory("TrustedIssuersRegistry");
        trustedIssuersRegistry = await TrustedIssuersRegistry.deploy();
        await trustedIssuersRegistry.waitForDeployment();

        const ClaimTopicsRegistry = await ethers.getContractFactory("ClaimTopicsRegistry");
        claimTopicsRegistry = await ClaimTopicsRegistry.deploy();
        await claimTopicsRegistry.waitForDeployment();

        // Deploy ERC-3643 Token
        const Token = await ethers.getContractFactory("Token");
        const complianceRegistryAddress = await complianceRegistry.getAddress();
        token = await Token.deploy(
            "Test Security Token",
            "TST",
            identityRegistryAddress,
            complianceRegistryAddress
        );

        // Note: Mock ComplianceRegistry doesn't need token binding

        // Add agent
        await token.addAgent(agent.address);
        await identityRegistry.addAgent(agent.address);

        // Setup trusted issuers and claim topics
        await trustedIssuersRegistry.addTrustedIssuer(
            await claimIssuer.getAddress(),
            [CLAIM_TOPIC_KYC, CLAIM_TOPIC_AML]
        );
        await claimTopicsRegistry.addClaimTopic(CLAIM_TOPIC_KYC);
        await claimTopicsRegistry.addClaimTopic(CLAIM_TOPIC_AML);

        // Create OnchainIDs for investors
        const salt1 = ethers.randomBytes(32);
        const salt2 = ethers.randomBytes(32);

        // Deploy OnchainIDs with deployment fee
        const deploymentFee = ethers.parseEther("0.01"); // Assuming small fee
        await onchainIDFactory.deployOnchainID(investor1.address, salt1, { value: deploymentFee });
        await onchainIDFactory.deployOnchainID(investor2.address, salt2, { value: deploymentFee });

        const investor1OnchainIDAddress = await onchainIDFactory.getIdentityByOwner(investor1.address);
        const investor2OnchainIDAddress = await onchainIDFactory.getIdentityByOwner(investor2.address);

        investor1OnchainID = await ethers.getContractAt("OnchainID", investor1OnchainIDAddress);
        investor2OnchainID = await ethers.getContractAt("OnchainID", investor2OnchainIDAddress);

        // Register identities
        await identityRegistry.connect(agent).registerIdentity(
            investor1.address,
            investor1OnchainIDAddress,
            COUNTRY_US
        );
        await identityRegistry.connect(agent).registerIdentity(
            investor2.address,
            investor2OnchainIDAddress,
            COUNTRY_UK
        );
    });

    describe("Identity Registry", function () {
        it("Should register investor identities correctly", async function () {
            expect(await identityRegistry.isVerified(investor1.address)).to.be.true;
            expect(await identityRegistry.isVerified(investor2.address)).to.be.true;

            expect(await identityRegistry.identity(investor1.address)).to.equal(
                await investor1OnchainID.getAddress()
            );
            expect(await identityRegistry.investorCountry(investor1.address)).to.equal(COUNTRY_US);
        });

        it("Should prevent unauthorized identity registration", async function () {
            await expect(
                identityRegistry.connect(investor1).registerIdentity(
                    investor1.address,
                    await investor1OnchainID.getAddress(),
                    COUNTRY_US
                )
            ).to.be.revertedWith("Not authorized agent");
        });
    });

    describe("Token Operations", function () {
        it("Should mint tokens to verified investors", async function () {
            const mintAmount = ethers.parseEther("1000");

            await token.connect(agent).mint(investor1.address, mintAmount);

            expect(await token.balanceOf(investor1.address)).to.equal(mintAmount);
        });

        it("Should prevent minting to unverified addresses", async function () {
            const mintAmount = ethers.parseEther("1000");
            const unverifiedAddress = ethers.Wallet.createRandom().address;

            await expect(
                token.connect(agent).mint(unverifiedAddress, mintAmount)
            ).to.be.revertedWith("Identity not verified");
        });

        it("Should allow transfers between verified investors", async function () {
            const mintAmount = ethers.parseEther("1000");
            const transferAmount = ethers.parseEther("100");

            // Mint tokens to investor1
            await token.connect(agent).mint(investor1.address, mintAmount);

            // Transfer from investor1 to investor2
            await token.connect(investor1).transfer(investor2.address, transferAmount);

            expect(await token.balanceOf(investor1.address)).to.equal(mintAmount - transferAmount);
            expect(await token.balanceOf(investor2.address)).to.equal(transferAmount);
        });

        it("Should prevent transfers to unverified addresses", async function () {
            const mintAmount = ethers.parseEther("1000");
            const transferAmount = ethers.parseEther("100");
            const unverifiedAddress = ethers.Wallet.createRandom().address;

            await token.connect(agent).mint(investor1.address, mintAmount);

            await expect(
                token.connect(investor1).transfer(unverifiedAddress, transferAmount)
            ).to.be.revertedWith("Recipient not verified");
        });
    });

    describe("Compliance Features", function () {
        it("Should check transfer compliance correctly", async function () {
            // First mint some tokens to investor1
            await token.connect(agent).mint(investor1.address, ethers.parseEther("1000"));

            expect(await token.canTransfer(investor1.address, investor2.address, ethers.parseEther("100"))).to.be.true;

            const unverifiedAddress = ethers.Wallet.createRandom().address;
            // canTransfer may revert instead of returning false for unverified addresses
            try {
                const result = await token.canTransfer(investor1.address, unverifiedAddress, ethers.parseEther("100"));
                expect(result).to.be.false;
            } catch (error: any) {
                // Expected to revert with "Recipient not verified"
                expect(error.message).to.include("Recipient not verified");
            }
        });

        it("Should freeze and unfreeze addresses", async function () {
            const mintAmount = ethers.parseEther("1000");
            await token.connect(agent).mint(investor1.address, mintAmount);

            // Freeze address
            await token.connect(agent).setAddressFrozen(investor1.address, true);
            expect(await token.isFrozen(investor1.address)).to.be.true;

            // Should prevent transfers from frozen address
            await expect(
                token.connect(investor1).transfer(investor2.address, ethers.parseEther("100"))
            ).to.be.revertedWith("Address is frozen");

            // Unfreeze address
            await token.connect(agent).setAddressFrozen(investor1.address, false);
            expect(await token.isFrozen(investor1.address)).to.be.false;

            // Should allow transfers again
            await token.connect(investor1).transfer(investor2.address, ethers.parseEther("100"));
            expect(await token.balanceOf(investor2.address)).to.equal(ethers.parseEther("100"));
        });

        it("Should freeze and unfreeze partial tokens", async function () {
            const mintAmount = ethers.parseEther("1000");
            const freezeAmount = ethers.parseEther("500");

            await token.connect(agent).mint(investor1.address, mintAmount);

            // Freeze partial tokens
            await token.connect(agent).freezePartialTokens(investor1.address, freezeAmount);
            expect(await token.frozenTokens(investor1.address)).to.equal(freezeAmount);
            expect(await token.getFreeBalance(investor1.address)).to.equal(mintAmount - freezeAmount);

            // Should prevent transfers exceeding free balance
            await expect(
                token.connect(investor1).transfer(investor2.address, ethers.parseEther("600"))
            ).to.be.revertedWith("Insufficient balance");

            // Should allow transfers within free balance
            await token.connect(investor1).transfer(investor2.address, ethers.parseEther("400"));
            expect(await token.balanceOf(investor1.address)).to.equal(ethers.parseEther("600"));
            expect(await token.getFreeBalance(investor1.address)).to.equal(ethers.parseEther("100"));
        });
    });

    describe("Registry Management", function () {
        it("Should manage trusted issuers correctly", async function () {
            const trustedIssuers = await trustedIssuersRegistry.getTrustedIssuers();
            expect(trustedIssuers).to.include(await claimIssuer.getAddress());

            expect(await trustedIssuersRegistry.isTrustedIssuer(await claimIssuer.getAddress())).to.be.true;

            const claimTopics = await trustedIssuersRegistry.getTrustedIssuerClaimTopics(await claimIssuer.getAddress());
            expect(claimTopics).to.include(BigInt(CLAIM_TOPIC_KYC));
            expect(claimTopics).to.include(BigInt(CLAIM_TOPIC_AML));
        });

        it("Should manage claim topics correctly", async function () {
            const claimTopics = await claimTopicsRegistry.getClaimTopics();
            expect(claimTopics).to.include(BigInt(CLAIM_TOPIC_KYC));
            expect(claimTopics).to.include(BigInt(CLAIM_TOPIC_AML));

            expect(await claimTopicsRegistry.isClaimTopicRequired(CLAIM_TOPIC_KYC)).to.be.true;
            expect(await claimTopicsRegistry.isClaimTopicRequired(999)).to.be.false;
        });
    });

    describe("Pause Functionality", function () {
        it("Should pause and unpause token operations", async function () {
            const mintAmount = ethers.parseEther("1000");

            // Mint tokens first
            await token.connect(agent).mint(investor1.address, mintAmount);

            // Pause token
            await token.pause();
            expect(await token.paused()).to.be.true;

            // Should prevent operations when paused
            await expect(
                token.connect(agent).mint(investor2.address, mintAmount)
            ).to.be.revertedWithCustomError(token, "EnforcedPause");

            await expect(
                token.connect(investor1).transfer(investor2.address, ethers.parseEther("100"))
            ).to.be.revertedWithCustomError(token, "EnforcedPause");

            // Unpause token
            await token.unpause();
            expect(await token.paused()).to.be.false;

            // Should allow operations again
            await token.connect(investor1).transfer(investor2.address, ethers.parseEther("100"));
            expect(await token.balanceOf(investor2.address)).to.equal(ethers.parseEther("100"));
        });
    });
});