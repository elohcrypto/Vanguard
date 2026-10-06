// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../erc3643/Token.sol";

/**
 * @title GovernanceToken
 * @dev ERC-3643 compliant governance token (VGT). Governance spends it as the
 * proposal and vote fee; it is not a vote weight.
 * @notice Only approved addresses (verified through IdentityRegistry) can hold this token
 * @notice Voting power is recorded here (own balance plus balance delegated
 * in), but votes are one per verified identity: VanguardGovernance never
 * reads voting power.
 *
 * TODO(D12, 2026-10-06): recorded, not counted. Governance counts one vote
 * per verified identity (VanguardGovernance.castVote, votesFor += 1) and
 * never reads voting power; delegation is bookkeeping for a future proposal:
 * wire into castVote after the external audit (a delegate votes for its
 * delegators, checkpointed per proposal), see plan v2 Task 4.6 / D12.
 * Covers delegate, getDelegate, getVotingPower, getTotalVotingPower, canVote
 * and getVotingPowerPercentage; test/governance/DelegationNoEffect.test.ts
 * pins the "today" behaviour that the wiring would change.
 */
contract GovernanceToken is Token {
    // Voting power tracking
    mapping(address => uint256) private _delegatedVotingPower;
    mapping(address => address) private _delegates;
    
    // Governance parameters
    uint256 public constant DECIMALS = 18;
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10**DECIMALS; // 1 million governance tokens
    
    // Events
    event VotingPowerChanged(address indexed account, uint256 newVotingPower);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
    event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
    
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
    }
    
    /**
     * @dev Get voting power of an account
     * @param account Address to check
     * @return Voting power (token balance + delegated power)
     * TODO(D12, 2026-10-06): recorded, not counted; see the contract NatSpec.
     */
    function getVotingPower(address account) public view returns (uint256) {
        // Own balance plus power delegated in. A private mirror of balanceOf
        // used to be written on every transfer (two extra SSTOREs) and read
        // here; it could never differ from balanceOf, so it is gone.
        return balanceOf(account) + _delegatedVotingPower[account];
    }
    
    // There is deliberately no balance-at-a-point-in-time lookup here.
    // A snapshot API (snapshot / getVotingPowerAt / setSnapshotVotingPower)
    // used to exist; nothing ever wrote the historical mapping, so every read
    // fell through to the CURRENT balance while presenting itself as history,
    // and an agent could write arbitrary numbers into storage nothing read.
    // Governance counts one vote per verified person and never reads voting
    // power. If token-weighted, checkpointed voting is ever wanted, use
    // OpenZeppelin ERC20Votes rather than reviving that design.

    /**
     * @dev Delegate voting power to another address
     * @param delegatee Address to delegate to
     * TODO(D12, 2026-10-06): recorded, not counted; see the contract NatSpec.
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
     * TODO(D12, 2026-10-06): recorded, not counted; see the contract NatSpec.
     */
    function getDelegate(address account) external view returns (address) {
        return _delegates[account];
    }
    
    /**
     * @dev Override transfer to update voting power
     */
    function _update(address from, address to, uint256 amount) internal virtual override {
        super._update(from, to, amount);
        
        // Update voting power for sender
        if (from != address(0)) {
            emit VotingPowerChanged(from, balanceOf(from));

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
            emit VotingPowerChanged(to, balanceOf(to));

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
     * TODO(D12, 2026-10-06): recorded, not counted; see the contract NatSpec.
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
    
    // D23: ops keeps the agent role (issuance, voter compliance) but cannot
    // freeze, partially freeze, burn or recover the VGT of a trusted
    // contract such as governance, nor recover a wallet into it. Each would stop voting or drain locked fees, and no vote
    // could undo it because voting itself would be blocked.
    function _checkAgentTarget(address target) internal view override {
        require(!_compliance.isTrustedContract(target), "GovernanceToken: trusted contract");
    }

    // D24: a pause by vote could never be voted away, because every proposal
    // and vote needs an unpaused transferFrom. An agent (ops) can release a
    // pause, never impose one: pause stays owner-or-guardian.
    function _canUnpause(address account) internal view override returns (bool) {
        return isAgent(account);
    }

    /**
     * @dev Token-side eligibility: the account is verified in this token's
     * identity registry and holds VGT. Governance adds its own checks on top
     * (the wallet holds a key on its identity, minimum identity age, vote
     * cost and allowance, one vote per identity, the proposer's identity
     * excluded), so true here does not mean castVote succeeds. Delegated-in
     * power alone does not make an account eligible.
     * @param account Address to check
     * @return True if verified and holding VGT
     * TODO(D12, 2026-10-06): recorded, not counted; see the contract NatSpec.
     */
    function canVote(address account) external view returns (bool) {
        return
            IIdentityRegistry(this.identityRegistry()).isVerified(account) &&
            balanceOf(account) > 0;
    }
    
    /**
     * @dev Get voting power percentage of total supply
     * @param account Address to check
     * @return Percentage (in basis points, 10000 = 100%)
     * TODO(D12, 2026-10-06): recorded, not counted; see the contract NatSpec.
     */
    function getVotingPowerPercentage(address account) external view returns (uint256) {
        uint256 total = totalSupply();
        if (total == 0) return 0;
        
        return (getVotingPower(account) * 10000) / total;
    }
}

