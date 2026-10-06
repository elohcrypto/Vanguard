// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ITrustedContracts
 * @dev The slice of ComplianceRules a trusted-contract registrar calls
 *      (plan v2 Task 4.3): InvestorRequestManager and EscrowWalletFactory
 *      trust each wallet they create, on the wallet's token. ComplianceRules
 *      accepts the call only from a registrar the owner named for that
 *      token, and only for an account with the registered code hash.
 */
interface ITrustedContracts {
    function addTrustedContract(address token, address contractAddress) external;
}
