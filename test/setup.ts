import { ethers } from "hardhat";
import { expect } from "chai";

// Test setup and utilities
export async function getSigners() {
    const [owner, user1, user2, user3, oracle1, oracle2, oracle3] = await ethers.getSigners();
    return { owner, user1, user2, user3, oracle1, oracle2, oracle3 };
}

export function expectRevert(promise: Promise<any>, expectedError?: string) {
    return expect(promise).to.be.revertedWith(expectedError);
}

export async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

export async function getBlockTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const MAX_UINT256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// Common test constants
export const TEST_CONSTANTS = {
    COMPLIANCE_LEVEL: {
        NONE: 0,
        BASIC: 1,
        ENHANCED: 2,
        INSTITUTIONAL: 3,
        ACCREDITED: 4,
        QUALIFIED: 5,
    },
    CLAIM_TOPICS: {
        IDENTITY: 1,
        BIOMETRIC: 2,
        RESIDENCE: 3,
        REGISTRY: 4,
        ACCREDITATION: 5,
        KYC: 6,
        AML: 7,
        INVESTOR_TYPE: 8,
    },
    COUNTRY_CODES: {
        US: 840,
        UK: 826,
        DE: 276,
        FR: 250,
        CH: 756,
    },
    INVESTOR_TYPES: {
        RETAIL: 0,
        PROFESSIONAL: 1,
        INSTITUTIONAL: 2,
        ACCREDITED: 3,
        QIB: 4,
        QP: 5,
    },
};