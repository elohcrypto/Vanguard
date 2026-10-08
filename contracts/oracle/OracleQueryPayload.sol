// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title OracleQueryPayload
 * @notice The query types and what a query's `data` must carry, checked by
 *         OracleManager.submitQuery when the query opens. Responders vote a
 *         bare bool and the query id hashes the data, so a "yes" accepts
 *         exactly the payload raised; the list oracles read it back from
 *         the manager (getQueryData), never from the relayer.
 *         - Blacklist: empty (MEDIUM) or abi.encode(severity), 0..3; only
 *           the owner raises CRITICAL (review LOW-1).
 *         - Whitelist (Task 4.12): abi.encode(tier), 1..5, required (an
 *           empty or any other shape is refused); only the owner raises
 *           tier 5. The verdict lists at this tier.
 *         - Identity, compliance: free.
 */
abstract contract OracleQueryPayload {
    /// @notice A blacklist query's data must be empty or one ABI-encoded severity 0..3.
    error InvalidSeverity();
    /// @notice A CRITICAL (365-day) blacklist query is raised by the owner only.
    error SeverityRequiresOwner();
    /// @notice A whitelist query's data must be one ABI-encoded tier 1..5.
    error InvalidTier();
    /// @notice A top-tier (5) whitelist query is raised by the owner only.
    error TierRequiresOwner();

    // Query types
    uint8 public constant QUERY_TYPE_WHITELIST = 1;
    uint8 public constant QUERY_TYPE_BLACKLIST = 2;
    uint8 public constant QUERY_TYPE_IDENTITY = 3;
    uint8 public constant QUERY_TYPE_COMPLIANCE = 4;

    /// @notice Highest BlacklistOracle.SeverityLevel (CRITICAL)
    uint256 private constant MAX_SEVERITY = 3;
    /// @notice WhitelistOracle.MIN_TIER and MAX_TIER
    uint256 private constant MIN_TIER = 1;
    uint256 private constant MAX_TIER = 5;

    /// @dev Refuse a payload its query type does not accept (see above).
    function _checkQueryPayload(uint8 _queryType, bytes calldata _data, bool _byOwner) internal pure {
        if (_queryType == QUERY_TYPE_BLACKLIST && _data.length != 0) {
            uint256 severity = _word(_data);
            if (severity > MAX_SEVERITY) revert InvalidSeverity();
            if (severity == MAX_SEVERITY && !_byOwner) revert SeverityRequiresOwner();
        } else if (_queryType == QUERY_TYPE_WHITELIST) {
            uint256 tier = _word(_data);
            if (tier < MIN_TIER || tier > MAX_TIER) revert InvalidTier();
            if (tier == MAX_TIER && !_byOwner) revert TierRequiresOwner();
        }
    }

    /// @dev One ABI word, or the maximum (out of every range) for any other length.
    function _word(bytes calldata _data) private pure returns (uint256) {
        return _data.length == 32 ? abi.decode(_data, (uint256)) : type(uint256).max;
    }
}
