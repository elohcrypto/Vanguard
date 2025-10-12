const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Enhanced Escrow System", function () {
    let vscToken;
    let factory;
    let identityRegistry;
    let complianceRules;
    let payerIdentity, payeeIdentity;
    let owner, investor, payer, payee, investorWallet, ownerWallet;
    let signers;

    const INITIAL_SUPPLY = ethers.parseEther("1000000");
    const PAYMENT_AMOUNT = ethers.parseEther("1000");
    const INVESTOR_FEE = ethers.parseEther("30"); // 3%
    const OWNER_FEE = ethers.parseEther("20"); // 2%
    const TOTAL_AMOUNT = ethers.parseEther("1050"); // 1000 + 30 + 20

    beforeEach(async function () {
        signers = await ethers.getSigners();
        [owner, investor, payer, payee, investorWallet, ownerWallet] = signers;

        // Deploy mock VSC token
        const MockToken = await ethers.getContractFactory("MockToken");
        vscToken = await MockToken.deploy("VanguardStableCoin", "VSC", INITIAL_SUPPLY);
        await vscToken.waitForDeployment();

        // Deploy IdentityRegistry for KYC/AML compliance
        const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
        identityRegistry = await IdentityRegistry.deploy();
        await identityRegistry.waitForDeployment();

        // Deploy ComplianceRules
        const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
        complianceRules = await ComplianceRules.deploy(
            owner.address,
            [840, 826, 756], // Allowed countries: USA, UK, Switzerland
            [] // No blocked countries
        );
        await complianceRules.waitForDeployment();

        // Deploy OnchainID for payer and payee
        const OnchainID = await ethers.getContractFactory("OnchainID");
        payerIdentity = await OnchainID.deploy(payer.address);
        await payerIdentity.waitForDeployment();

        payeeIdentity = await OnchainID.deploy(payee.address);
        await payeeIdentity.waitForDeployment();

        // Register payer and payee in IdentityRegistry (KYC/AML verified)
        await identityRegistry.registerIdentity(
            payer.address,
            await payerIdentity.getAddress(),
            840 // USA country code
        );

        await identityRegistry.registerIdentity(
            payee.address,
            await payeeIdentity.getAddress(),
            840 // USA country code
        );

        // Deploy EscrowWalletFactory with IdentityRegistry and ComplianceRules
        const EscrowWalletFactory = await ethers.getContractFactory("EscrowWalletFactory");
        factory = await EscrowWalletFactory.deploy(
            await vscToken.getAddress(),
            ownerWallet.address,
            await identityRegistry.getAddress(),
            await complianceRules.getAddress()
        );
        await factory.waitForDeployment();

        // Transfer tokens to payer
        await vscToken.transfer(payer.address, ethers.parseEther("10000"));
    });

    describe("Deployment", function () {
        it("Should deploy factory with correct parameters", async function () {
            expect(await factory.vscToken()).to.equal(await vscToken.getAddress());
            expect(await factory.owner()).to.equal(owner.address);
            expect(await factory.ownerWallet()).to.equal(ownerWallet.address);
        });

        it("Should have correct fee rates", async function () {
            expect(await factory.INVESTOR_FEE_RATE()).to.equal(300); // 3%
            expect(await factory.OWNER_FEE_RATE()).to.equal(200); // 2%
            expect(await factory.TOTAL_FEE_RATE()).to.equal(500); // 5%
        });
    });

    describe("Investor Registration", function () {
        it("Should register investor successfully", async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);

            const profile = await factory.getInvestorProfile(investor.address);
            expect(profile.investorAddress).to.equal(investor.address);
            expect(profile.walletAddress).to.equal(investorWallet.address);
            expect(profile.isActive).to.be.true;
            expect(profile.totalEscrowsCreated).to.equal(0);
        });

        it("Should check if address is investor", async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            expect(await factory.isInvestor(investor.address)).to.be.true;
            expect(await factory.isInvestor(payer.address)).to.be.false;
        });

        it("Should not allow duplicate registration", async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await expect(
                factory.registerInvestor(investor.address, investorWallet.address)
            ).to.be.revertedWith("Already registered");
        });

        it("Should deactivate investor", async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.deactivateInvestor(investor.address);

            expect(await factory.isInvestor(investor.address)).to.be.false;
        });
    });

    describe("Escrow Wallet Creation", function () {
        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
        });

        it("Should create escrow wallet successfully", async function () {
            const tx = await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    return factory.interface.parseLog(log).name === 'EscrowWalletCreated';
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
        });

        it("Should assign unique payment ID", async function () {
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );

            const walletAddress = await factory.getWalletAddress(1);
            expect(walletAddress).to.not.equal(ethers.ZeroAddress);
        });

        it("Should deploy wallet with correct parameters", async function () {
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );

            const walletAddress = await factory.getWalletAddress(1);
            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            const wallet = MultiSigEscrowWallet.attach(walletAddress);

            expect(await wallet.paymentId()).to.equal(1);
            expect(await wallet.payer()).to.equal(payer.address);
            expect(await wallet.payee()).to.equal(payee.address);
            expect(await wallet.investor()).to.equal(investor.address);
            expect(await wallet.amount()).to.equal(PAYMENT_AMOUNT);
            expect(await wallet.investorFee()).to.equal(INVESTOR_FEE);
            expect(await wallet.ownerFee()).to.equal(OWNER_FEE);
        });

        it("Should only allow registered investors to create wallets", async function () {
            await expect(
                factory.connect(payer).createEscrowWallet(
                    payer.address,
                    payee.address,
                    PAYMENT_AMOUNT
                )
            ).to.be.reverted;
        });

        it("Should update investor statistics", async function () {
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );

            const profile = await factory.getInvestorProfile(investor.address);
            expect(profile.totalEscrowsCreated).to.equal(1);
        });

        it("Should reject payee without KYC/AML", async function () {
            const unverifiedPayee = signers[10];

            await expect(
                factory.connect(investor).createEscrowWallet(
                    payer.address,
                    unverifiedPayee.address,
                    PAYMENT_AMOUNT
                )
            ).to.be.revertedWith("Payee must have valid KYC/AML (OnchainID)");
        });

        it("Should reject payer without KYC/AML (known payer)", async function () {
            const unverifiedPayer = signers[11];

            await expect(
                factory.connect(investor).createEscrowWallet(
                    unverifiedPayer.address,
                    payee.address,
                    PAYMENT_AMOUNT
                )
            ).to.be.revertedWith("Payer must have valid KYC/AML (OnchainID)");
        });

        it("Should allow unknown payer (address(0)) for marketplace", async function () {
            const tx = await factory.connect(investor).createEscrowWallet(
                ethers.ZeroAddress,
                payee.address,
                PAYMENT_AMOUNT
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    return factory.interface.parseLog(log).name === 'EscrowWalletCreated';
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
        });
    });

    describe("Funding Escrow Wallet", function () {
        let walletAddress;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            walletAddress = await factory.getWalletAddress(1);
        });

        it("Should fund escrow wallet successfully", async function () {
            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);

            const balance = await vscToken.balanceOf(walletAddress);
            expect(balance).to.equal(TOTAL_AMOUNT);
        });

        it("Should only allow payer to fund", async function () {
            await vscToken.connect(payee).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await expect(
                factory.connect(payee).fundEscrowWallet(1)
            ).to.be.revertedWith("Only payer can fund");
        });

        it("Should reject funding from unverified payer", async function () {
            const unverifiedPayer = signers[12];
            await vscToken.transfer(unverifiedPayer.address, TOTAL_AMOUNT);

            // Create wallet with unknown payer
            await factory.connect(investor).createEscrowWallet(
                ethers.ZeroAddress,
                payee.address,
                PAYMENT_AMOUNT
            );

            await vscToken.connect(unverifiedPayer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await expect(
                factory.connect(unverifiedPayer).fundEscrowWallet(2)
            ).to.be.revertedWith("Payer must have valid KYC/AML (OnchainID)");
        });
    });

    describe("Shipment Proof Submission", function () {
        let wallet;
        let walletAddress;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            walletAddress = await factory.getWalletAddress(1);

            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            // Fund the wallet
            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);
        });

        it("Should submit shipment proof successfully", async function () {
            const proofData = JSON.stringify({
                trackingNumber: "1Z999AA10123456784",
                carrier: "UPS",
                shipDate: "2024-01-15",
                photos: ["ipfs://Qm..."]
            });

            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));

            await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);

            const proof = await wallet.getShipmentProof();
            expect(proof.exists).to.be.true;
            expect(proof.data).to.equal(proofData);
            expect(proof.dataHash).to.equal(dataHash);
        });

        it("Should only allow payee to submit proof", async function () {
            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = "0x00";

            await expect(
                wallet.connect(payer).submitShipmentProof(proofData, dataHash, signature)
            ).to.be.revertedWith("Only payee can submit proof");
        });

        it("Should verify hash matches data", async function () {
            const proofData = "test data";
            const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong data"));
            const signature = "0x00";

            await expect(
                wallet.connect(payee).submitShipmentProof(proofData, wrongHash, signature)
            ).to.be.revertedWith("Hash mismatch");
        });
    });

    describe("Dispute Window", function () {
        let wallet;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            const walletAddress = await factory.getWalletAddress(1);

            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);

            // Submit proof
            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));
            await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);
        });

        it("Should allow payer to raise dispute within 14 days", async function () {
            await wallet.connect(payer).raiseDispute();
            expect(await wallet.state()).to.equal(3); // Disputed
        });

        it("Should not allow dispute after 14 days", async function () {
            await time.increase(15 * 24 * 60 * 60); // 15 days

            await expect(
                wallet.connect(payer).raiseDispute()
            ).to.be.revertedWith("Dispute window closed");
        });

        it("Should check if dispute window is open", async function () {
            expect(await wallet.isDisputeWindowOpen()).to.be.true;

            await time.increase(15 * 24 * 60 * 60);
            expect(await wallet.isDisputeWindowOpen()).to.be.false;
        });
    });

    describe("Dispute Resolution", function () {
        let wallet;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            const walletAddress = await factory.getWalletAddress(1);

            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);

            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));
            await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);

            await wallet.connect(payer).raiseDispute();
        });

        it("Should allow investor to resolve dispute with refund", async function () {
            const payerBalanceBefore = await vscToken.balanceOf(payer.address);

            await wallet.connect(investor).resolveDispute(true);

            const payerBalanceAfter = await vscToken.balanceOf(payer.address);
            expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
            expect(await wallet.state()).to.equal(2); // Refunded
        });

        it("Should allow investor to resolve dispute without refund", async function () {
            await wallet.connect(investor).resolveDispute(false);
            expect(await wallet.state()).to.equal(0); // Active
        });

        it("Should only allow investor to resolve", async function () {
            await expect(
                wallet.connect(payer).resolveDispute(true)
            ).to.be.revertedWith("Only investor can resolve");
        });
    });

    describe("Multi-Signature Release (2-of-3)", function () {
        let wallet;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            const walletAddress = await factory.getWalletAddress(1);

            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);

            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));
            await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);

            // Wait 14 days
            await time.increase(15 * 24 * 60 * 60);
        });

        it("Should allow payer to sign (for refund path)", async function () {
            await wallet.connect(payer).signAsPayer();
            expect(await wallet.payerSigned()).to.be.true;
        });

        it("Should allow payee to sign after dispute window", async function () {
            await wallet.connect(payee).signAsPayee();
            expect(await wallet.payeeSigned()).to.be.true;
        });

        it("Should allow investor to sign", async function () {
            await wallet.connect(investor).signAsInvestor();
            expect(await wallet.investorSigned()).to.be.true;
        });

        it("Should not allow payee signing during dispute window", async function () {
            // Create new wallet
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            const walletAddress2 = await factory.getWalletAddress(2);
            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            const wallet2 = MultiSigEscrowWallet.attach(walletAddress2);

            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(2);

            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));
            await wallet2.connect(payee).submitShipmentProof(proofData, dataHash, signature);

            await expect(
                wallet2.connect(payee).signAsPayee()
            ).to.be.revertedWith("Dispute window still open");
        });

        it("Should auto-release to payee when investor + payee sign", async function () {
            const payeeBalanceBefore = await vscToken.balanceOf(payee.address);
            const investorBalanceBefore = await vscToken.balanceOf(investorWallet.address);
            const ownerBalanceBefore = await vscToken.balanceOf(ownerWallet.address);

            await wallet.connect(payee).signAsPayee();
            await wallet.connect(investor).signAsInvestor();

            const payeeBalanceAfter = await vscToken.balanceOf(payee.address);
            const investorBalanceAfter = await vscToken.balanceOf(investorWallet.address);
            const ownerBalanceAfter = await vscToken.balanceOf(ownerWallet.address);

            expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(PAYMENT_AMOUNT);
            expect(investorBalanceAfter - investorBalanceBefore).to.equal(INVESTOR_FEE);
            expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(OWNER_FEE);
            expect(await wallet.state()).to.equal(1); // Released
        });

        it("Should auto-refund to payer when investor + payer sign", async function () {
            const payerBalanceBefore = await vscToken.balanceOf(payer.address);

            await wallet.connect(payer).signAsPayer();
            await wallet.connect(investor).signAsInvestor();

            const payerBalanceAfter = await vscToken.balanceOf(payer.address);
            expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
            expect(await wallet.state()).to.equal(2); // Refunded
        });

        it("Should prioritize payee release if investor signs after payee", async function () {
            const payeeBalanceBefore = await vscToken.balanceOf(payee.address);

            await wallet.connect(payee).signAsPayee();
            await wallet.connect(investor).signAsInvestor();

            const payeeBalanceAfter = await vscToken.balanceOf(payee.address);
            expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(PAYMENT_AMOUNT);
            expect(await wallet.state()).to.equal(1); // Released
        });

        it("Should refund if investor signs after payer", async function () {
            const payerBalanceBefore = await vscToken.balanceOf(payer.address);

            await wallet.connect(payer).signAsPayer();
            await wallet.connect(investor).signAsInvestor();

            const payerBalanceAfter = await vscToken.balanceOf(payer.address);
            expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
            expect(await wallet.state()).to.equal(2); // Refunded
        });

        it("Should check if ready for signatures", async function () {
            expect(await wallet.isReadyForSignatures()).to.be.true;
        });
    });

    describe("Manual Refund", function () {
        let wallet;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            const walletAddress = await factory.getWalletAddress(1);

            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);
        });

        it("Should allow investor to manually refund", async function () {
            const payerBalanceBefore = await vscToken.balanceOf(payer.address);

            await wallet.connect(investor).manualRefund();

            const payerBalanceAfter = await vscToken.balanceOf(payer.address);
            expect(payerBalanceAfter - payerBalanceBefore).to.equal(TOTAL_AMOUNT);
            expect(await wallet.state()).to.equal(2); // Refunded
        });

        it("Should only allow investor to manually refund", async function () {
            await expect(
                wallet.connect(payer).manualRefund()
            ).to.be.revertedWith("Only investor can refund");
        });
    });

    describe("Fee Calculation", function () {
        it("Should calculate fees correctly", async function () {
            const fees = await factory.calculateFees(PAYMENT_AMOUNT);

            expect(fees.investorFee).to.equal(INVESTOR_FEE);
            expect(fees.ownerFee).to.equal(OWNER_FEE);
            expect(fees.totalFee).to.equal(INVESTOR_FEE + OWNER_FEE);
            expect(fees.totalAmount).to.equal(TOTAL_AMOUNT);
        });
    });

    describe("Unknown Payer (Marketplace Scenario)", function () {
        let wallet;
        let walletAddress;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
        });

        it("Should create wallet with unknown payer (address(0))", async function () {
            await factory.connect(investor).createEscrowWallet(
                ethers.ZeroAddress,  // Unknown payer
                payee.address,
                PAYMENT_AMOUNT
            );

            walletAddress = await factory.getWalletAddress(1);
            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            expect(await wallet.payer()).to.equal(ethers.ZeroAddress);
            expect(await wallet.payerSet()).to.be.false;
        });

        it("Should set payer on first funding", async function () {
            await factory.connect(investor).createEscrowWallet(
                ethers.ZeroAddress,
                payee.address,
                PAYMENT_AMOUNT
            );

            walletAddress = await factory.getWalletAddress(1);
            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            // First buyer funds (becomes the payer automatically)
            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);

            expect(await wallet.payer()).to.equal(payer.address);
            expect(await wallet.payerSet()).to.be.true;
        });

        it("Should not allow setting payer twice", async function () {
            await factory.connect(investor).createEscrowWallet(
                ethers.ZeroAddress,
                payee.address,
                PAYMENT_AMOUNT
            );

            walletAddress = await factory.getWalletAddress(1);
            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            await wallet.connect(investor).setPayer(payer.address);

            await expect(
                wallet.connect(investor).setPayer(payee.address)
            ).to.be.revertedWith("Payer already set");
        });

        it("Should complete marketplace flow with unknown payer", async function () {
            // Create wallet for seller (payer unknown)
            await factory.connect(investor).createEscrowWallet(
                ethers.ZeroAddress,
                payee.address,
                PAYMENT_AMOUNT
            );

            walletAddress = await factory.getWalletAddress(1);
            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            // Buyer pays (becomes payer automatically via factory)
            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);

            // Verify payer was set
            expect(await wallet.payer()).to.equal(payer.address);
            expect(await wallet.payerSet()).to.be.true;

            // Seller ships
            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));
            await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);

            // Wait 14 days
            await time.increase(15 * 24 * 60 * 60);

            // Both sign
            const payeeBalanceBefore = await vscToken.balanceOf(payee.address);
            await wallet.connect(payee).signAsPayee();
            await wallet.connect(investor).signAsInvestor();

            const payeeBalanceAfter = await vscToken.balanceOf(payee.address);
            expect(payeeBalanceAfter - payeeBalanceBefore).to.equal(PAYMENT_AMOUNT);
        });
    });

    describe("Wallet Status", function () {
        let wallet;

        beforeEach(async function () {
            await factory.registerInvestor(investor.address, investorWallet.address);
            await factory.connect(investor).createEscrowWallet(
                payer.address,
                payee.address,
                PAYMENT_AMOUNT
            );
            const walletAddress = await factory.getWalletAddress(1);

            const MultiSigEscrowWallet = await ethers.getContractFactory("MultiSigEscrowWallet");
            wallet = MultiSigEscrowWallet.attach(walletAddress);

            await vscToken.connect(payer).approve(await factory.getAddress(), TOTAL_AMOUNT);
            await factory.connect(payer).fundEscrowWallet(1);
        });

        it("Should get wallet status correctly", async function () {
            const status = await wallet.getWalletStatus();

            expect(status.currentState).to.equal(0); // Active
            expect(status.payerIsSet).to.be.true;
            expect(status.proofSubmitted).to.be.false;
            expect(status.disputeWindowOpen).to.be.false;
            expect(status.readyForSignatures).to.be.false;
            expect(status.payerHasSigned).to.be.false;
            expect(status.payeeHasSigned).to.be.false;
            expect(status.investorHasSigned).to.be.false;
        });

        it("Should update status after proof submission", async function () {
            const proofData = "test";
            const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
            const signature = await payee.signMessage(ethers.getBytes(dataHash));
            await wallet.connect(payee).submitShipmentProof(proofData, dataHash, signature);

            const status = await wallet.getWalletStatus();

            expect(status.proofSubmitted).to.be.true;
            expect(status.disputeWindowOpen).to.be.true;
            expect(status.readyForSignatures).to.be.false;
        });
    });
});

