# CMTA UTXO Compliance POC - Smart Contracts

This directory contains all smart contracts for the CMTA UTXO Compliance POC project.

## Directory Structure

```
contracts/
├── onchain_id/              # OnchainID contracts (ERC-734/735)
├── erc3643/                 # ERC-3643 T-REX contracts
├── oracle/                  # Oracle management contracts
├── compliance/              # UTXO compliance contracts
├── privacy/                 # ZK verification contracts
├── test/                    # Test contracts and helpers
└── migrations/              # Deployment scripts
```

## Development Setup

1. Install dependencies: `npm install`
2. Compile contracts: `npx hardhat compile`
3. Run tests: `npx hardhat test`
4. Deploy locally: `npx hardhat node` then `npx hardhat run scripts/deploy.js --network localhost`

## Network Configurations

- **localhost**: Local Hardhat network for development
- **sepolia**: Ethereum testnet for testing
- **mainnet**: Ethereum mainnet for production

## Security

All contracts follow security best practices:
- Comprehensive access controls
- Reentrancy protection
- Gas optimization
- Formal verification where applicable