// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockPolicyToken
 * @dev Test stand-in for the policy token PrivacyManager reads its
 *      jurisdiction source from (Token.compliance(), plan v2 Task 3.8): only
 *      the getter, plus a setter to model a Token vote moving it.
 */
contract MockPolicyToken {
    address public compliance;

    // solhint-disable-next-line func-visibility
    constructor(address complianceRules) {
        compliance = complianceRules;
    }

    function setCompliance(address complianceRules) external {
        compliance = complianceRules;
    }
}
