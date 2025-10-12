# Deployment Scripts

This directory contains deployment scripts for all contracts.

## Migration Scripts

- `1_initial_migration.js` - Initial setup and configuration
- `2_deploy_onchain_id.js` - OnchainID system deployment
- `3_deploy_erc3643.js` - ERC-3643 system deployment
- `4_deploy_oracle.js` - Oracle network deployment
- `5_deploy_compliance.js` - Compliance system deployment

## Usage

```bash
# Deploy to localhost
npx hardhat run migrations/1_initial_migration.js --network localhost

# Deploy to testnet
npx hardhat run migrations/1_initial_migration.js --network sepolia

# Deploy to mainnet
npx hardhat run migrations/1_initial_migration.js --network mainnet
```