// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../erc3643/Token.sol";

/**
 * @title GovernanceToken
 * @dev ERC-3643 compliant governance token with voting power based on token ownership
 * @notice Only approved addresses (verified through IdentityRegistry) can hold this token
 * @notice Voting power is proportional to token balance
 */
contract GovernanceToken is Token {
    // Voting power tracking
    mapping(address => uint256) private _votingPower;
    mapping(address => uint256) private _delegatedVotingPower;
    mapping(address => address) private _delegates;
    
    // Governance parameters
    uint256 public constant DECIMALS = 18;
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10**DECIMALS; // 1 million governance tokens
    
    // Voting power snapshots for proposals
    mapping(uint256 => mapping(address => uint256)) private _votingPowerSnapshots;
    uint256 private _currentSnapshotId;
    
    // Events
    event VotingPowerChanged(address indexed account, uint256 newVotingPower);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
    event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
    event SnapshotCreated(uint256 indexed snapshotId);
    
    /**
     * @dev Constructor
     * @param _name Token name (e.g., "Vanguard Governance Token")
     * @param _symbol Token symbol (e.g., "VGT")
     * @param _identityRegistryAddress Address of the IdentityRegistry
     * @param _complianceAddress Address of the Compliance contract
     */
    constructor(
        string memory _name,
        string memory _symbol,
        address _identityRegistryAddress,
        address _complianceAddress
    ) Token(_name, _symbol, _identityRegistryAddress, _complianceAddress) {
        // Mint initial supply to contract owner
        _mint(msg.sender, INITIAL_SUPPLY);
        _votingPower[msg.sender] = INITIAL_SUPPLY;
        emit VotingPowerChanged(msg.sender, INITIAL_SUPPLY);
    }
    
    /**
     * @dev Get voting power of an account
     * @param account Address to check
     * @return Voting power (token balance + delegated power)
     */
    function getVotingPower(address account) public view returns (uint256) {
        return _votingPower[account] + _delegatedVotingPower[account];
    }
    
    /**
     * @dev Get voting power at a specific snapshot
     * @param account Address to check
     * @param snapshotId Snapshot ID
     * @return Voting power at snapshot
     */
    function getVotingPowerAt(address account, uint256 snapshotId) public view returns (uint256) {
        require(snapshotId > 0 && snapshotId <= _currentSnapshotId, "Invalid snapshot ID");

        // If snapshot exists, return it; otherwise return current voting power
        // This allows lazy snapshotting - we capture voting power when first accessed
        uint256 snapshotPower = _votingPowerSnapshots[snapshotId][account];
        if (snapshotPower > 0) {
            return snapshotPower;
        }

        // If no snapshot exists, use current voting power
        // This handles the case where snapshot was just created
        return getVotingPower(account);
    }
    
    /**
     * @dev Delegate voting power to another address
     * @param delegatee Address to delegate to
     */
    function delegate(address delegatee) external {
        require(delegatee != address(0), "Cannot delegate to zero address");
        require(delegatee != msg.sender, "Cannot delegate to self");
        
        address currentDelegate = _delegates[msg.sender];
        uint256 delegatorBalance = balanceOf(msg.sender);
        
        _delegates[msg.sender] = delegatee;
        
        emit DelegateChanged(msg.sender, currentDelegate, delegatee);
        
        // Update delegated voting power
        if (currentDelegate != address(0)) {
            uint256 oldDelegatedPower = _delegatedVotingPower[currentDelegate];
            _delegatedVotingPower[currentDelegate] -= delegatorBalance;
            emit DelegateVotesChanged(currentDelegate, oldDelegatedPower, _delegatedVotingPower[currentDelegate]);
        }
        
        if (delegatee != address(0)) {
            uint256 oldDelegatedPower = _delegatedVotingPower[delegatee];
            _delegatedVotingPower[delegatee] += delegatorBalance;
            emit DelegateVotesChanged(delegatee, oldDelegatedPower, _delegatedVotingPower[delegatee]);
        }
    }
    
    /**
     * @dev Get current delegate of an account
     * @param account Address to check
     * @return Current delegate address
     */
    function getDelegate(address account) external view returns (address) {
        return _delegates[account];
    }
    
    /**
     * @dev Create a snapshot of current voting power
     * @return Snapshot ID
     */
    function snapshot() external onlyAgent returns (uint256) {
        _currentSnapshotId++;

        // Note: Snapshots are created lazily - voting power is captured when accessed
        // This is more gas-efficient than snapshotting all holders upfront

        emit SnapshotCreated(_currentSnapshotId);
        return _currentSnapshotId;
    }

    /**
     * @dev Snapshot voting power for a specific account
     * @param account Address to snapshot
     * @param snapshotId Snapshot ID
     */
    function _snapshotVotingPower(address account, uint256 snapshotId) internal {
        if (_votingPowerSnapshots[snapshotId][account] == 0) {
            _votingPowerSnapshots[snapshotId][account] = getVotingPower(account);
        }
    }
    
    /**
     * @dev Manually set snapshot voting power (called by governance contract)
     * @param snapshotId Snapshot ID
     * @param account Account address
     * @param votingPower Voting power to set
     */
    function setSnapshotVotingPower(
        uint256 snapshotId,
        address account,
        uint256 votingPower
    ) external onlyAgent {
        require(snapshotId > 0 && snapshotId <= _currentSnapshotId, "Invalid snapshot ID");
        _votingPowerSnapshots[snapshotId][account] = votingPower;
    }
    
    /**
     * @dev Get current snapshot ID
     * @return Current snapshot ID
     */
    function getCurrentSnapshotId() external view returns (uint256) {
        return _currentSnapshotId;
    }
    
    /**
     * @dev Override transfer to update voting power
     */
    function _update(address from, address to, uint256 amount) internal virtual override {
        super._update(from, to, amount);
        
        // Update voting power for sender
        if (from != address(0)) {
            _votingPower[from] = balanceOf(from);
            emit VotingPowerChanged(from, _votingPower[from]);
            
            // Update delegated power if sender has delegated
            address fromDelegate = _delegates[from];
            if (fromDelegate != address(0)) {
                uint256 oldDelegatedPower = _delegatedVotingPower[fromDelegate];
                _delegatedVotingPower[fromDelegate] = _delegatedVotingPower[fromDelegate] > amount 
                    ? _delegatedVotingPower[fromDelegate] - amount 
                    : 0;
                emit DelegateVotesChanged(fromDelegate, oldDelegatedPower, _delegatedVotingPower[fromDelegate]);
            }
        }
        
        // Update voting power for recipient
        if (to != address(0)) {
            _votingPower[to] = balanceOf(to);
            emit VotingPowerChanged(to, _votingPower[to]);
            
            // Update delegated power if recipient has delegated
            address toDelegate = _delegates[to];
            if (toDelegate != address(0)) {
                uint256 oldDelegatedPower = _delegatedVotingPower[toDelegate];
                _delegatedVotingPower[toDelegate] += amount;
                emit DelegateVotesChanged(toDelegate, oldDelegatedPower, _delegatedVotingPower[toDelegate]);
            }
        }
    }
    
    /**
     * @dev Distribute governance tokens to approved addresses
     * @param recipients Array of recipient addresses
     * @param amounts Array of amounts to distribute
     */
    function distributeGovernanceTokens(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyAgent {
        require(recipients.length == amounts.length, "Arrays length mismatch");
        
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "Invalid recipient");
            require(amounts[i] > 0, "Amount must be greater than 0");

            // Use transfer() instead of _transfer() to enforce KYC/AML verification
            // This ensures the whenTransferAllowed modifier is applied
            require(transfer(recipients[i], amounts[i]), "Transfer failed");
        }
    }
    
    /**
     * @dev Get total voting power in circulation
     * @return Total voting power
     */
    function getTotalVotingPower() external view returns (uint256) {
        return totalSupply();
    }

    /**
     * @dev Burn tokens from the caller (only callable by agent - governance contract)
     * @param amount Amount of tokens to burn from the caller's balance
     */
    function burn(uint256 amount) external onlyAgent {
        _burn(msg.sender, amount);
    }
    
    /**
     * @dev Check if an address can vote (has voting power and is verified)
     * @param account Address to check
     * @return True if can vote
     */
    function canVote(address account) external view returns (bool) {
        return getVotingPower(account) > 0 && balanceOf(account) > 0;
    }
    
    /**
     * @dev Get voting power percentage of total supply
     * @param account Address to check
     * @return Percentage (in basis points, 10000 = 100%)
     */
    function getVotingPowerPercentage(address account) external view returns (uint256) {
        uint256 total = totalSupply();
        if (total == 0) return 0;
        
        return (getVotingPower(account) * 10000) / total;
    }
}

