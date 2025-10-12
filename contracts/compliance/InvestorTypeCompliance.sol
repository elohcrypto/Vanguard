// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../erc3643/interfaces/IInvestorTypeRegistry.sol";
import "../erc3643/interfaces/ICompliance.sol";

/**
 * @title InvestorTypeCompliance
 * @dev Enhanced compliance module that integrates with investor type system
 * @author Vanguard StableCoin Team
 */
contract InvestorTypeCompliance is ICompliance, Ownable, ReentrancyGuard {
    // State variables
    IInvestorTypeRegistry private _investorTypeRegistry;

    // Transfer cooldown tracking
    mapping(address => uint256) private _lastTransferTime;

    // Large transfer notifications
    mapping(address => bool) private _complianceOfficers;

    // Transfer approval tracking for large transfers
    mapping(bytes32 => bool) private _approvedLargeTransfers;
    mapping(bytes32 => uint256) private _largeTransferExpiry;

    // Emergency override
    mapping(address => bool) private _emergencyOverride;

    // Compliance modules (for ICompliance interface)
    address[] private _modules;
    mapping(address => bool) private _isModuleBound;

    // Events
    event LargeTransferDetected(
        address indexed from,
        address indexed to,
        uint256 amount,
        IInvestorTypeRegistry.InvestorType investorType
    );
    event LargeTransferApproved(address indexed from, address indexed to, uint256 amount, address indexed officer);
    event TransferCooldownViolation(address indexed investor, uint256 remainingCooldown);
    event EmergencyOverrideActivated(address indexed investor, address indexed officer);
    event EmergencyOverrideDeactivated(address indexed investor, address indexed officer);
    event ComplianceOfficerUpdated(address indexed officer, bool authorized);

    modifier onlyComplianceOfficer() {
        require(_complianceOfficers[msg.sender] || msg.sender == owner(), "Not authorized compliance officer");
        _;
    }

    constructor(address _investorTypeRegistryAddress) Ownable(msg.sender) {
        require(_investorTypeRegistryAddress != address(0), "Invalid registry address");
        _investorTypeRegistry = IInvestorTypeRegistry(_investorTypeRegistryAddress);
        _complianceOfficers[msg.sender] = true;
    }

    /**
     * @dev Check if transfer is allowed based on investor type rules
     */
    function canTransfer(address _from, address _to, uint256 _value) external view override returns (bool) {
        // Skip checks for minting (from == address(0)) and burning (to == address(0))
        if (_from == address(0) || _to == address(0)) {
            return true;
        }

        // Check emergency override
        if (_emergencyOverride[_from]) {
            return true;
        }

        // Check if investor type registry is set
        if (address(_investorTypeRegistry) == address(0)) {
            return true; // No investor type restrictions if registry not set
        }

        // Check transfer amount limits
        if (!_investorTypeRegistry.canTransferAmount(_from, _value)) {
            return false;
        }

        // Check transfer cooldown
        if (!_checkTransferCooldown(_from)) {
            return false;
        }

        // Check if large transfer requires approval
        if (_investorTypeRegistry.isLargeTransfer(_from, _value)) {
            bytes32 transferHash = _getTransferHash(_from, _to, _value);
            if (!_approvedLargeTransfers[transferHash] || block.timestamp > _largeTransferExpiry[transferHash]) {
                return false;
            }
        }

        return true;
    }

    /**
     * @dev Called when tokens are transferred
     */
    function transferred(address _from, address _to, uint256 _value) external override {
        // Update last transfer time for cooldown tracking
        _lastTransferTime[_from] = block.timestamp;

        // Emit large transfer detection if applicable
        if (_investorTypeRegistry.isLargeTransfer(_from, _value)) {
            IInvestorTypeRegistry.InvestorType investorType = _investorTypeRegistry.getInvestorType(_from);
            emit LargeTransferDetected(_from, _to, _value, investorType);
        }
    }

    /**
     * @dev Called when tokens are minted
     */
    function created(address _to, uint256 _value) external override {
        // No specific action needed for minting in investor type compliance
    }

    /**
     * @dev Called when tokens are burned
     */
    function destroyed(address _from, uint256 _value) external override {
        // No specific action needed for burning in investor type compliance
    }

    /**
     * @dev Add compliance module (required by ICompliance interface)
     */
    function addModule(address module) external override onlyOwner {
        require(module != address(0), "Invalid module address");
        require(!_isModuleBound[module], "Module already bound");

        _modules.push(module);
        _isModuleBound[module] = true;

        emit ComplianceAdded(module);
    }

    /**
     * @dev Remove compliance module (required by ICompliance interface)
     */
    function removeModule(address module) external override onlyOwner {
        require(_isModuleBound[module], "Module not bound");

        // Remove from array
        for (uint i = 0; i < _modules.length; i++) {
            if (_modules[i] == module) {
                _modules[i] = _modules[_modules.length - 1];
                _modules.pop();
                break;
            }
        }

        _isModuleBound[module] = false;
        emit ComplianceRemoved(module);
    }

    /**
     * @dev Get all compliance modules (required by ICompliance interface)
     */
    function getModules() external view override returns (address[] memory) {
        return _modules;
    }

    /**
     * @dev Check if module is bound (required by ICompliance interface)
     */
    function isModuleBound(address module) external view override returns (bool) {
        return _isModuleBound[module];
    }

    /**
     * @dev Approve large transfer (compliance officer only)
     */
    function approveLargeTransfer(
        address _from,
        address _to,
        uint256 _value,
        uint256 _expiryTime
    ) external onlyComplianceOfficer {
        require(_investorTypeRegistry.isLargeTransfer(_from, _value), "Not a large transfer");
        require(_expiryTime > block.timestamp, "Invalid expiry time");

        bytes32 transferHash = _getTransferHash(_from, _to, _value);
        _approvedLargeTransfers[transferHash] = true;
        _largeTransferExpiry[transferHash] = _expiryTime;

        emit LargeTransferApproved(_from, _to, _value, msg.sender);
    }

    /**
     * @dev Activate emergency override for an investor
     */
    function activateEmergencyOverride(address _investor) external onlyComplianceOfficer {
        _emergencyOverride[_investor] = true;
        emit EmergencyOverrideActivated(_investor, msg.sender);
    }

    /**
     * @dev Deactivate emergency override for an investor
     */
    function deactivateEmergencyOverride(address _investor) external onlyComplianceOfficer {
        _emergencyOverride[_investor] = false;
        emit EmergencyOverrideDeactivated(_investor, msg.sender);
    }

    /**
     * @dev Set compliance officer authorization
     */
    function setComplianceOfficer(address _officer, bool _authorized) external onlyOwner {
        require(_officer != address(0), "Invalid officer address");
        _complianceOfficers[_officer] = _authorized;
        emit ComplianceOfficerUpdated(_officer, _authorized);
    }

    /**
     * @dev Update investor type registry
     */
    function setInvestorTypeRegistry(address _investorTypeRegistryAddress) external onlyOwner {
        require(_investorTypeRegistryAddress != address(0), "Invalid registry address");
        _investorTypeRegistry = IInvestorTypeRegistry(_investorTypeRegistryAddress);
    }

    /**
     * @dev Get investor type registry address
     */
    function getInvestorTypeRegistry() external view returns (address) {
        return address(_investorTypeRegistry);
    }

    /**
     * @dev Check if address is compliance officer
     */
    function isComplianceOfficer(address _officer) external view returns (bool) {
        return _complianceOfficers[_officer];
    }

    /**
     * @dev Check if investor has emergency override active
     */
    function hasEmergencyOverride(address _investor) external view returns (bool) {
        return _emergencyOverride[_investor];
    }

    /**
     * @dev Get remaining transfer cooldown for investor
     */
    function getRemainingCooldown(address _investor) external view returns (uint256) {
        uint256 cooldownMinutes = _investorTypeRegistry.getTransferCooldown(_investor);
        uint256 cooldownSeconds = cooldownMinutes * 60;
        uint256 lastTransfer = _lastTransferTime[_investor];

        if (lastTransfer == 0 || block.timestamp >= lastTransfer + cooldownSeconds) {
            return 0;
        }

        return (lastTransfer + cooldownSeconds) - block.timestamp;
    }

    /**
     * @dev Check if large transfer is approved
     */
    function isLargeTransferApproved(address _from, address _to, uint256 _value) external view returns (bool) {
        bytes32 transferHash = _getTransferHash(_from, _to, _value);
        return _approvedLargeTransfers[transferHash] && block.timestamp <= _largeTransferExpiry[transferHash];
    }

    /**
     * @dev Get large transfer expiry time
     */
    function getLargeTransferExpiry(address _from, address _to, uint256 _value) external view returns (uint256) {
        bytes32 transferHash = _getTransferHash(_from, _to, _value);
        return _largeTransferExpiry[transferHash];
    }

    /**
     * @dev Check transfer cooldown for investor
     */
    function _checkTransferCooldown(address _investor) private view returns (bool) {
        uint256 lastTransfer = _lastTransferTime[_investor];

        // No previous transfer - always allow first transfer
        if (lastTransfer == 0) {
            return true;
        }

        uint256 cooldownMinutes = _investorTypeRegistry.getTransferCooldown(_investor);
        uint256 cooldownSeconds = cooldownMinutes * 60;

        // Check if cooldown period has passed
        return block.timestamp >= lastTransfer + cooldownSeconds;
    }

    /**
     * @dev Generate hash for transfer approval tracking
     */
    function _getTransferHash(address _from, address _to, uint256 _value) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(_from, _to, _value));
    }

    /**
     * @dev Get transfer cooldown violation details
     */
    function getTransferCooldownViolation(
        address _investor
    ) external view returns (bool hasViolation, uint256 remainingCooldown, uint256 lastTransferTime) {
        uint256 remaining = this.getRemainingCooldown(_investor);
        return (remaining > 0, remaining, _lastTransferTime[_investor]);
    }

    /**
     * @dev Check if an address is a trusted contract
     * @return Always returns false - this compliance module doesn't use trusted contracts
     */
    function isTrustedContract(address /* contractAddress */) external pure returns (bool) {
        // This compliance module doesn't implement trusted contracts
        // Return false for all addresses
        return false;
    }
}
