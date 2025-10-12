# OnchainID Contracts (ERC-734/ERC-735)

This directory contains OnchainID implementation contracts following ERC-734 and ERC-735 standards.

## Contracts

- `OnchainIDFactory.sol` - Factory for deploying OnchainID contracts
- `OnchainID.sol` - Core OnchainID contract with key and claim management
- `ClaimIssuer.sol` - Trusted claim issuer contract
- `KeyManager.sol` - Advanced key management utilities

## Interfaces

- `IERC734.sol` - ERC-734 Key Manager interface
- `IERC735.sol` - ERC-735 Claim Holder interface
- `IOnchainID.sol` - OnchainID interface for external integrations