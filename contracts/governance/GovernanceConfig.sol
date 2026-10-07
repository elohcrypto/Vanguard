// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./GovernanceToken.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";

/**
 * @title GovernanceConfig
 * @dev The configuration half of VanguardGovernance (split by inheritance,
 *      plan Task 4.8): proposal types and records, the per-type thresholds,
 *      the bound target of each type, the costs and the voter age, and the
 *      owner (governance-controlled) setters for all of them. VanguardGovernance
 *      is the only contract deployed.
 */
abstract contract GovernanceConfig is Ownable2Step {
    // Enums
    enum ProposalType {
        InvestorTypeConfig,
        ComplianceRules,
        OracleParameters,
        TokenParameters,
        SystemParameters,
        EmergencyAction,
        // Index 6: moves a member between whitelist and blacklist. Bound to the
        // DynamicListManager; calldata is a plain call on one of its four
        // add/remove functions, which write the WhitelistOracle/BlacklistOracle
        // that ComplianceRules reads (plan 2D.1, D6').
        ListUpdate,
        // Index 7: governs the IdentityRegistry's onlyOwner surface (claim
        // topics, trusted issuers, agents, compliance/investor-type wiring).
        IdentityRegistryParameters,
        // Index 8: governs the vote token's owner surface (plan 2C.2, D19).
        GovernanceTokenParameters,
        // Index 9: the EscrowWalletFactory's owner surface (fee wallet,
        // registry, rules); index 10: the OnchainIDFactory's (fees, pause,
        // withdraw). Bound only while the factory is handed to governance
        // (plan 2F.5, M4).
        EscrowFactoryParameters,
        IdentityFactoryParameters,
        // Index 11: the PrivacyManager's owner surface (whitelist root,
        // listOperator, validity period, verifier); index 12: the
        // ZKVerifierIntegrated's (updateVerifier, cache expiry). Bound only
        // while handed to governance (plan 3.3, R-3R-3/R-3R-4).
        PrivacyParameters,
        VerifierParameters
    }
    
    enum ProposalStatus {
        Pending,
        Active,
        Approved,
        Rejected,
        Executed,
        Cancelled
    }
    
    // Structures
    struct ProposalThresholds {
        uint256 quorumPercentage;      // Percentage of total voting power required (basis points)
        uint256 approvalPercentage;    // Percentage of votes needed to approve (basis points)
        uint256 votingPeriod;          // Voting period in seconds
        uint256 executionDelay;        // Delay before execution in seconds
    }
    
    struct Proposal {
        uint256 id;
        ProposalType proposalType;
        string title;
        string description;
        address target;
        bytes callData;
        address proposer;
        uint256 createdAt;
        uint256 votingEnds;
        uint256 executionTime;
        ProposalStatus status;
        uint256 votesFor;
        uint256 votesAgainst;
        // Eligible-voter count captured when the proposal was created.
        //
        // Quorum previously read identityRegistry.registeredIdentityCount() at
        // EXECUTION time. Agents can register and delete identities while a
        // vote is open, so the denominator — and therefore the outcome of an
        // already-cast vote — could be changed after the fact: register
        // identities to push a proposal below quorum, or delete them to lift
        // it above. Freezing the count at creation makes the bar fixed for the
        // life of the proposal.
        //
        // Since plan 2F.1 it is the count at voterAgeCutoff, so identities too
        // young to vote do not raise the bar either.
        uint256 eligibleVotersAtCreation;
        // Identity of the proposer; it may not vote on its own proposal.
        address proposerIdentity;
        // Only identities registered at or before this time may vote:
        // createdAt - minVoterAge, frozen so a later setMinVoterAge does not
        // move an open proposal's electorate.
        uint256 voterAgeCutoff;
    }
    
    // State variables
    GovernanceToken public governanceToken;
    IIdentityRegistry public identityRegistry;

    // Proposal type thresholds
    mapping(ProposalType => ProposalThresholds) public proposalThresholds;

    // Target contracts
    address public investorTypeRegistry;
    address public complianceRules;
    address public oracleManager;
    address public token;
    address public dynamicListManager; // DynamicListManager: bound target of ListUpdate
    address public escrowWalletFactory; // bound target of EscrowFactoryParameters
    address public onchainIDFactory; // bound target of IdentityFactoryParameters
    address public privacyManager; // bound target of PrivacyParameters
    address public zkVerifier; // bound target of VerifierParameters

    /// @notice Divisor applied to every proposal type's votingPeriod and
    ///         executionDelay at construction. 1 = the mainnet schedule.
    uint256 public immutable TIME_SCALE;

    // Economic parameters (governance-controlled)
    uint256 public proposalCreationCost = 10 * 10**18; // 10 VGT to create proposal
    uint256 public votingCost = 10 * 10**18; // 10 VGT per vote

    /// @dev Upper bound for both costs. Without it the owner could set a
    ///      cost above every holder's balance and freeze governance with
    ///      one call. 1000 VGT is 100x the default; the exact ceiling is a
    ///      product decision and only needs to block the freeze.
    uint256 public constant MAX_COST = 1000 * 10**18;

    /// @notice Minimum identity age to propose or vote (D25, plan 2F.1):
    ///         an identity votes on a proposal only if the registry bound it
    ///         at least this long before the proposal was created. Fresh fake
    ///         identities (registry agent plus issuer collusion) therefore
    ///         neither vote nor count toward quorum, and the honest electorate
    ///         has this window to vote the colluding keys out. 7 days, divided
    ///         by TIME_SCALE like every other duration.
    uint256 public minVoterAge;

    event ProposalThresholdsUpdated(ProposalType indexed proposalType);
    event ProposalCreationCostUpdated(uint256 oldCost, uint256 newCost);
    event VotingCostUpdated(uint256 oldCost, uint256 newCost);
    event MinVoterAgeUpdated(uint256 oldAge, uint256 newAge);

    error CostOutOfRange(uint256 requested, uint256 max);
    error TimeScaleOutOfRange(uint256 requested);
    error VoterAgeOutOfRange(uint256 requested, uint256 min, uint256 max);

    constructor(uint256 _timeScale) {
        // Divides every voting period and execution delay. 1 on mainnet.
        // A testnet has no evm_increaseTime, so a 7-day vote would take
        // 7 days; scale 336 makes it 30 minutes. Percentages are untouched.
        // Ceiling 1440: the shortest duration in the table is 1 day, and
        // integer division must leave it >= 60s. Beyond that a delay floors
        // to 0 and a vote to a couple of seconds, which is unvotable.
        if (_timeScale < 1 || _timeScale > 1440) revert TimeScaleOutOfRange(_timeScale);
        TIME_SCALE = _timeScale;
    }

    /**
     * @notice The single contract a proposal type may target. address(0) means
     *         the type cannot be used with createProposal (EmergencyAction has
     *         no bound target yet). ListUpdate is bound to the DynamicListManager,
     *         so it is unproposable until setDynamicListManager runs.
     *         IdentityRegistryParameters is bound to the IdentityRegistry;
     *         GovernanceTokenParameters is bound to the GovernanceToken (VGT).
     *         EscrowFactoryParameters / IdentityFactoryParameters are bound to
     *         the factories once setEscrowWalletFactory / setOnchainIDFactory ran;
     *         PrivacyParameters / VerifierParameters to the PrivacyManager and
     *         ZKVerifierIntegrated once setPrivacyManager / setZKVerifier ran.
     */
    function boundTarget(ProposalType proposalType) public view returns (address) {
        if (proposalType == ProposalType.InvestorTypeConfig) return investorTypeRegistry;
        if (proposalType == ProposalType.ComplianceRules) return complianceRules;
        if (proposalType == ProposalType.OracleParameters) return oracleManager;
        if (proposalType == ProposalType.TokenParameters) return token;
        if (proposalType == ProposalType.SystemParameters) return address(this);
        if (proposalType == ProposalType.ListUpdate) return dynamicListManager;
        if (proposalType == ProposalType.IdentityRegistryParameters) return address(identityRegistry);
        if (proposalType == ProposalType.GovernanceTokenParameters) return address(governanceToken);
        if (proposalType == ProposalType.EscrowFactoryParameters) return escrowWalletFactory;
        if (proposalType == ProposalType.IdentityFactoryParameters) return onchainIDFactory;
        if (proposalType == ProposalType.PrivacyParameters) return privacyManager;
        if (proposalType == ProposalType.VerifierParameters) return zkVerifier;
        return address(0);
    }

    /**
     * @dev Initialize default thresholds for each proposal type
     */
    function _initializeThresholds() internal {
        // InvestorTypeConfig: 20% quorum, 60% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.InvestorTypeConfig] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6000,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // ComplianceRules: 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.ComplianceRules] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // OracleParameters: 20% quorum, 60% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.OracleParameters] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6000,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // TokenParameters: 30% quorum, 70% approval, 7 days voting, 3 days delay
        proposalThresholds[ProposalType.TokenParameters] = ProposalThresholds({
            quorumPercentage: 3000,
            approvalPercentage: 7000,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 3 days / TIME_SCALE
        });
        
        // SystemParameters: 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.SystemParameters] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // EmergencyAction: 10% quorum, 75% approval, 3 days voting, 1 day delay
        proposalThresholds[ProposalType.EmergencyAction] = ProposalThresholds({
            quorumPercentage: 1000,
            approvalPercentage: 7500,
            votingPeriod: 3 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
        });

        // ListUpdate: 20% quorum, 70% approval, 5 days voting, 1 day delay.
        // One type now covers both whitelisting and sanctions listing, so it
        // takes the strictest of the four old list rows (AddToBlacklist)
        // (plan 2D.1, D6').
        proposalThresholds[ProposalType.ListUpdate] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 7000,
            votingPeriod: 5 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
        });

        // IdentityRegistryParameters: reuses the ComplianceRules row (plan 2B.2)
        // 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.IdentityRegistryParameters] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });

        // GovernanceTokenParameters: reuses the TokenParameters row (plan 2C.2, D19)
        // 30% quorum, 70% approval, 7 days voting, 3 days delay
        proposalThresholds[ProposalType.GovernanceTokenParameters] = ProposalThresholds({
            quorumPercentage: 3000,
            approvalPercentage: 7000,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 3 days / TIME_SCALE
        });

        // Both factory types reuse the TokenParameters row (plan 2F.5): the
        // escrow factory's owner is written into every escrow and receives
        // platform fees. 30% quorum, 70% approval, 7 days voting, 3 days delay
        ProposalThresholds memory tokenRow = proposalThresholds[ProposalType.TokenParameters];
        proposalThresholds[ProposalType.EscrowFactoryParameters] = tokenRow;
        proposalThresholds[ProposalType.IdentityFactoryParameters] = tokenRow;
        // The privacy contracts too (plan 3.3): the verifier decides what a
        // whitelist proof is worth once ZK gates transfers.
        proposalThresholds[ProposalType.PrivacyParameters] = tokenRow;
        proposalThresholds[ProposalType.VerifierParameters] = tokenRow;
    }

    /**
     * @dev Update proposal creation cost (governance-controlled)
     * @param newCost New cost in VGT tokens
     */
    function setProposalCreationCost(uint256 newCost) external onlyOwner {
        if (newCost == 0 || newCost > MAX_COST) revert CostOutOfRange(newCost, MAX_COST);
        emit ProposalCreationCostUpdated(proposalCreationCost, newCost);
        proposalCreationCost = newCost;
    }

    /**
     * @dev Update voting cost (governance-controlled)
     * @param newCost New cost in VGT tokens
     */
    function setVotingCost(uint256 newCost) external onlyOwner {
        if (newCost == 0 || newCost > MAX_COST) revert CostOutOfRange(newCost, MAX_COST);
        emit VotingCostUpdated(votingCost, newCost);
        votingCost = newCost;
    }

    /**
     * @notice Tune the minimum identity age. Bounded to [1 day, 30 days]
     *         divided by TIME_SCALE, so a vote may adjust it but never
     *         disable it. Open proposals keep the cutoff they were created with.
     */
    function setMinVoterAge(uint256 newAge) external onlyOwner {
        uint256 lo = 1 days / TIME_SCALE;
        uint256 hi = 30 days / TIME_SCALE;
        if (newAge < lo || newAge > hi) revert VoterAgeOutOfRange(newAge, lo, hi);
        emit MinVoterAgeUpdated(minVoterAge, newAge);
        minVoterAge = newAge;
    }

    /**
     * @dev Set DynamicListManager contract address
     * @param _dynamicListManager DynamicListManager contract address
     */
    function setDynamicListManager(address _dynamicListManager) external onlyOwner {
        require(_dynamicListManager != address(0), "Invalid address");
        dynamicListManager = _dynamicListManager;
    }

    /// @notice Bind EscrowFactoryParameters. Only a factory being handed to
    ///         governance (pendingOwner or owner is this contract) can be
    ///         bound, as a ListUpdate needs a manager that reports governance.
    function setEscrowWalletFactory(address factory) external onlyOwner {
        _requireHandedToGovernance(factory);
        escrowWalletFactory = factory;
    }

    /// @notice Bind IdentityFactoryParameters; same rule as the escrow factory.
    function setOnchainIDFactory(address factory) external onlyOwner {
        _requireHandedToGovernance(factory);
        onchainIDFactory = factory;
    }

    /// @notice Bind PrivacyParameters; same rule as the factories.
    function setPrivacyManager(address manager) external onlyOwner {
        _requireHandedToGovernance(manager);
        privacyManager = manager;
    }

    /// @notice Bind VerifierParameters; same rule as the factories.
    function setZKVerifier(address verifier) external onlyOwner {
        _requireHandedToGovernance(verifier);
        zkVerifier = verifier;
    }

    /// @dev Fails closed: no code or a reverting getter is "not handed".
    function _requireHandedToGovernance(address target) private view {
        require(target.code.length > 0, "Target not handed to governance");
        bool handed;
        try Ownable2Step(target).pendingOwner() returns (address p) {
            handed = p == address(this);
        } catch {}
        if (!handed) {
            try Ownable(target).owner() returns (address o) {
                handed = o == address(this);
            } catch {}
        }
        require(handed, "Target not handed to governance");
    }
}
