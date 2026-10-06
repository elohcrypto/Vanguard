# Oracle Management Contracts

This directory contains oracle network management contracts for real-time compliance validation.

## Contracts

- `OracleManager.sol` - The gate: node registry and lifecycle (operator
  pauses, unpauses and emergency-designates; the owner registers and
  removes), the query registry, and the one vote entry, `submitResponse`
- `ConsensusOracle.sol` - The manager's weighted engine: built for one
  manager, every write manager-only, no owner; snapshots the active weight
  when a query opens and resolves a side at `consensusThreshold` percent
  (66 by default); an expired query closes without a verdict
- `WhitelistOracle.sol` - Whitelist entries; applies a resolved verdict
- `BlacklistOracle.sol` - Blacklist entries; applies a resolved verdict;
  `emergencyBlacklist` needs the manager's emergency designation and an
  active node

## Interfaces

- `IOracle.sol` - Oracle interface
- `IOracleManager.sol` - Oracle manager interface