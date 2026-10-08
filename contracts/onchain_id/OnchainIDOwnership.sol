// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OnchainIDKeys} from "./OnchainIDKeys.sol";

/// @dev What the identity asks its recovery manager (KeyManager, 4.11).
interface IRecoveryManager {
    function recoveryLocked(address identity) external view returns (bool);
    function isRecoveryOwner(address identity, address newOwner) external view returns (bool);
}

/**
 * @title OnchainIDOwnership
 * @dev The ownership half of OnchainID's keys (split by inheritance for
 *      size, plan v2 Task 4.11): manager authorization, Ownable2Step
 *      ownership and recovery's two hooks (D38 = c). One contract is
 *      deployed (OnchainID).
 *
 *      ONE recovery manager is pinned per identity (R-411-14): the factory
 *      pins its KeyManager at creation; an identity deployed directly is
 *      pinned once by its creator or owner (pinRecoveryManager). It can
 *      never be changed. With none pinned there is no recovery:
 *      ownershipFrozen is false and both hooks refuse.
 *      - Only the recovery manager may evict MANAGEMENT keys
 *        (evictManagementKeys) and propose an owner
 *        (transferOwnershipByRecovery, when it answers isRecoveryOwner).
 *      - While it reports recoveryLocked (an approved recovery whose owner
 *        transfer has not happened), the owner's authorizeManager,
 *        deauthorizeManager, transferOwnership and every addKey of a
 *        MANAGEMENT key are refused (ownershipFrozen).
 *      - Other authorized managers hold key powers only (onlyManagementKey),
 *        at most MAX_MANAGERS of them, listed by getManagers(); the
 *        recovered wallet's acceptance de-authorizes all of them.
 *      Recovery does not depend on authorizedManagers: withdrawing a
 *      manager pauses its key writes, never recovery.
 */
abstract contract OnchainIDOwnership is OnchainIDKeys {
    /// @dev The recovery manager proposed `newOwner`.
    event RecoveryOwnerProposed(address indexed manager, address indexed newOwner);
    event RecoveryManagerPinned(address indexed manager);
    event ManagerAuthorized(address indexed manager);
    event ManagerDeauthorized(address indexed manager);

    /// @dev The recovery manager reports an approved recovery.
    error FrozenByRecovery();
    error NotRecoveryManager();
    /// @dev The manager does not report a due recovery naming `newOwner`.
    error NoRecoveryForOwner(address newOwner);
    error RecoveryManagerAlreadyPinned();
    error NotCreatorOrOwner();
    error NotAContract();
    error TooManyManagers();

    /// @dev Authorized managers kept at once (R-411-15).
    uint256 public constant MAX_MANAGERS = 8;
    /// @dev The one contract recovery runs through; zero: no recovery.
    address public recoveryManager;

    address private immutable CREATOR = msg.sender;
    /// @dev The authorized managers, listable (getManagers).
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

    /// @dev Pin the recovery manager, once: the creator (the factory, in
    ///      the creating transaction) or the owner. Never changeable.
    function pinRecoveryManager(address manager) external {
        if (recoveryManager != address(0)) revert RecoveryManagerAlreadyPinned();
        if (msg.sender != CREATOR && msg.sender != owner()) revert NotCreatorOrOwner();
        if (manager.code.length == 0) revert NotAContract();
        recoveryManager = manager;
        emit RecoveryManagerPinned(manager);
    }

    /// @dev The authorized managers.
    function getManagers() external view returns (address[] memory) {
        return _managers;
    }

    /**
     * @dev True while the recovery manager reports an approved recovery
     *      (KeyManager.recoveryLocked). No other manager is asked; none
     *      pinned, or a malformed answer, counts as no.
     */
    function ownershipFrozen() public view returns (bool) {
        address m = recoveryManager;
        if (m == address(0)) return false;
        (bool ok, bytes memory ret) = m.staticcall(abi.encodeCall(IRecoveryManager.recoveryLocked, (address(this))));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _checkNotFrozen() private view {
        if (ownershipFrozen()) revert FrozenByRecovery();
    }

    function _managementAdditionsFrozen() internal view override returns (bool) {
        return ownershipFrozen();
    }

    /**
     * @dev Recovery eviction (Task 4.11), by the recovery manager only:
     *      makes `keep` a MANAGEMENT key and removes up to `max` other
     *      MANAGEMENT keys, the list's front first (each found at index 0
     *      or 1, so linear). Returns the keys removed; call again while
     *      others remain. KeyManager calls it for the approved candidate.
     */
    function evictManagementKeys(bytes32 keep, uint256 max) external returns (bytes32[] memory evicted) {
        if (msg.sender != recoveryManager || msg.sender == address(0)) revert NotRecoveryManager();
        if (!keyHasPurpose(keep, MANAGEMENT_KEY)) {
            Key storage held = keys[keep];
            if (held.key != bytes32(0) && held.revokedAt == 0) _removeKey(keep, held.purpose);
            _addKey(keep, MANAGEMENT_KEY, ECDSA_TYPE);
        }
        evicted = _evictOthers(keep, max);
    }

    /// @dev Removes up to `max` MANAGEMENT keys other than `keep`.
    function _evictOthers(bytes32 keep, uint256 max) private returns (bytes32[] memory evicted) {
        bytes32[] storage mgmt = keysByPurpose[MANAGEMENT_KEY];
        uint256 others = mgmt.length;
        if (keyHasPurpose(keep, MANAGEMENT_KEY)) others--;
        uint256 n = others > max ? max : others;
        evicted = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            evicted[i] = mgmt[0] == keep ? mgmt[1] : mgmt[0];
            _removeKey(evicted[i], MANAGEMENT_KEY);
        }
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
     * @dev The recovery hook: the recovery manager proposes `newOwner`
     *      while it reports an executed, timelock-expired recovery naming
     *      `newOwner` (asked back here). `newOwner` must accept itself.
     */
    function transferOwnershipByRecovery(address newOwner) external {
        if (msg.sender != recoveryManager || msg.sender == address(0)) revert NotRecoveryManager();
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
    ///      MANAGEMENT (2F.2, L8; review F4). After an ordinary transfer the
    ///      other keys and managers survive; the new owner audits them.
    ///      When the acceptance completes a recovery's proposal, every other
    ///      MANAGEMENT key is removed (bounded: none is expected, additions
    ///      stay frozen until here) and every authorized manager but the
    ///      recovery manager is de-authorized (the thief's managers go).
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
            _evictOthers(newKey, MAX_MANAGERS * 16);
            for (uint256 i = _managers.length; i > 0; i--) {
                address m = _managers[i - 1];
                if (m != recoveryManager) _deauthorize(m);
            }
        }
    }

    /**
     * @dev Authorize a manager to perform management operations (key
     *      powers only; at most MAX_MANAGERS).
     * @param _manager The manager address to authorize
     */
    function authorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can authorize managers");
        require(_manager != address(0), "OnchainID: Invalid manager address");
        _checkNotFrozen();
        if (authorizedManagers[_manager]) return;
        if (_managers.length >= MAX_MANAGERS) revert TooManyManagers();
        authorizedManagers[_manager] = true;
        _managers.push(_manager);
        emit ManagerAuthorized(_manager);
    }

    /**
     * @dev Remove authorization from a manager
     * @param _manager The manager address to deauthorize
     */
    function deauthorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can deauthorize managers");
        _checkNotFrozen();
        if (authorizedManagers[_manager]) _deauthorize(_manager);
    }

    function _deauthorize(address _manager) private {
        authorizedManagers[_manager] = false;
        for (uint256 i = 0; i < _managers.length; i++) {
            if (_managers[i] == _manager) {
                _managers[i] = _managers[_managers.length - 1];
                _managers.pop();
                break;
            }
        }
        emit ManagerDeauthorized(_manager);
    }
}
