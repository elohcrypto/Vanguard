import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
    InvestorTypeRegistry,
    InvestorTypeCompliance,
} from "../typechain-types";

describe("Investor Type System - Basic Test", function () {
    let investorTypeRegistry: InvestorTypeRegistry;
    let investorTypeCompliance: InvestorTypeCompliance;

    let owner: SignerWithAddress;
    let complianceOfficer: SignerWithAddress;
    let normalInvestor: SignerWithAddress;
    let accreditedInvestor: SignerWithAddress;

    const VSC_DECIMALS = 18;
    const VSC = (amount: number) => ethers.parseUnits(amount.toString(), VSC_DECIMALS);

    beforeEach(async function () {
        [owner, complianceOfficer, normalInvestor, accreditedInvestor] = await ethers.getSigners();

        // Deploy InvestorTypeRegistry
        const InvestorTypeRegistryFactory = await ethers.getContractFactory("InvestorTypeRegistry");
        investorTypeRegistry = await InvestorTypeRegistryFactory.deploy();
        await investorTypeRegistry.waitForDeployment();

        // Deploy InvestorTypeCompliance
        const InvestorTypeComplianceFactory = await ethers.getContractFactory("InvestorTypeCompliance");
        investorTypeCompliance = await InvestorTypeComplianceFactory.deploy(await investorTypeRegistry.getAddress());
        await investorTypeCompliance.waitForDeployment();

        // Set up compliance officer
        await investorTypeRegistry.setComplianceOfficer(complianceOfficer.address, true);
        await investorTypeCompliance.setComplianceOfficer(complianceOfficer.address, true);
    });

    describe("Basic Functionality", function () {
        it("Should deploy contracts successfully", async function () {
            expect(await investorTypeRegistry.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await investorTypeCompliance.getAddress()).to.not.equal(ethers.ZeroAddress);
        });

        it("Should have correct default configurations", async function () {
            const [normalConfig, retailConfig, accreditedConfig, institutionalConfig] =
                await investorTypeRegistry.getAllInvestorTypeConfigs();

            // Normal Investor
            expect(normalConfig.maxTransferAmount).to.equal(VSC(8000));
            expect(normalConfig.maxHoldingAmount).to.equal(VSC(50000));
            expect(normalConfig.requiredWhitelistTier).to.equal(1);
            expect(normalConfig.transferCooldownMinutes).to.equal(60);

            // Accredited Investor
            expect(accreditedConfig.maxTransferAmount).to.equal(VSC(50000));
            expect(accreditedConfig.maxHoldingAmount).to.equal(VSC(500000));
            expect(accreditedConfig.requiredWhitelistTier).to.equal(3);
            expect(accreditedConfig.transferCooldownMinutes).to.equal(30);
        });

        it("Should allow compliance officer to assign investor types", async function () {
            // Assign investor types
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(normalInvestor.address, 0); // Normal
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(accreditedInvestor.address, 2); // Accredited

            // Verify assignments
            expect(await investorTypeRegistry.getInvestorType(normalInvestor.address)).to.equal(0);
            expect(await investorTypeRegistry.getInvestorType(accreditedInvestor.address)).to.equal(2);
        });

        it("Should validate transfer amounts based on investor type", async function () {
            // Assign investor types
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(normalInvestor.address, 0); // Normal
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(accreditedInvestor.address, 2); // Accredited

            // Normal investor - should be limited to 8,000 VSC
            expect(await investorTypeRegistry.canTransferAmount(normalInvestor.address, VSC(8000))).to.be.true;
            expect(await investorTypeRegistry.canTransferAmount(normalInvestor.address, VSC(8001))).to.be.false;

            // Accredited investor - should be limited to 50,000 VSC
            expect(await investorTypeRegistry.canTransferAmount(accreditedInvestor.address, VSC(50000))).to.be.true;
            expect(await investorTypeRegistry.canTransferAmount(accreditedInvestor.address, VSC(50001))).to.be.false;
        });

        it("Should handle unassigned investors as Normal type", async function () {
            // Unassigned investor should default to Normal type (0)
            expect(await investorTypeRegistry.getInvestorType(normalInvestor.address)).to.equal(0);

            // Should have Normal investor limits
            expect(await investorTypeRegistry.canTransferAmount(normalInvestor.address, VSC(8000))).to.be.true;
            expect(await investorTypeRegistry.canTransferAmount(normalInvestor.address, VSC(8001))).to.be.false;
        });

        it("Should allow compliance validation", async function () {
            // Assign investor type
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(normalInvestor.address, 0); // Normal

            // Check individual components
            const canTransferAmount = await investorTypeRegistry.canTransferAmount(normalInvestor.address, VSC(8000));
            console.log("Can transfer amount:", canTransferAmount);

            const remainingCooldown = await investorTypeCompliance.getRemainingCooldown(normalInvestor.address);
            console.log("Remaining cooldown:", remainingCooldown.toString());

            const isLargeTransfer = await investorTypeRegistry.isLargeTransfer(normalInvestor.address, VSC(8000));
            console.log("Is large transfer:", isLargeTransfer);

            // 8000 VSC is a large transfer for Normal investor (threshold is 3000)
            // Need to approve it first
            const currentTime = await time.latest();
            const expiryTime = currentTime + 3600; // 1 hour from now
            await investorTypeCompliance.connect(complianceOfficer).approveLargeTransfer(
                normalInvestor.address,
                accreditedInvestor.address,
                VSC(8000),
                expiryTime
            );

            // Test compliance validation
            const canTransfer8000 = await investorTypeCompliance.canTransfer(normalInvestor.address, accreditedInvestor.address, VSC(8000));
            console.log("Can transfer 8000:", canTransfer8000);

            expect(canTransfer8000).to.be.true;
            expect(await investorTypeCompliance.canTransfer(normalInvestor.address, accreditedInvestor.address, VSC(8001))).to.be.false;
        });

        it("Should detect large transfers correctly", async function () {
            // Assign investor types
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(accreditedInvestor.address, 2); // Accredited

            // Accredited investor - large transfer threshold is 10,000 VSC
            expect(await investorTypeRegistry.isLargeTransfer(accreditedInvestor.address, VSC(10000))).to.be.false;
            expect(await investorTypeRegistry.isLargeTransfer(accreditedInvestor.address, VSC(10001))).to.be.true;
        });

        it("Should handle large transfer approvals", async function () {
            // Assign investor type
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(accreditedInvestor.address, 2); // Accredited

            const largeAmount = VSC(15000); // Large transfer for accredited investor

            // Initially should fail without approval
            expect(await investorTypeCompliance.canTransfer(accreditedInvestor.address, normalInvestor.address, largeAmount)).to.be.false;

            // Approve large transfer
            const currentTime = await time.latest();
            const expiryTime = currentTime + 3600; // 1 hour from now
            await investorTypeCompliance.connect(complianceOfficer).approveLargeTransfer(
                accreditedInvestor.address,
                normalInvestor.address,
                largeAmount,
                expiryTime
            );

            // Should now be allowed
            expect(await investorTypeCompliance.canTransfer(accreditedInvestor.address, normalInvestor.address, largeAmount)).to.be.true;
        });

        it("Should handle emergency overrides", async function () {
            // Assign investor type
            await investorTypeRegistry.connect(complianceOfficer).assignInvestorType(normalInvestor.address, 0); // Normal

            const largeAmount = VSC(10000); // Exceeds normal investor limit

            // Initially should fail
            expect(await investorTypeCompliance.canTransfer(normalInvestor.address, accreditedInvestor.address, largeAmount)).to.be.false;

            // Activate emergency override
            await investorTypeCompliance.connect(complianceOfficer).activateEmergencyOverride(normalInvestor.address);

            // Should now be allowed
            expect(await investorTypeCompliance.canTransfer(normalInvestor.address, accreditedInvestor.address, largeAmount)).to.be.true;

            // Deactivate emergency override
            await investorTypeCompliance.connect(complianceOfficer).deactivateEmergencyOverride(normalInvestor.address);

            // Should fail again
            expect(await investorTypeCompliance.canTransfer(normalInvestor.address, accreditedInvestor.address, largeAmount)).to.be.false;
        });
    });

    describe("Access Control", function () {
        it("Should only allow compliance officers to assign investor types", async function () {
            await expect(
                investorTypeRegistry.connect(normalInvestor).assignInvestorType(accreditedInvestor.address, 1)
            ).to.be.revertedWith("Not authorized compliance officer");
        });

        it("Should only allow compliance officers to approve large transfers", async function () {
            const currentTime = await time.latest();
            const expiryTime = currentTime + 3600;

            await expect(
                investorTypeCompliance.connect(normalInvestor).approveLargeTransfer(
                    accreditedInvestor.address,
                    normalInvestor.address,
                    VSC(15000),
                    expiryTime
                )
            ).to.be.revertedWith("Not authorized compliance officer");
        });
    });
});