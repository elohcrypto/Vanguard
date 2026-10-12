// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title YesCompliance
 * @dev TEST DOUBLE: answers every call with the word 1 (true), so a token
 *      bound to it checks nothing. Task 4.17 (review X1): the deployer
 *      swaps a token's compliance to it and back inside the voting window.
 */
contract YesCompliance {
    fallback(bytes calldata) external payable returns (bytes memory) {
        return abi.encode(uint256(1));
    }
}
