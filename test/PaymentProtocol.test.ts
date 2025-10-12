import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
    VanguardPaymentProtocol,
    PaymentEscrow,
    RefundManager
} from "../typechain-types";

// Import mock contracts directly
import { MockToken } from "../typechain-types/contracts/test/mocks/MockToken";
import { MockIdentityRegistry } from "../typechain-types/contracts/test/mocks/MockIdentityRegistry";
import { MockComplianceRules } from "../typechain-types/contracts/test/mocks/MockComplianceRules";
import { MockOracleManager } from "../typechain-types/contracts/test/mocks/MockOracleManager";

describe("Payment Protocol System", function () {
    let paymentProtocol: VanguardPaymentProtocol;
    let paymentEscrow: PaymentEscrow;
    let refundManager: RefundManager;
    let vscToken: MockToken;
    let identityRegistry: MockIdentityRegistry;
    let complianceRules: MockComplianceRules;
    let oracleManager: MockOracleManager;

    let owner: SignerWithAddress;
    let tokenIssuer: SignerWithAddress;
    let payer: SignerWithAddress;
    let payee: SignerWithAddress;
    let complianceOfficer: SignerWithAddress;
    let oracle: SignerWithAddress;

    const INITIAL_SUPPLY = ethers.parseEther("1000000"); // 1M VSC
    const PAYMENT_AMOUNT = ethers.parseEther("1000"); // 1K VSC
    const ESCROW_FEE_RATE = 10; // 0.1%

    beforeEach(async function () {
        [owner, tokenIssuer, payer, payee, complianceOfficer, oracle] = await ethers.getSigners();

        // Deploy VSC Token (using MockToken for testing)
        const TokenFactory = await ethers.getContractFactory("contracts/test/mocks/MockToken.sol:MockToken");
        vscToken = await TokenFactory.deploy("Vanguard StableCoin", "VSC", INITIAL_SUPPLY);
        await vscToken.waitForDeployment();

        // Deploy MockIdentityRegistry
        const IdentityRegistryFactory = await ethers.getContractFactory("contracts/test/mocks/MockIdentityRegistry.sol:MockIdentityRegistry");
        identityRegistry = await IdentityRegistryFactory.deploy();
        await identityRegistry.waitForDeployment();

        // Deploy MockComplianceRules
        const ComplianceRulesFactory = await ethers.getContractFactory("contracts/test/mocks/MockComplianceRules.sol:MockComplianceRules");
        complianceRules = await ComplianceRulesFactory.deploy();
        await complianceRules.waitForDeployment();

        // Deploy MockOracleManager
        const OracleManagerFactory = await ethers.getContractFactory("contracts/test/mocks/MockOracleManager.sol:MockOracleManager");
        oracleManager = await OracleManagerFactory.deploy();
        await oracleManager.waitForDeployment();

        // Deploy VanguardPaymentProtocol first
        const PaymentProtocolFactory = await ethers.getContractFactory("VanguardPaymentProtocol");
        paymentProtocol = await PaymentProtocolFactory.deploy(
            await vscToken.getAddress(),
            await complianceRules.getAddress(),
            await oracleManager.getAddress(),
            await identityRegistry.getAddress()
        );
        await paymentProtocol.waitForDeployment();

        // Deploy PaymentEscrow with PaymentProtocol address
        const PaymentEscrowFactory = await ethers.getContractFactory("PaymentEscrow");
        paymentEscrow = await PaymentEscrowFactory.deploy(
            await vscToken.getAddress(),
            await paymentProtocol.getAddress()
        );
        await paymentEscrow.waitForDeployment();

        // Deploy RefundManager
        const RefundManagerFactory = await ethers.getContractFactory("RefundManager");
        refundManager = await RefundManagerFactory.deploy(
            await paymentProtocol.getAddress(),
            await paymentEscrow.getAddress()
        );
        await refundManager.waitForDeployment();

        // Set up contract connections
        await paymentProtocol.setPaymentEscrow(await paymentEscrow.getAddress());
        await paymentProtocol.setRefundManager(await refundManager.getAddress());

        // Set up identities and compliance
        await identityRegistry.registerIdentity(payer.address, payer.address, 840); // US
        await identityRegistry.registerIdentity(payee.address, payee.address, 840); // US

        // Set compliance status for both parties
        await complianceRules.setCompliant(payer.address, true);
        await complianceRules.setCompliant(payee.address, true);

        // Transfer tokens to payer (owner minted them in constructor)
        await vscToken.transfer(payer.address, INITIAL_SUPPLY);

        // Approve payment protocol to spend tokens
        await vscToken.connect(payer).approve(await paymentProtocol.getAddress(), INITIAL_SUPPLY);
    });

    describe("Contract Deployment", function () {
        it("Should deploy all contracts successfully", async function () {
            expect(await paymentProtocol.vscToken()).to.equal(await vscToken.getAddress());
            expect(await paymentEscrow.vscToken()).to.equal(await vscToken.getAddress());
            expect(await refundManager.paymentProtocol()).to.equal(await paymentProtocol.getAddress());
        });

        it("Should have correct initial settings", async function () {
            const settings = await paymentProtocol.paymentSettings();
            expect(settings.confirmationPeriod).to.equal(24 * 60 * 60); // 24 hours
            expect(settings.disputeWindow).to.equal(7 * 24 * 60 * 60); // 7 days
            expect(settings.maxPaymentAmount).to.equal(ethers.parseEther("50000")); // 50K VSC
            expect(settings.minPaymentAmount).to.equal(ethers.parseEther("1")); // 1 VSC
            expect(settings.escrowFeeRate).to.equal(10); // 0.1%
        });
    });

    describe("Payment Initiation", function () {
        it("Should initiate payment successfully", async function () {
            const paymentReason = "Service payment for consulting";

            const tx = await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                paymentReason
            );

            await expect(tx)
                .to.emit(paymentProtocol, "PaymentInitiated")
                .withArgs(1, payer.address, payee.address, PAYMENT_AMOUNT, paymentReason);

            // Check payment details
            const payment = await paymentProtocol.getPayment(1);
            expect(payment.payer).to.equal(payer.address);
            expect(payment.payee).to.equal(payee.address);
            expect(payment.amount).to.equal(PAYMENT_AMOUNT);
            expect(payment.state).to.equal(0); // Pending
            expect(payment.paymentReason).to.equal(paymentReason);
        });

        it("Should create escrow when payment is initiated", async function () {
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );

            // Check escrow was created
            const escrowId = await paymentEscrow.getEscrowByPayment(1);
            expect(escrowId).to.equal(1);

            const escrowDetails = await paymentEscrow.getEscrowDetails(1);
            expect(escrowDetails.payer).to.equal(payer.address);
            expect(escrowDetails.payee).to.equal(payee.address);
            expect(escrowDetails.amount).to.equal(PAYMENT_AMOUNT);
            expect(escrowDetails.state).to.equal(0); // Active
        });

        it("Should transfer tokens to escrow", async function () {
            const initialBalance = await vscToken.balanceOf(payer.address);
            const escrowFee = (PAYMENT_AMOUNT * BigInt(ESCROW_FEE_RATE)) / BigInt(10000);
            const totalAmount = PAYMENT_AMOUNT + escrowFee;

            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );

            // Check balances
            expect(await vscToken.balanceOf(payer.address)).to.equal(initialBalance - totalAmount);
            expect(await vscToken.balanceOf(await paymentEscrow.getAddress())).to.equal(totalAmount);
        });

        it("Should reject invalid payment parameters", async function () {
            // Invalid payee
            await expect(
                paymentProtocol.connect(payer).initiatePayment(
                    ethers.ZeroAddress,
                    PAYMENT_AMOUNT,
                    "Test payment"
                )
            ).to.be.revertedWith("Invalid payee");

            // Self payment
            await expect(
                paymentProtocol.connect(payer).initiatePayment(
                    payer.address,
                    PAYMENT_AMOUNT,
                    "Test payment"
                )
            ).to.be.revertedWith("Cannot pay yourself");

            // Amount too small
            await expect(
                paymentProtocol.connect(payer).initiatePayment(
                    payee.address,
                    ethers.parseEther("0.5"), // Less than 1 VSC minimum
                    "Test payment"
                )
            ).to.be.revertedWith("Amount too small");

            // Empty reason
            await expect(
                paymentProtocol.connect(payer).initiatePayment(
                    payee.address,
                    PAYMENT_AMOUNT,
                    ""
                )
            ).to.be.revertedWith("Payment reason required");
        });
    });

    describe("Payment Confirmation", function () {
        beforeEach(async function () {
            // Initiate a payment
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );
        });

        it("Should confirm payment successfully", async function () {
            const tx = await paymentProtocol.connect(payee).confirmPayment(1);

            await expect(tx)
                .to.emit(paymentProtocol, "PaymentConfirmed")
                .withArgs(1, payee.address, await time.latest());

            // Check payment state
            const payment = await paymentProtocol.getPayment(1);
            expect(payment.state).to.equal(1); // Confirmed
            expect(payment.disputeDeadline).to.be.gt(0);
        });

        it("Should release funds to payee on confirmation", async function () {
            const initialPayeeBalance = await vscToken.balanceOf(payee.address);

            await paymentProtocol.connect(payee).confirmPayment(1);

            // Check payee received the payment amount (not the fee)
            expect(await vscToken.balanceOf(payee.address)).to.equal(initialPayeeBalance + PAYMENT_AMOUNT);
        });

        it("Should reject confirmation from non-payee", async function () {
            await expect(
                paymentProtocol.connect(payer).confirmPayment(1)
            ).to.be.revertedWith("Only payee can confirm");
        });

        it("Should reject confirmation after deadline", async function () {
            // Fast forward past confirmation deadline (24 hours)
            await time.increase(25 * 60 * 60); // 25 hours

            await expect(
                paymentProtocol.connect(payee).confirmPayment(1)
            ).to.be.revertedWith("Confirmation period expired");
        });
    });

    describe("Payment Cancellation", function () {
        beforeEach(async function () {
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );
        });

        it("Should cancel payment successfully", async function () {
            const tx = await paymentProtocol.connect(payer).cancelPayment(1);

            await expect(tx)
                .to.emit(paymentProtocol, "PaymentCancelled")
                .withArgs(1, payer.address);

            // Check payment state (should be Cancelled = 5, but might be Refunded = 3 due to automatic refund)
            const payment = await paymentProtocol.getPayment(1);
            expect(payment.state).to.equal(3); // Refunded (due to automatic refund processing)
        });

        it("Should refund tokens on cancellation", async function () {
            const initialBalance = await vscToken.balanceOf(payer.address);
            const escrowFee = (PAYMENT_AMOUNT * BigInt(ESCROW_FEE_RATE)) / BigInt(10000);
            const totalAmount = PAYMENT_AMOUNT + escrowFee;

            await paymentProtocol.connect(payer).cancelPayment(1);

            // Should get full refund including fee
            expect(await vscToken.balanceOf(payer.address)).to.equal(initialBalance + totalAmount);
        });

        it("Should reject cancellation from non-payer", async function () {
            await expect(
                paymentProtocol.connect(payee).cancelPayment(1)
            ).to.be.revertedWith("Only payer can cancel");
        });

        it("Should reject cancellation after confirmation", async function () {
            // Confirm payment first
            await paymentProtocol.connect(payee).confirmPayment(1);

            await expect(
                paymentProtocol.connect(payer).cancelPayment(1)
            ).to.be.revertedWith("Payment not pending");
        });
    });

    describe("Payment Disputes", function () {
        beforeEach(async function () {
            // Initiate and confirm payment
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );
            await paymentProtocol.connect(payee).confirmPayment(1);
        });

        it("Should file dispute successfully", async function () {
            const disputeReason = "Service not delivered as promised";

            const tx = await paymentProtocol.connect(payer).disputePayment(1, disputeReason);

            await expect(tx)
                .to.emit(paymentProtocol, "PaymentDisputed")
                .withArgs(1, payer.address, disputeReason);

            // Check payment state
            const payment = await paymentProtocol.getPayment(1);
            expect(payment.state).to.equal(2); // Disputed
        });

        it("Should reject dispute from non-payer", async function () {
            await expect(
                paymentProtocol.connect(payee).disputePayment(1, "Invalid dispute")
            ).to.be.revertedWith("Only payer can dispute");
        });

        it("Should reject dispute after deadline", async function () {
            // Fast forward past dispute deadline (7 days)
            await time.increase(8 * 24 * 60 * 60); // 8 days

            await expect(
                paymentProtocol.connect(payer).disputePayment(1, "Late dispute")
            ).to.be.revertedWith("Dispute window expired");
        });

        it("Should reject dispute without reason", async function () {
            await expect(
                paymentProtocol.connect(payer).disputePayment(1, "")
            ).to.be.revertedWith("Dispute reason required");
        });
    });

    describe("Refund Management", function () {
        beforeEach(async function () {
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );
        });

        it("Should process automatic refund on cancellation", async function () {
            const initialBalance = await vscToken.balanceOf(payer.address);

            await paymentProtocol.connect(payer).cancelPayment(1);

            // Check refund was processed
            const refunds = await refundManager.getRefundsByPayment(1);
            expect(refunds.length).to.equal(1);

            const refund = await refundManager.getRefundRequest(refunds[0]);
            expect(refund.refundType).to.equal(0); // Automatic
            expect(refund.processed).to.be.true;
        });

        it("Should handle manual refund requests", async function () {
            // Confirm payment first
            await paymentProtocol.connect(payee).confirmPayment(1);

            // Request manual refund
            const tx = await refundManager.connect(payer).requestRefund(
                1,
                1, // Manual
                1, // MutualAgreement
                "Both parties agreed to refund",
                ethers.keccak256(ethers.toUtf8Bytes("evidence"))
            );

            await expect(tx).to.emit(refundManager, "RefundRequested");

            const refunds = await refundManager.getRefundsByPayment(1);
            expect(refunds.length).to.equal(1);

            const refund = await refundManager.getRefundRequest(refunds[0]);
            expect(refund.refundType).to.equal(1); // Manual
            expect(refund.approved).to.be.false; // Needs approval
        });

        it("Should process emergency refund", async function () {
            const initialBalance = await vscToken.balanceOf(payer.address);

            // Emergency refund by owner (token issuer)
            const tx = await refundManager.connect(owner).emergencyRefund(
                1,
                payer.address,
                4, // EmergencyAction
                "Emergency refund due to system issue"
            );

            await expect(tx).to.emit(refundManager, "EmergencyRefundExecuted");

            // Check tokens were refunded
            const escrowFee = (PAYMENT_AMOUNT * BigInt(ESCROW_FEE_RATE)) / BigInt(10000);
            const totalAmount = PAYMENT_AMOUNT + escrowFee;
            expect(await vscToken.balanceOf(payer.address)).to.equal(initialBalance + totalAmount);
        });
    });

    describe("Escrow Management", function () {
        beforeEach(async function () {
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );
        });

        it("Should calculate escrow fee correctly", async function () {
            const expectedFee = (PAYMENT_AMOUNT * BigInt(ESCROW_FEE_RATE)) / BigInt(10000);
            const calculatedFee = await paymentEscrow.calculateEscrowFee(PAYMENT_AMOUNT);
            expect(calculatedFee).to.equal(expectedFee);
        });

        it("Should handle escrow expiry", async function () {
            // Fast forward past escrow expiry
            await time.increase(32 * 24 * 60 * 60); // 32 days

            expect(await paymentEscrow.isEscrowExpired(1)).to.be.true;

            // Process expired escrow
            const initialBalance = await vscToken.balanceOf(payer.address);
            await paymentEscrow.processExpiredEscrow(1);

            // Should refund to payer
            const escrowFee = (PAYMENT_AMOUNT * BigInt(ESCROW_FEE_RATE)) / BigInt(10000);
            const totalAmount = PAYMENT_AMOUNT + escrowFee;
            expect(await vscToken.balanceOf(payer.address)).to.equal(initialBalance + totalAmount);
        });

        it("Should allow fee withdrawal by owner", async function () {
            // Confirm payment to generate fee
            await paymentProtocol.connect(payee).confirmPayment(1);

            const expectedFee = (PAYMENT_AMOUNT * BigInt(ESCROW_FEE_RATE)) / BigInt(10000);
            const availableFees = await paymentEscrow.getAvailableFees();
            expect(availableFees).to.equal(expectedFee);

            // Withdraw fees
            const initialOwnerBalance = await vscToken.balanceOf(owner.address);
            await paymentEscrow.connect(owner).withdrawFees(owner.address, expectedFee);

            expect(await vscToken.balanceOf(owner.address)).to.equal(initialOwnerBalance + expectedFee);
        });
    });

    describe("Payment Queries", function () {
        beforeEach(async function () {
            // Create multiple payments
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Payment 1"
            );
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT * 2n,
                "Payment 2"
            );
        });

        it("Should get payments by payer", async function () {
            const payerPayments = await paymentProtocol.getPaymentsByPayer(payer.address);
            expect(payerPayments.length).to.equal(2);
            expect(payerPayments[0]).to.equal(1);
            expect(payerPayments[1]).to.equal(2);
        });

        it("Should get payments by payee", async function () {
            const payeePayments = await paymentProtocol.getPaymentsByPayee(payee.address);
            expect(payeePayments.length).to.equal(2);
            expect(payeePayments[0]).to.equal(1);
            expect(payeePayments[1]).to.equal(2);
        });

        it("Should check payment expiry correctly", async function () {
            expect(await paymentProtocol.isPaymentExpired(1)).to.be.false;

            // Fast forward past confirmation deadline
            await time.increase(25 * 60 * 60); // 25 hours

            expect(await paymentProtocol.isPaymentExpired(1)).to.be.true;
        });

        it("Should check dispute eligibility", async function () {
            // Initially cannot dispute (not confirmed)
            expect(await paymentProtocol.canDispute(1)).to.be.false;

            // Confirm payment
            await paymentProtocol.connect(payee).confirmPayment(1);

            // Now can dispute
            expect(await paymentProtocol.canDispute(1)).to.be.true;

            // Fast forward past dispute deadline
            await time.increase(8 * 24 * 60 * 60); // 8 days

            // Cannot dispute anymore
            expect(await paymentProtocol.canDispute(1)).to.be.false;
        });
    });

    describe("Access Control", function () {
        it("Should restrict owner-only functions", async function () {
            await expect(
                paymentProtocol.connect(payer).updatePaymentSettings({
                    confirmationPeriod: 12 * 60 * 60,
                    disputeWindow: 3 * 24 * 60 * 60,
                    refundWindow: 15 * 24 * 60 * 60,
                    maxPaymentAmount: ethers.parseEther("100000"),
                    minPaymentAmount: ethers.parseEther("1"),
                    escrowFeeRate: 20
                })
            ).to.be.revertedWithCustomError(paymentProtocol, "OwnableUnauthorizedAccount");
        });

        it("Should allow owner to update settings", async function () {
            const newSettings = {
                confirmationPeriod: 12 * 60 * 60, // 12 hours
                disputeWindow: 3 * 24 * 60 * 60, // 3 days
                refundWindow: 15 * 24 * 60 * 60, // 15 days
                maxPaymentAmount: ethers.parseEther("100000"), // 100K VSC
                minPaymentAmount: ethers.parseEther("1"), // 1 VSC
                escrowFeeRate: 20 // 0.2%
            };

            await paymentProtocol.connect(owner).updatePaymentSettings(newSettings);

            const updatedSettings = await paymentProtocol.paymentSettings();
            expect(updatedSettings.confirmationPeriod).to.equal(newSettings.confirmationPeriod);
            expect(updatedSettings.disputeWindow).to.equal(newSettings.disputeWindow);
            expect(updatedSettings.escrowFeeRate).to.equal(newSettings.escrowFeeRate);
        });

        it("Should restrict emergency refund to token issuer", async function () {
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );

            await expect(
                paymentProtocol.connect(payer).emergencyRefund(1)
            ).to.be.revertedWith("Only token issuer");

            // Should work for owner (token issuer)
            await expect(paymentProtocol.connect(owner).emergencyRefund(1))
                .to.emit(paymentProtocol, "PaymentRefunded");
        });
    });

    describe("Edge Cases", function () {
        it("Should handle insufficient balance", async function () {
            // Try to pay more than balance
            await expect(
                paymentProtocol.connect(payee).initiatePayment( // payee has no tokens
                    payer.address,
                    PAYMENT_AMOUNT,
                    "Test payment"
                )
            ).to.be.revertedWith("Insufficient balance");
        });

        it("Should handle insufficient allowance", async function () {
            // Reset allowance to payment protocol (not escrow)
            await vscToken.connect(payer).approve(await paymentProtocol.getAddress(), 0);

            await expect(
                paymentProtocol.connect(payer).initiatePayment(
                    payee.address,
                    PAYMENT_AMOUNT,
                    "Test payment"
                )
            ).to.be.revertedWith("Insufficient allowance");
        });

        it("Should handle invalid payment IDs", async function () {
            await expect(
                paymentProtocol.getPayment(999)
            ).to.be.revertedWith("Invalid payment ID");

            await expect(
                paymentProtocol.connect(payee).confirmPayment(999)
            ).to.be.revertedWith("Invalid payment ID");
        });

        it("Should handle double confirmation attempts", async function () {
            await paymentProtocol.connect(payer).initiatePayment(
                payee.address,
                PAYMENT_AMOUNT,
                "Test payment"
            );

            await paymentProtocol.connect(payee).confirmPayment(1);

            await expect(
                paymentProtocol.connect(payee).confirmPayment(1)
            ).to.be.revertedWith("Payment not pending");
        });
    });
});