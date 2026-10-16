// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TestMultisig
 * @dev Test-only stand-in for a Safe (plan v2 Task 5.13): ops and the
 *      issuer admin as a contract in the multisig drive and its tests.
 *      Each owner approves the hash of a batch of calls; once `threshold`
 *      owners approved it, an owner executes the batch, in order, all or
 *      nothing. Not the production recommendation (use a Safe); deployed
 *      by no demo or production path.
 */
contract TestMultisig {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    address[] public owners;
    uint256 public threshold;
    uint256 public nonce;
    mapping(address => bool) public isOwner;
    address[] private modules;
    mapping(bytes32 => mapping(address => bool)) public approved;

    error NotOwner();
    error BadOwners();
    error TooFewApprovals(uint256 have, uint256 need);
    error CallFailed(uint256 index, bytes reason);

    event Approved(bytes32 indexed hash, address indexed owner);
    event Executed(bytes32 indexed hash, uint256 calls);

    // solhint-disable-next-line func-visibility
    constructor(address[] memory owners_, uint256 threshold_) {
        if (threshold_ == 0 || threshold_ > owners_.length) revert BadOwners();
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert BadOwners();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
    }

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    /// @notice The owners, as a Safe names them (Task 5.13 review LOW-5).
    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    /// @notice The approvals a batch needs, as a Safe names it.
    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    /// @notice Test-only: enable a module, as a Safe can (review LOW-5).
    function setModule(address m) external {
        modules.push(m);
    }

    /// @notice The enabled modules, as a Safe pages them (one page).
    function getModulesPaginated(address, uint256) external view returns (address[] memory, address) {
        return (modules, address(1));
    }

    /// @notice The hash owners approve: this wallet, chain, nonce, calls.
    function hashOf(Call[] calldata calls) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, nonce, calls));
    }

    /// @notice Approve the batch `hash` (from hashOf at the current nonce).
    function approve(bytes32 hash) external onlyOwner {
        approved[hash][msg.sender] = true;
        emit Approved(hash, msg.sender);
    }

    /// @notice Run `calls` in order once enough owners approved them.
    function execute(Call[] calldata calls) external onlyOwner {
        bytes32 hash = hashOf(calls);
        uint256 have = 0;
        for (uint256 i = 0; i < owners.length; i++) {
            if (approved[hash][owners[i]]) have++;
        }
        if (have < threshold) revert TooFewApprovals(have, threshold);
        nonce++;
        for (uint256 i = 0; i < calls.length; i++) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, bytes memory reason) = calls[i].to.call{value: calls[i].value}(
                calls[i].data
            );
            if (!ok) revert CallFailed(i, reason);
        }
        emit Executed(hash, calls.length);
    }
}
