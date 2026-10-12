// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ShortWhitelistOracle
 * @dev Test double for a whitelist oracle from before the tier rule
 *      (Task 4.10): isWhitelisted answers, but getWhitelistInfo returns
 *      the 5-tuple without the tier. ComplianceRules.setWhitelistOracle
 *      must refuse it (Task 4.16, review A1 L1); bound, every transfer
 *      would revert without a reason in the tier decode.
 */
contract ShortWhitelistOracle {
    mapping(address => bool) public listed;

    function setListed(address subject, bool value) external {
        listed[subject] = value;
    }

    function isWhitelisted(address subject) external view returns (bool) {
        return listed[subject];
    }

    function getWhitelistInfo(
        address subject
    ) external view returns (bool, uint256, uint256, string memory, address[] memory) {
        return (listed[subject], 0, 0, "", new address[](0));
    }
}
