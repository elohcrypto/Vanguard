// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./MockToken.sol";

/**
 * @title MockTypedToken
 * @dev MockToken plus the investorTypeRegistry view MultiSigWallet reads
 *      for its Normal lock cap (Task 5.1, A1F-6); unset (zero) by default.
 */
contract MockTypedToken is MockToken {
    address public investorTypeRegistry;

    constructor() MockToken("T", "T", 0) {}

    function setInvestorTypeRegistry(address r) external {
        investorTypeRegistry = r;
    }
}
