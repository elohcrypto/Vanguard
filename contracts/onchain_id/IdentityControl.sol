// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IERC734.sol";

/**
 * @title IdentityControl
 * @dev The one rule for "this wallet controls that identity" (D41, Task
 *      4.14): the wallet owns the identity or holds a MANAGEMENT (1) or
 *      ACTION (2) key on it, exactly GovernanceProposals._controls
 *      (D25 b). Token.recoveryAddress, IdentityRegistry.registerIdentity
 *      and moveIdentity bind a wallet to an identity only under it, so
 *      the asset-side and identity-side recoveries cannot diverge. Never
 *      MANAGEMENT-only: that would close the owner's documented 48-hour
 *      asset escape through Token.recoveryAddress during a key recovery.
 *      Fails closed: no code, a call that reverts or a malformed answer
 *      (anything but the exact word, L-A) is "no control".
 */
library IdentityControl {
    function controls(address wallet, address id) internal view returns (bool) {
        if (id.code.length == 0) return false;
        if (_word(id, abi.encodeCall(Ownable.owner, ())) == uint256(uint160(wallet))) return true;
        bytes32 key = keccak256(abi.encodePacked(wallet));
        if (_word(id, abi.encodeCall(IERC734.keyHasPurpose, (key, 1))) == 1) return true;
        return _word(id, abi.encodeCall(IERC734.keyHasPurpose, (key, 2))) == 1;
    }

    /// @dev The first word `id` answers `data` with; 0 on revert or short data.
    function _word(address id, bytes memory data) private view returns (uint256) {
        (bool ok, bytes memory ret) = id.staticcall(data);
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }
}
