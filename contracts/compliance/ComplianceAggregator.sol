// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IUTXOCompliance.sol";

/**
 * @title ComplianceAggregator
 * @dev Aggregates compliance validation from multiple input UTXOs
 */
contract ComplianceAggregator is Ownable {
    constructor(address _complianceValidator, address _owner) Ownable(_owner) {
        // Simple constructor for demo
    }

    /**
     * @dev Aggregates compliance from multiple input UTXOs
     */
    function aggregateCompliance(
        IUTXOCompliance.UTXOMetadata[] calldata inputs,
        bytes32 /* transactionHash */
    ) external pure returns (IUTXOCompliance.UTXOMetadata memory aggregated, bool isValid, string memory reason) {
        require(inputs.length > 0, "No inputs provided");

        // Initialize aggregated metadata with first input
        aggregated = inputs[0];

        // Simple aggregation logic for demo
        uint8 minWhitelistTier = inputs[0].whitelistTier;
        bool allWhitelisted = inputs[0].isWhitelisted;
        bool anyBlacklisted = inputs[0].isBlacklisted;

        for (uint256 i = 1; i < inputs.length; i++) {
            if (inputs[i].whitelistTier < minWhitelistTier) {
                minWhitelistTier = inputs[i].whitelistTier;
            }

            if (!inputs[i].isWhitelisted) {
                allWhitelisted = false;
            }

            if (inputs[i].isBlacklisted) {
                anyBlacklisted = true;
            }
        }

        // Update aggregated metadata
        aggregated.whitelistTier = minWhitelistTier;
        aggregated.isWhitelisted = allWhitelisted;
        aggregated.isBlacklisted = anyBlacklisted;
        // Note: lastValidated would be set by the calling contract

        // Simple validation
        if (anyBlacklisted) {
            return (aggregated, false, "Blacklisted input detected");
        }

        if (!allWhitelisted) {
            return (aggregated, false, "Not all inputs are whitelisted");
        }

        return (aggregated, true, "Compliance aggregation successful");
    }
}
