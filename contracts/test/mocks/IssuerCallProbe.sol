// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {BoundedStaticCall} from "../../erc3643/BoundedStaticCall.sol";

/**
 * @title IssuerCallProbe
 * @dev Measures the gas of one unbounded issuer call (ISSUER_CALL_GAS is
 *      that cost on the deepest honest path, with headroom) and exposes
 *      BoundedStaticCall.word for its own tests (Task 5.1, A2F-5).
 */
contract IssuerCallProbe {
    function cost(address issuer, bytes calldata data) external view returns (uint256 used, bool ok) {
        uint256 g = gasleft();
        (ok, ) = issuer.staticcall(data);
        used = g - gasleft();
    }

    function word(address target, bytes calldata data, uint256 stipend) external view returns (bool, uint256) {
        return BoundedStaticCall.word(target, data, stipend);
    }

    /// @dev word() plus the gas it used, callee included.
    function wordCost(
        address target,
        bytes calldata data,
        uint256 stipend
    ) external view returns (bool ok, uint256 w, uint256 used) {
        uint256 g = gasleft();
        (ok, w) = BoundedStaticCall.word(target, data, stipend);
        used = g - gasleft();
    }
}
