import { expect } from "chai";
import { ethers } from "hardhat";
import { getSigners, TEST_CONSTANTS } from "./setup";

describe("Project Setup", function () {
    it("Should have correct Hardhat configuration", async function () {
        const { owner, user1 } = await getSigners();

        expect(owner.address).to.be.properAddress;
        expect(user1.address).to.be.properAddress;
        expect(owner.address).to.not.equal(user1.address);
    });

    it("Should have correct test constants", function () {
        expect(TEST_CONSTANTS.COMPLIANCE_LEVEL.NONE).to.equal(0);
        expect(TEST_CONSTANTS.COMPLIANCE_LEVEL.QUALIFIED).to.equal(5);
        expect(TEST_CONSTANTS.CLAIM_TOPICS.KYC).to.equal(6);
        expect(TEST_CONSTANTS.COUNTRY_CODES.US).to.equal(840);
    });

    it("Should be able to deploy a simple contract", async function () {
        // This is a placeholder test - we'll add real contract tests in subsequent tasks
        const { owner } = await getSigners();
        const balance = await owner.provider.getBalance(owner.address);
        expect(balance).to.be.gt(0);
    });
});