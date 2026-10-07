// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./GovernanceConfig.sol";
import "../onchain_id/interfaces/IERC734.sol";

/// @dev The one DynamicListManager getter governance checks before a
///      ListUpdate proposal: the manager must report this governance.
interface IGovernedListManager {
    function governanceContract() external view returns (address);
}

/**
 * @title GovernanceProposals
 * @dev The proposal and voting half of VanguardGovernance (split by
 *      inheritance, plan Task 4.8): proposal creation and type binding,
 *      voting and the electorate rule, and the VGT deposits they lock.
 *      VanguardGovernance is the only contract deployed.
 */
abstract contract GovernanceProposals is GovernanceConfig, ReentrancyGuard {
    mapping(uint256 => Proposal) internal _proposals;
    // Keyed by IDENTITY (OnchainID), not wallet: one vote per person.
    mapping(uint256 => mapping(address => bool)) private _hasVoted;
    mapping(uint256 => mapping(address => bool)) private _voteChoice; // true = for, false = against
    mapping(uint256 => address[]) private _proposalVoters; // Track voters for token return

    uint256 private _nextProposalId = 1;

    /**
     * @dev Get the total number of proposals created
     * @return The current proposal count
     */
    function proposalCount() external view returns (uint256) {
        return _nextProposalId - 1;
    }

    /**
     * @dev Check if an address has voted on a proposal
     * @param proposalId The proposal ID
     * @param voter The voter address
     * @return True if the voter has voted, false otherwise
     */
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        address id = identityRegistry.identity(voter);
        return id != address(0) && _hasVoted[proposalId][id];
    }

    // Selectors no proposal may call, on any bound target (L5). transfer,
    // approve and transferFrom would move VGT deposits governance holds for
    // other proposals; renounceOwnership would orphan a bound contract.
    // distributeGovernanceTokens and burn(uint256) are VGT agent functions
    // that spend the CALLER's balance, and governance is a VGT agent (it
    // burns deposits on pass): a vote on either would pay out or destroy
    // every other proposal's deposits, the same drain as transfer (M-2).
    // transferOwnership/acceptOwnership stay allowed: the handover ceremony
    // and a future governance migration need them (A-N3 is an operational rule).
    bytes4 private constant SEL_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant SEL_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant SEL_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 private constant SEL_RENOUNCE = 0x715018a6; // renounceOwnership()
    bytes4 private constant SEL_DISTRIBUTE = 0x18b55856; // distributeGovernanceTokens(address[],uint256[])
    bytes4 private constant SEL_BURN_SELF = 0x42966c68; // burn(uint256)
    // ListUpdate runs under list thresholds, so it may only call the
    // DynamicListManager: its four list writes, its owner surface (oracles,
    // governance address, proof expiry), and the two ownership
    // steps. ListUpdate is the manager's only bound type, so this is the
    // only way a governance-owned manager is reconfigured; the ceremony
    // accepts the manager's ownership under it, and a migration must be
    // able to hand it on.
    bytes4 private constant SEL_TRANSFER_OWNERSHIP = 0xf2fde38b; // transferOwnership(address)
    bytes4 private constant SEL_ACCEPT_OWNERSHIP = 0x79ba5097; // acceptOwnership()
    bytes4 private constant SEL_ADD_WHITELIST =
        bytes4(keccak256("addToWhitelist(address,uint256,uint8,uint256,string)"));
    bytes4 private constant SEL_ADD_BLACKLIST =
        bytes4(keccak256("addToBlacklist(address,uint256,uint8,uint256,string)"));
    bytes4 private constant SEL_REMOVE_WHITELIST =
        bytes4(keccak256("removeFromWhitelist(address,uint256,string)"));
    bytes4 private constant SEL_REMOVE_BLACKLIST =
        bytes4(keccak256("removeFromBlacklist(address,uint256,string)"));
    bytes4 private constant SEL_SET_ORACLES = bytes4(keccak256("setOracles(address,address)"));
    bytes4 private constant SEL_SET_GOVERNANCE = bytes4(keccak256("setGovernanceContract(address)"));
    bytes4 private constant SEL_SET_PROOF_EXPIRY = bytes4(keccak256("setProofExpiryDuration(uint256)"));

    // Token locking tracking.
    //
    // _lockedTokens is the aggregate: burned on pass, zeroed on settlement.
    // _voterLockedTokens is per person. While the proposal is Active it is
    // the deposit; once the proposal is Rejected or Cancelled it is the
    // amount that person may claim via claimRefund(). Settlement never
    // transfers VGT (see _settleWithRefund), so it cannot fail on a
    // recipient the token refuses to pay.
    mapping(uint256 => uint256) internal _lockedTokens; // proposalId => total locked tokens
    mapping(uint256 => mapping(address => uint256)) internal _voterLockedTokens; // proposalId => voter => locked amount

    // Events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        string title
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 votingPower,
        string reason
    );

    /// @notice `target` is not the contract this proposal type governs, or the
    ///         type has no bound target. Thresholds are chosen by type, so an
    ///         unbound target let any action run under the weakest tier.
    error TargetNotBoundToType(ProposalType proposalType, address target);

    /**
     * @dev Create a new proposal
     * @notice Requires payment of proposalCreationCost in VGT tokens
     */
    function createProposal(
        ProposalType proposalType,
        string calldata title,
        string calldata description,
        address target,
        bytes calldata callData
    ) external nonReentrant returns (uint256) {
        uint256 cutoff = block.timestamp > minVoterAge ? block.timestamp - minVoterAge : 0;
        address proposerId = identityRegistry.identity(msg.sender);
        _requireEligible(msg.sender, proposerId, cutoff);

        // Bind the type to the one contract it governs. Thresholds are looked up
        // by type at execution, so with target free a proposer could submit a
        // TokenParameters action (30%/70%/3d) as InvestorTypeConfig (20%/60%/2d)
        // or EmergencyAction (10% quorum) and execute it under the weaker bar.
        address expected = boundTarget(proposalType);
        if (expected == address(0) || target != expected) {
            revert TargetNotBoundToType(proposalType, target);
        }
        _requireAllowedSelector(proposalType, callData);
        if (proposalType == ProposalType.ListUpdate) _requireGovernedListManager(target);

        // Check proposer has enough tokens for creation cost
        require(
            governanceToken.balanceOf(msg.sender) >= proposalCreationCost,
            "Insufficient tokens for proposal creation"
        );

        // Transfer and lock proposal creation cost
        require(
            governanceToken.transferFrom(msg.sender, address(this), proposalCreationCost),
            "Token transfer failed"
        );

        ProposalThresholds memory thresholds = proposalThresholds[proposalType];

        uint256 proposalId = _nextProposalId++;

        _proposals[proposalId] = Proposal({
            id: proposalId,
            proposalType: proposalType,
            title: title,
            description: description,
            target: target,
            callData: callData,
            proposer: msg.sender,
            createdAt: block.timestamp,
            votingEnds: block.timestamp + thresholds.votingPeriod,
            executionTime: block.timestamp + thresholds.votingPeriod + thresholds.executionDelay,
            status: ProposalStatus.Active,
            votesFor: 0,
            votesAgainst: 0,
            eligibleVotersAtCreation: identityRegistry.registeredIdentityCountAt(uint48(cutoff)),
            proposerIdentity: proposerId,
            voterAgeCutoff: cutoff
        });

        // Track locked tokens
        _lockedTokens[proposalId] = proposalCreationCost;
        _voterLockedTokens[proposalId][msg.sender] = proposalCreationCost;

        emit ProposalCreated(proposalId, msg.sender, proposalType, title);

        return proposalId;
    }
    
    /**
     * @dev Cast a vote on a proposal
     * @notice 1 Person = 1 Vote (KYC/AML verified only)
     * @notice Requires payment of votingCost in VGT tokens
     */
    function castVote(
        uint256 proposalId,
        bool support,
        string calldata reason
    ) external nonReentrant {
        Proposal storage proposal = _proposals[proposalId];

        require(proposal.status == ProposalStatus.Active, "Proposal not active");
        require(block.timestamp <= proposal.votingEnds, "Voting period ended");
        // One vote per identity (H1): N wallets on one OnchainID, or a moved
        // identity, still vote once, and the proposer's person cannot vote
        // through another wallet.
        address id = identityRegistry.identity(msg.sender);
        require(id != address(0), "Must be KYC/AML verified");
        require(!_hasVoted[proposalId][id], "Already voted");
        require(id != proposal.proposerIdentity, "Proposer cannot vote on own proposal");
        _requireEligible(msg.sender, id, proposal.voterAgeCutoff);

        // Check voter has enough tokens for voting cost
        require(
            governanceToken.balanceOf(msg.sender) >= votingCost,
            "Insufficient tokens for voting"
        );

        // Transfer and lock voting cost
        require(
            governanceToken.transferFrom(msg.sender, address(this), votingCost),
            "Token transfer failed"
        );

        // Mark as voted (by identity; the deposit below stays per wallet,
        // since that is where the VGT came from)
        _hasVoted[proposalId][id] = true;
        _voteChoice[proposalId][id] = support;

        // Track voter for potential token return
        _proposalVoters[proposalId].push(msg.sender);

        // Track locked tokens
        _lockedTokens[proposalId] += votingCost;
        // +=, not =: votes are keyed by identity, so one wallet can vote
        // twice through two identities (a consenting holder's identity moved
        // onto it after a deletion). Each deposit must stay claimable (L-3).
        _voterLockedTokens[proposalId][msg.sender] += votingCost;

        // 1 Person = 1 Vote (equal voting power)
        if (support) {
            proposal.votesFor += 1;
        } else {
            proposal.votesAgainst += 1;
        }

        emit VoteCast(proposalId, msg.sender, support, 1, reason);
    }
    
    /**
     * @dev `wallet` may propose or vote through identity `id`: verified,
     *      holding a key on the identity, and the identity old enough.
     *
     *      The key check stops the registry agent voting AS an investor by
     *      binding a wallet of its own to the investor's identity: the wallet
     *      must be the OnchainID owner or hold a MANAGEMENT (1) or ACTION (2)
     *      key. OnchainIDFactory deploys every identity owned by the investor
     *      wallet with that wallet as MANAGEMENT key, so investors pass as is.
     */
    function _requireEligible(address wallet, address id, uint256 cutoff) private view {
        require(identityRegistry.isVerified(wallet), "Must be KYC/AML verified");
        require(_controls(wallet, id), "Wallet does not control its identity");
        uint64 registeredAt = identityRegistry.identityRegisteredAt(id);
        require(registeredAt != 0 && registeredAt <= cutoff, "Identity too new to vote");
    }

    /// @dev Selector denylist on every type; ListUpdate is an allowlist.
    function _requireAllowedSelector(ProposalType proposalType, bytes calldata callData) private pure {
        require(callData.length >= 4, "Selector not allowed");
        bytes4 sel = bytes4(callData[:4]);
        require(
            sel != SEL_TRANSFER &&
                sel != SEL_APPROVE &&
                sel != SEL_TRANSFER_FROM &&
                sel != SEL_RENOUNCE &&
                sel != SEL_DISTRIBUTE &&
                sel != SEL_BURN_SELF,
            "Selector not allowed"
        );
        if (proposalType == ProposalType.ListUpdate) {
            require(
                sel == SEL_ADD_WHITELIST ||
                    sel == SEL_ADD_BLACKLIST ||
                    sel == SEL_REMOVE_WHITELIST ||
                    sel == SEL_REMOVE_BLACKLIST ||
                    sel == SEL_SET_ORACLES ||
                    sel == SEL_SET_GOVERNANCE ||
                    sel == SEL_SET_PROOF_EXPIRY ||
                    sel == SEL_TRANSFER_OWNERSHIP ||
                    sel == SEL_ACCEPT_OWNERSHIP,
                "Selector not allowed"
            );
        }
    }

    /**
     * @dev ListUpdate's target must be a list manager that reports this
     *      governance (B-L4). Otherwise a SystemParameters vote could point
     *      dynamicListManager at any governance-owned contract (e.g.
     *      ComplianceRules) and run transferOwnership there at list
     *      thresholds. Checked per proposal, not in setDynamicListManager,
     *      so wiring order does not matter and a later change of the
     *      manager's governanceContract is caught. Fails closed: no code, a
     *      revert, or another address all refuse.
     */
    function _requireGovernedListManager(address target) private view {
        require(target.code.length > 0, "List manager not bound to governance");
        try IGovernedListManager(target).governanceContract() returns (address g) {
            require(g == address(this), "List manager not bound to governance");
        } catch {
            revert("List manager not bound to governance");
        }
    }

    /// @dev Fails closed: no code, or a call that reverts, is "no control".
    function _controls(address wallet, address id) private view returns (bool) {
        if (id.code.length == 0) return false;
        try Ownable(id).owner() returns (address o) {
            if (o == wallet) return true;
        } catch {}
        bytes32 key = keccak256(abi.encodePacked(wallet));
        try IERC734(id).keyHasPurpose(key, 1) returns (bool ok) {
            if (ok) return true;
        } catch {}
        try IERC734(id).keyHasPurpose(key, 2) returns (bool ok) {
            if (ok) return true;
        } catch {}
        return false;
    }

    /**
     * @dev Get locked tokens for a proposal
     * @param proposalId Proposal ID
     * @return Total locked tokens
     */
    function getLockedTokens(uint256 proposalId) external view returns (uint256) {
        return _lockedTokens[proposalId];
    }

    /**
     * @dev Get voter's locked tokens for a proposal
     * @param proposalId Proposal ID
     * @param voter Voter address
     * @return Locked tokens for this voter
     */
    function getVoterLockedTokens(uint256 proposalId, address voter) external view returns (uint256) {
        return _voterLockedTokens[proposalId][voter];
    }
}
