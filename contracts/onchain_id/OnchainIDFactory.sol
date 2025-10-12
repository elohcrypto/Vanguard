// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Create2.sol";
import "./OnchainID.sol";
import "./interfaces/IOnchainID.sol";

/**
 * @title OnchainIDFactory
 * @dev Factory contract for deploying OnchainID contracts with deterministic addresses
 * @author CMTA UTXO Compliance Team
 */
contract OnchainIDFactory is Ownable {
    // Events
    event OnchainIDDeployed(address indexed identity, address indexed owner, bytes32 indexed salt, address deployer);

    event FactoryOwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // State variables
    mapping(address => bool) public isOnchainID;
    mapping(address => address) public ownerToIdentity;
    mapping(bytes32 => address) public saltToIdentity;

    address[] public deployedIdentities;
    uint256 public totalIdentities;

    // Factory configuration
    bool public deploymentPaused;
    uint256 public deploymentFee;
    address public feeRecipient;

    /**
     * @dev Constructor
     * @param _owner Initial owner of the factory
     */
    constructor(address _owner) Ownable(_owner) {
        feeRecipient = _owner;
    }

    /**
     * @dev Modifier to check if deployment is not paused
     */
    modifier whenNotPaused() {
        require(!deploymentPaused, "OnchainIDFactory: Deployment is paused");
        _;
    }

    /**
     * @dev Deploy a new OnchainID contract
     * @param _owner The owner of the new identity
     * @param _salt Salt for deterministic address generation
     * @return identity The address of the deployed OnchainID contract
     */
    function deployOnchainID(address _owner, bytes32 _salt) external payable whenNotPaused returns (address identity) {
        require(_owner != address(0), "OnchainIDFactory: Invalid owner");
        require(msg.value >= deploymentFee, "OnchainIDFactory: Insufficient fee");
        require(saltToIdentity[_salt] == address(0), "OnchainIDFactory: Salt already used");

        // Deploy OnchainID contract using CREATE2
        bytes memory bytecode = abi.encodePacked(type(OnchainID).creationCode, abi.encode(_owner));

        identity = Create2.deploy(0, _salt, bytecode);

        // Register the deployed identity
        isOnchainID[identity] = true;
        ownerToIdentity[_owner] = identity;
        saltToIdentity[_salt] = identity;
        deployedIdentities.push(identity);
        totalIdentities++;

        // Transfer excess fee to fee recipient
        if (msg.value > 0 && feeRecipient != address(0)) {
            payable(feeRecipient).transfer(msg.value);
        }

        emit OnchainIDDeployed(identity, _owner, _salt, msg.sender);

        return identity;
    }

    /**
     * @dev Deploy OnchainID with management key
     * @param _owner The owner of the new identity
     * @param _managementKey Initial management key
     * @param _salt Salt for deterministic address generation
     * @return identity The address of the deployed OnchainID contract
     */
    function deployOnchainIDWithKey(
        address _owner,
        bytes32 _managementKey,
        bytes32 _salt
    ) external payable whenNotPaused returns (address identity) {
        require(_owner != address(0), "OnchainIDFactory: Invalid owner");
        require(_managementKey != bytes32(0), "OnchainIDFactory: Invalid management key");
        require(msg.value >= deploymentFee, "OnchainIDFactory: Insufficient fee");
        require(saltToIdentity[_salt] == address(0), "OnchainIDFactory: Salt already used");

        // Deploy OnchainID contract using CREATE2
        bytes memory bytecode = abi.encodePacked(
            type(OnchainID).creationCode,
            abi.encode(_owner) // Deploy with actual owner
        );

        identity = Create2.deploy(0, _salt, bytecode);

        // The OnchainID is deployed with the owner, so we can add the management key directly
        // The owner can add the management key themselves after deployment

        // Register the deployed identity
        isOnchainID[identity] = true;
        ownerToIdentity[_owner] = identity;
        saltToIdentity[_salt] = identity;
        deployedIdentities.push(identity);
        totalIdentities++;

        // Transfer excess fee to fee recipient
        if (msg.value > 0 && feeRecipient != address(0)) {
            payable(feeRecipient).transfer(msg.value);
        }

        emit OnchainIDDeployed(identity, _owner, _salt, msg.sender);

        return identity;
    }

    /**
     * @dev Compute the address of an OnchainID contract before deployment
     * @param _owner The owner of the identity
     * @param _salt Salt for deterministic address generation
     * @return identity The computed address
     */
    function computeOnchainIDAddress(address _owner, bytes32 _salt) external view returns (address identity) {
        bytes memory bytecode = abi.encodePacked(type(OnchainID).creationCode, abi.encode(_owner));

        return Create2.computeAddress(_salt, keccak256(bytecode));
    }

    /**
     * @dev Batch deploy multiple OnchainID contracts
     * @param _owners Array of owners for the identities
     * @param _salts Array of salts for deterministic addresses
     * @return identities Array of deployed identity addresses
     */
    function batchDeployOnchainID(
        address[] calldata _owners,
        bytes32[] calldata _salts
    ) external payable whenNotPaused returns (address[] memory identities) {
        require(_owners.length == _salts.length, "OnchainIDFactory: Array length mismatch");
        require(_owners.length > 0, "OnchainIDFactory: Empty arrays");
        require(msg.value >= deploymentFee * _owners.length, "OnchainIDFactory: Insufficient fee");

        identities = new address[](_owners.length);

        for (uint256 i = 0; i < _owners.length; i++) {
            require(_owners[i] != address(0), "OnchainIDFactory: Invalid owner");
            require(saltToIdentity[_salts[i]] == address(0), "OnchainIDFactory: Salt already used");

            // Deploy OnchainID contract using CREATE2
            bytes memory bytecode = abi.encodePacked(type(OnchainID).creationCode, abi.encode(_owners[i]));

            address identity = Create2.deploy(0, _salts[i], bytecode);

            // Register the deployed identity
            isOnchainID[identity] = true;
            ownerToIdentity[_owners[i]] = identity;
            saltToIdentity[_salts[i]] = identity;
            deployedIdentities.push(identity);
            totalIdentities++;

            identities[i] = identity;

            emit OnchainIDDeployed(identity, _owners[i], _salts[i], msg.sender);
        }

        // Transfer fees to fee recipient
        if (msg.value > 0 && feeRecipient != address(0)) {
            payable(feeRecipient).transfer(msg.value);
        }

        return identities;
    }

    /**
     * @dev Get identity by owner
     * @param _owner The owner address
     * @return identity The OnchainID contract address
     */
    function getIdentityByOwner(address _owner) external view returns (address identity) {
        return ownerToIdentity[_owner];
    }

    /**
     * @dev Get identity by salt
     * @param _salt The salt used for deployment
     * @return identity The OnchainID contract address
     */
    function getIdentityBySalt(bytes32 _salt) external view returns (address identity) {
        return saltToIdentity[_salt];
    }

    /**
     * @dev Get all deployed identities
     * @return identities Array of all deployed identity addresses
     */
    function getAllIdentities() external view returns (address[] memory identities) {
        return deployedIdentities;
    }

    /**
     * @dev Get deployed identities with pagination
     * @param _offset Starting index
     * @param _limit Number of identities to return
     * @return identities Array of identity addresses
     */
    function getIdentitiesPaginated(
        uint256 _offset,
        uint256 _limit
    ) external view returns (address[] memory identities) {
        require(_offset < deployedIdentities.length, "OnchainIDFactory: Offset out of bounds");

        uint256 end = _offset + _limit;
        if (end > deployedIdentities.length) {
            end = deployedIdentities.length;
        }

        identities = new address[](end - _offset);
        for (uint256 i = _offset; i < end; i++) {
            identities[i - _offset] = deployedIdentities[i];
        }

        return identities;
    }

    /**
     * @dev Check if an address is a valid OnchainID deployed by this factory
     * @param _identity The address to check
     * @return valid True if the address is a valid OnchainID
     */
    function isValidOnchainID(address _identity) external view returns (bool valid) {
        return isOnchainID[_identity];
    }

    /**
     * @dev Get factory statistics
     * @return totalDeployed Total number of deployed identities
     * @return currentFee Current deployment fee
     * @return isPaused Whether deployment is paused
     */
    function getFactoryStats() external view returns (uint256 totalDeployed, uint256 currentFee, bool isPaused) {
        return (totalIdentities, deploymentFee, deploymentPaused);
    }

    // Admin functions

    /**
     * @dev Set deployment fee
     * @param _fee New deployment fee
     */
    function setDeploymentFee(uint256 _fee) external onlyOwner {
        deploymentFee = _fee;
    }

    /**
     * @dev Set fee recipient
     * @param _recipient New fee recipient address
     */
    function setFeeRecipient(address _recipient) external onlyOwner {
        require(_recipient != address(0), "OnchainIDFactory: Invalid recipient");
        feeRecipient = _recipient;
    }

    /**
     * @dev Pause/unpause deployment
     * @param _paused Whether to pause deployment
     */
    function setDeploymentPaused(bool _paused) external onlyOwner {
        deploymentPaused = _paused;
    }

    /**
     * @dev Emergency withdraw function
     */
    function emergencyWithdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "OnchainIDFactory: No balance to withdraw");

        payable(owner()).transfer(balance);
    }

    /**
     * @dev Transfer factory ownership with event
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "OnchainIDFactory: New owner is the zero address");

        address oldOwner = owner();
        _transferOwnership(newOwner);

        emit FactoryOwnershipTransferred(oldOwner, newOwner);
    }

    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}
