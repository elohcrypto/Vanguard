// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OnchainIDKeys} from "./OnchainIDKeys.sol";

/// @dev What the identity asks an authorized manager (KeyManager, 4.11).
interface IRecoveryManager {
    function recoveryLocked(address identity) external view returns (bool);
    function isRecoveryOwner(address identity, address newOwner) external view returns (bool);
}

/**
 * @title OnchainIDOwnership
 * @dev The ownership half of OnchainID's keys (split by inheritance for
 *      size, plan v2 Task 4.11): manager authorization, Ownable2Step
 *      ownership, and the recovery hook that lets an authorized KeyManager
 *      move ownership to a recovered wallet (D38 = c). One contract is
 *      deployed (OnchainID).
 *
 *      Who can do what:
 *      - the owner authorizes and deauthorizes managers and transfers
 *        ownership (two-step), EXCEPT while an authorized manager reports
 *        an approved recovery (ownershipFrozen): a stolen owner key must
 *        not withdraw KeyManager, add a manager that proposes another
 *        owner, or hand the identity on before the recovery runs;
 *      - an authorized manager proposes `newOwner` through
 *        transferOwnershipByRecovery only when it answers
 *        isRecoveryOwner(this, newOwner) (KeyManager: an executed
 *        recovery of newOwner's key, OWNER_TRANSFER_TIMELOCK after its
 *        approval). `newOwner` accepts itself; on that acceptance every
 *        other MANAGEMENT key is removed.
 *      Authorizing a manager therefore trusts it with the ownership move:
 *      authorize only a KeyManager you trust (the ceremony checks the demo
 *      identity's against the compiled code hash).
 */
abstract contract OnchainIDOwnership is OnchainIDKeys {
    /// @dev An authorized manager proposed `newOwner` for a recovery.
    event RecoveryOwnerProposed(address indexed manager, address indexed newOwner);

    /// @dev An authorized manager reports an approved recovery.
    error FrozenByRecovery();
    error NotAuthorizedManager();
    /// @dev The manager does not report a due recovery naming `newOwner`.
    error NoRecoveryForOwner(address newOwner);

    /// @dev The authorized managers, so the freeze check can ask each.
    address[] private _managers;
    /// @dev Pending owner proposed by a recovery; its acceptance evicts.
    address private _recoveryPendingOwner;
    /// @dev Set only inside transferOwnershipByRecovery (onlyOwner bypass).
    bool private _inRecoveryProposal;

    /// @dev An identity must always have a controller. Renouncing used to
    ///      reopen initialize() to anyone (2F.2, L6).
    function renounceOwnership() public pure override {
        revert("OnchainID: identity needs an owner");
    }

    /**
     * @dev True while an authorized manager reports an approved recovery
     *      for this identity (KeyManager.recoveryLocked). A manager that
     *      does not answer, or answers malformed data, counts as no.
     */
    function ownershipFrozen() public view returns (bool) {
        for (uint256 i = 0; i < _managers.length; i++) {
            address m = _managers[i];
            if (!authorizedManagers[m] || m.code.length == 0) continue;
            (bool ok, bytes memory ret) = m.staticcall(
                abi.encodeCall(IRecoveryManager.recoveryLocked, (address(this)))
            );
            if (ok && ret.length >= 32 && abi.decode(ret, (bool))) return true;
        }
        return false;
    }

    function _managementAdditionsFrozen() internal view override returns (bool) {
        return ownershipFrozen();
    }

    /**
     * @dev Recovery eviction (Task 4.11), by an authorized manager: makes
     *      `keep` a MANAGEMENT key and removes up to `max` other MANAGEMENT
     *      keys, the list's front first (each found at index 0 or 1, so
     *      linear). No power beyond removeKey/addKey, which an authorized
     *      manager already holds; here the add passes the freeze. Returns
     *      the keys removed; call again while others remain.
     */
    function evictManagementKeys(bytes32 keep, uint256 max) external returns (bytes32[] memory evicted) {
        if (!authorizedManagers[msg.sender]) revert NotAuthorizedManager();
        if (!keyHasPurpose(keep, MANAGEMENT_KEY)) {
            Key storage held = keys[keep];
            if (held.key != bytes32(0) && held.revokedAt == 0) _removeKey(keep, held.purpose);
            _addKey(keep, MANAGEMENT_KEY, ECDSA_TYPE);
        }
        bytes32[] storage mgmt = keysByPurpose[MANAGEMENT_KEY];
        uint256 n = mgmt.length - 1;
        if (n > max) n = max;
        evicted = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            evicted[i] = mgmt[0] == keep ? mgmt[1] : mgmt[0];
            _removeKey(evicted[i], MANAGEMENT_KEY);
        }
    }

    function _checkNotFrozen() private view {
        if (ownershipFrozen()) revert FrozenByRecovery();
    }

    /// @dev Two-step. Refused while ownershipFrozen; a direct transfer
    ///      replaces a recovery's pending proposal (only after the freeze).
    function transferOwnership(address newOwner) public override {
        _checkOwner();
        _checkNotFrozen();
        _recoveryPendingOwner = address(0);
        super.transferOwnership(newOwner);
    }

    /// @dev onlyOwner, except inside transferOwnershipByRecovery.
    function _checkOwner() internal view override {
        if (!_inRecoveryProposal) super._checkOwner();
    }

    /**
     * @dev The recovery hook: an AUTHORIZED manager proposes `newOwner`
     *      while it reports an executed, timelock-expired recovery naming
     *      `newOwner` (asked back here). `newOwner` must accept itself.
     */
    function transferOwnershipByRecovery(address newOwner) external {
        if (!authorizedManagers[msg.sender]) revert NotAuthorizedManager();
        if (!IRecoveryManager(msg.sender).isRecoveryOwner(address(this), newOwner)) {
            revert NoRecoveryForOwner(newOwner);
        }
        _inRecoveryProposal = true;
        super.transferOwnership(newOwner);
        _inRecoveryProposal = false;
        _recoveryPendingOwner = newOwner;
        emit RecoveryOwnerProposed(msg.sender, newOwner);
    }

    /// @dev Two-step, as ClaimIssuer (D18). On acceptance the old owner's
    ///      MANAGEMENT key is retired (unless the owner did not change) and
    ///      the new owner ends with a MANAGEMENT key: a revoked key is
    ///      re-activated and a key held for another purpose is moved to
    ///      MANAGEMENT (2F.2, L8; review F4). Other keys and
    ///      authorizedManagers survive; the new owner audits them. When the
    ///      acceptance completes a recovery's proposal, every other
    ///      MANAGEMENT key is removed too, so the recovered wallet is the
    ///      only one (none is expected: the proposal needs a single
    ///      MANAGEMENT key and additions stay frozen until this acceptance).
    function acceptOwnership() public override {
        address previous = owner();
        super.acceptOwnership();
        bytes32 newKey = keccak256(abi.encodePacked(msg.sender));
        if (previous != msg.sender) {
            bytes32 oldKey = keccak256(abi.encodePacked(previous));
            if (keyHasPurpose(oldKey, MANAGEMENT_KEY)) _removeKey(oldKey, MANAGEMENT_KEY);
        }
        if (!keyHasPurpose(newKey, MANAGEMENT_KEY)) {
            Key storage held = keys[newKey];
            if (held.key != bytes32(0) && held.revokedAt == 0) _removeKey(newKey, held.purpose);
            _addKey(newKey, MANAGEMENT_KEY, ECDSA_TYPE);
        }
        if (msg.sender == _recoveryPendingOwner) {
            _recoveryPendingOwner = address(0);
            bytes32[] storage mgmt = keysByPurpose[MANAGEMENT_KEY];
            while (mgmt.length > 1 || (mgmt.length == 1 && mgmt[0] != newKey)) {
                _removeKey(mgmt[0] == newKey ? mgmt[1] : mgmt[0], MANAGEMENT_KEY);
            }
        }
    }

    /**
     * @dev Authorize a manager to perform management operations (and, if
     *      it is a KeyManager, to move ownership on an approved recovery).
     * @param _manager The manager address to authorize
     */
    function authorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can authorize managers");
        require(_manager != address(0), "OnchainID: Invalid manager address");
        _checkNotFrozen();
        authorizedManagers[_manager] = true;
        for (uint256 i = 0; i < _managers.length; i++) {
            if (_managers[i] == _manager) return;
        }
        _managers.push(_manager);
    }

    /**
     * @dev Remove authorization from a manager
     * @param _manager The manager address to deauthorize
     */
    function deauthorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can deauthorize managers");
        _checkNotFrozen();
        authorizedManagers[_manager] = false;
        for (uint256 i = 0; i < _managers.length; i++) {
            if (_managers[i] == _manager) {
                _managers[i] = _managers[_managers.length - 1];
                _managers.pop();
                return;
            }
        }
    }
}
