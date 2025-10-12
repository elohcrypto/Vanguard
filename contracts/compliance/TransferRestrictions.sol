// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TransferRestrictions
 * @dev Manages transfer restrictions for ERC-3643 tokens
 */
contract TransferRestrictions is Ownable {
    struct RestrictionRule {
        bool isActive;
        uint256 holdingPeriod;
        uint256 maxTransferAmount;
        uint256 dailyLimit;
        uint256 monthlyLimit;
        uint16[] allowedJurisdictions;
        uint8[] allowedInvestorTypes;
        bool requiresApproval;
    }

    mapping(address => RestrictionRule) private _tokenRestrictions;
    mapping(address => mapping(address => uint256)) private _lastTransferTime;
    mapping(address => mapping(address => uint256)) private _dailyTransferred;
    mapping(address => mapping(address => uint256)) private _monthlyTransferred;
    mapping(address => mapping(address => uint256)) private _lastDailyReset;
    mapping(address => mapping(address => uint256)) private _lastMonthlyReset;

    event RestrictionRuleUpdated(
        address indexed token,
        uint256 holdingPeriod,
        uint256 maxTransferAmount,
        uint256 dailyLimit,
        uint256 monthlyLimit
    );

    event TransferApproved(address indexed token, address indexed from, address indexed to, uint256 amount);
    event TransferRestricted(address indexed token, address indexed from, string reason);

    constructor(address _owner) Ownable(_owner) {}

    /**
     * @dev Set restriction rules for a token
     */
    function setRestrictionRule(
        address token,
        uint256 holdingPeriod,
        uint256 maxTransferAmount,
        uint256 dailyLimit,
        uint256 monthlyLimit,
        uint16[] calldata allowedJurisdictions,
        uint8[] calldata allowedInvestorTypes,
        bool requiresApproval
    ) external onlyOwner {
        // Create new arrays for storage
        uint16[] memory jurisdictions = new uint16[](allowedJurisdictions.length);
        uint8[] memory investorTypes = new uint8[](allowedInvestorTypes.length);

        // Copy arrays
        for (uint i = 0; i < allowedJurisdictions.length; i++) {
            jurisdictions[i] = allowedJurisdictions[i];
        }
        for (uint i = 0; i < allowedInvestorTypes.length; i++) {
            investorTypes[i] = allowedInvestorTypes[i];
        }

        _tokenRestrictions[token] = RestrictionRule({
            isActive: true,
            holdingPeriod: holdingPeriod,
            maxTransferAmount: maxTransferAmount,
            dailyLimit: dailyLimit,
            monthlyLimit: monthlyLimit,
            allowedJurisdictions: jurisdictions,
            allowedInvestorTypes: investorTypes,
            requiresApproval: requiresApproval
        });

        emit RestrictionRuleUpdated(token, holdingPeriod, maxTransferAmount, dailyLimit, monthlyLimit);
    }

    /**
     * @dev Get restriction rule for a token
     */
    function getRestrictionRule(address token) external view returns (RestrictionRule memory) {
        return _tokenRestrictions[token];
    }

    /**
     * @dev Check if a transfer is allowed
     */
    function canTransfer(
        address token,
        address from,
        address /* to */,
        uint256 amount
    ) external view returns (bool allowed, string memory reason) {
        RestrictionRule memory rule = _tokenRestrictions[token];

        if (!rule.isActive) {
            return (true, "No restrictions");
        }

        // Check holding period
        if (rule.holdingPeriod > 0) {
            uint256 lastTransfer = _lastTransferTime[token][from];
            if (lastTransfer > 0 && block.timestamp < lastTransfer + rule.holdingPeriod) {
                return (false, "Holding period not met");
            }
        }

        // Check max transfer amount
        if (rule.maxTransferAmount > 0 && amount > rule.maxTransferAmount) {
            return (false, "Amount exceeds maximum transfer limit");
        }

        // Check daily limit
        if (rule.dailyLimit > 0) {
            uint256 dailyTransferred = _getDailyTransferred(token, from);
            if (dailyTransferred + amount > rule.dailyLimit) {
                return (false, "Daily transfer limit exceeded");
            }
        }

        // Check monthly limit
        if (rule.monthlyLimit > 0) {
            uint256 monthlyTransferred = _getMonthlyTransferred(token, from);
            if (monthlyTransferred + amount > rule.monthlyLimit) {
                return (false, "Monthly transfer limit exceeded");
            }
        }

        return (true, "Transfer allowed");
    }

    /**
     * @dev Record a transfer (should be called by token contract)
     */
    function recordTransfer(address token, address from, address to, uint256 amount) external {
        _lastTransferTime[token][from] = block.timestamp;

        // Update daily tracking
        _updateDailyTransferred(token, from, amount);

        // Update monthly tracking
        _updateMonthlyTransferred(token, from, amount);

        emit TransferApproved(token, from, to, amount);
    }

    /**
     * @dev Get daily transferred amount (with reset logic)
     */
    function _getDailyTransferred(address token, address user) internal view returns (uint256) {
        uint256 lastReset = _lastDailyReset[token][user];
        uint256 currentDay = block.timestamp / 1 days;
        uint256 lastResetDay = lastReset / 1 days;

        if (currentDay > lastResetDay) {
            return 0; // Reset daily amount
        }

        return _dailyTransferred[token][user];
    }

    /**
     * @dev Get monthly transferred amount (with reset logic)
     */
    function _getMonthlyTransferred(address token, address user) internal view returns (uint256) {
        uint256 lastReset = _lastMonthlyReset[token][user];
        uint256 currentMonth = block.timestamp / 30 days;
        uint256 lastResetMonth = lastReset / 30 days;

        if (currentMonth > lastResetMonth) {
            return 0; // Reset monthly amount
        }

        return _monthlyTransferred[token][user];
    }

    /**
     * @dev Update daily transferred amount
     */
    function _updateDailyTransferred(address token, address user, uint256 amount) internal {
        uint256 currentDay = block.timestamp / 1 days;
        uint256 lastResetDay = _lastDailyReset[token][user] / 1 days;

        if (currentDay > lastResetDay) {
            _dailyTransferred[token][user] = amount;
            _lastDailyReset[token][user] = block.timestamp;
        } else {
            _dailyTransferred[token][user] += amount;
        }
    }

    /**
     * @dev Update monthly transferred amount
     */
    function _updateMonthlyTransferred(address token, address user, uint256 amount) internal {
        uint256 currentMonth = block.timestamp / 30 days;
        uint256 lastResetMonth = _lastMonthlyReset[token][user] / 30 days;

        if (currentMonth > lastResetMonth) {
            _monthlyTransferred[token][user] = amount;
            _lastMonthlyReset[token][user] = block.timestamp;
        } else {
            _monthlyTransferred[token][user] += amount;
        }
    }

    /**
     * @dev Get transfer statistics for a user
     */
    function getTransferStats(
        address token,
        address user
    ) external view returns (uint256 dailyTransferred, uint256 monthlyTransferred, uint256 lastTransferTime) {
        return (_getDailyTransferred(token, user), _getMonthlyTransferred(token, user), _lastTransferTime[token][user]);
    }

    /**
     * @dev Check if jurisdiction is allowed
     */
    function isJurisdictionAllowed(address token, uint16 jurisdiction) external view returns (bool) {
        RestrictionRule memory rule = _tokenRestrictions[token];

        if (rule.allowedJurisdictions.length == 0) {
            return true; // No restrictions
        }

        for (uint i = 0; i < rule.allowedJurisdictions.length; i++) {
            if (rule.allowedJurisdictions[i] == jurisdiction) {
                return true;
            }
        }

        return false;
    }

    /**
     * @dev Check if investor type is allowed
     */
    function isInvestorTypeAllowed(address token, uint8 investorType) external view returns (bool) {
        RestrictionRule memory rule = _tokenRestrictions[token];

        if (rule.allowedInvestorTypes.length == 0) {
            return true; // No restrictions
        }

        for (uint i = 0; i < rule.allowedInvestorTypes.length; i++) {
            if (rule.allowedInvestorTypes[i] == investorType) {
                return true;
            }
        }

        return false;
    }
}
