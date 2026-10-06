// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title ComplianceRulesTrust
 * @dev Trusted-contract half of ComplianceRulesAdmin (plan v2 Task 4.3),
 *      inherited by it: one deployed contract, one address. A trusted
 *      contract skips its own identity, whitelist and investor-cap checks
 *      on that token; the counterparty's are not skipped (2A).
 *
 *      Who may trust a contract: the owner (governance after the
 *      handover), or a registrar of that token. A registrar is a contract
 *      the owner named with the runtime code hash of the wallets it creates
 *      (InvestorRequestManager -> MultiSigWallet, EscrowWalletFactory ->
 *      MultiSigEscrowWallet); it may only trust an account whose code hash
 *      equals that hash, so trust stays restricted to known code (Phase 3
 *      review invariant 7). Human keys (ops, rule administrators) hold no
 *      trust power. Removal stays owner-only.
 */
abstract contract ComplianceRulesTrust is Ownable2Step {
    // Trust is per token (G5): trusting governance for VGT (it holds VGT
    // fees, D21) does not exempt it on VSC, and an escrow trusted for VSC is
    // not trusted for VGT. Token and GovernanceToken read the 1-arg
    // isTrustedContract as "trusted for msg.sender"; off-chain readers use
    // the 2-arg view and the token-indexed events.

    mapping(address => mapping(address => bool)) internal trustedContracts;
    /// @dev On how many tokens an account is trusted. canReceive refuses a
    ///      recovery into an account trusted on ANY token (review M1, 2E).
    mapping(address => uint256) internal trustedTokenCount;

    /// @notice token => registrar => runtime code hash of the only accounts
    ///         the registrar may trust on that token; zero = not a registrar.
    mapping(address => mapping(address => bytes32)) public trustedRegistrars;

    event TrustedContractAdded(address indexed token, address indexed contractAddress);
    event TrustedContractRemoved(address indexed token, address indexed contractAddress);
    event TrustedRegistrarSet(address indexed token, address indexed registrar, bytes32 walletCodeHash);

    /**
     * @dev Name `registrar` as a registrar of `token` for accounts whose
     *      runtime code hash is `walletCodeHash`; bytes32(0) revokes it.
     *      Contracts only: a human key never gets trust power.
     */
    function setTrustedRegistrar(address token, address registrar, bytes32 walletCodeHash) external onlyOwner {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(registrar != address(0), "Invalid address");
        if (walletCodeHash != bytes32(0)) _requireContract(registrar);
        trustedRegistrars[token][registrar] = walletCodeHash;
        emit TrustedRegistrarSet(token, registrar, walletCodeHash);
    }

    /**
     * @dev Trust a contract (e.g., escrow wallet) on `token`: its own identity
     *      and whitelist checks are skipped there, the counterparty's are not.
     *      The owner, or a registrar of `token` for an account with its code.
     * @param token The token on which the contract is trusted
     * @param contractAddress Address of the trusted contract
     */
    function addTrustedContract(address token, address contractAddress) external {
        if (msg.sender != owner()) {
            bytes32 allowed = trustedRegistrars[token][msg.sender];
            require(allowed != bytes32(0), "ComplianceRules: not owner or registrar");
            require(contractAddress.codehash == allowed, "ComplianceRules: code not registered");
        }
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(contractAddress != address(0), "Invalid address");
        _requireContract(contractAddress);
        require(!trustedContracts[token][contractAddress], "Already trusted");
        trustedContracts[token][contractAddress] = true;
        trustedTokenCount[contractAddress]++;
        emit TrustedContractAdded(token, contractAddress);
    }

    /**
     * @dev Stop trusting a contract on `token` (owner only)
     * @param token The token on which the contract was trusted
     * @param contractAddress Address of the contract to remove
     */
    function removeTrustedContract(address token, address contractAddress) external onlyOwner {
        require(trustedContracts[token][contractAddress], "Not trusted");
        // After the handover the owner is governance, which holds VGT fees as
        // a trusted contract with no identity (D21). Untrusting it would make
        // every later fee pull revert, so no proposal could ever undo it.
        require(contractAddress != owner(), "ComplianceRules: owner stays trusted");
        trustedContracts[token][contractAddress] = false;
        trustedTokenCount[contractAddress]--;
        emit TrustedContractRemoved(token, contractAddress);
    }

    /// @notice Whether `account` is a trusted contract on `token`.
    function isTrustedContract(address token, address account) external view returns (bool) {
        return trustedContracts[token][account];
    }

    /// @notice Whether `account` is trusted on any token: canReceive then
    ///         refuses it as a wallet-recovery target on every token.
    function isTrustedOnAnyToken(address account) external view returns (bool) {
        return trustedTokenCount[account] != 0;
    }

    /// @dev Code present and not an EIP-7702 delegation indicator
    ///      (0xef0100 || address, 23 bytes): a delegated EOA is a wallet.
    function _requireContract(address account) private view {
        require(account.code.length > 0, "ComplianceRules: not a contract");
        if (account.code.length == 23) {
            bytes memory code = account.code;
            require(
                !(code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00),
                "ComplianceRules: delegated wallet"
            );
        }
    }
}
