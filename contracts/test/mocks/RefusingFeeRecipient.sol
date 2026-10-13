// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFeeFactory {
    function withdrawFees(address payable to) external;
}

/**
 * @title RefusingFeeRecipient
 * @dev Test-only OnchainIDFactory feeRecipient (Task 5.2): its receive
 *      reverts, or burns all the gas it is given (`burn`), so a pushed fee
 *      fails. It pulls what it is owed to another address.
 */
contract RefusingFeeRecipient {
    bool public burn;

    error Refused();

    function setBurn(bool b) external {
        burn = b;
    }

    function pull(address factory, address payable to) external {
        IFeeFactory(factory).withdrawFees(to);
    }

    receive() external payable {
        if (!burn) revert Refused();
        while (true) {}
    }
}
