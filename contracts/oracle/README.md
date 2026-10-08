# Oracle Management Contracts

This directory contains oracle network management contracts for real-time compliance validation.

## Contracts

- `OracleManager.sol` - The gate: node registry and lifecycle (operator
  pauses, unpauses and emergency-designates; the owner registers and
  removes), the query registry, and the one vote entry, `submitResponse`
- `ConsensusOracle.sol` - The manager's weighted engine: built for one
  manager, every write manager-only, no owner; snapshots every registered node's weight
  when a query opens and resolves a side at `consensusThreshold` percent
  (66 by default); an expired query closes without a verdict
- `WhitelistOracle.sol` - Whitelist entries; an approval lists at the
  tier its query was raised with or raises a lower entry to it, never
  lowers (Task 4.12); `addToWhitelist` (owner or list manager) names
  its tier in the call and alone lowers one
- `BlacklistOracle.sol` - Blacklist entries; applies a resolved verdict;
  `emergencyBlacklist` needs the manager's emergency designation and an
  active node
- `ListOracleBase.sol` - Abstract base of both list oracles, not deployed:
  oracle status and reputation, signature check, list-manager role, pause
  and the verdict rules (Task 4.8)
- `OracleQueryPayload.sol` - Abstract base of OracleManager: the query
  types and what a query's data must carry (a blacklist severity 0..3, a
  whitelist tier 1..5, required), checked when the query opens

## Interfaces

- `IOracle.sol` - Oracle interface
- `IOracleManager.sol` - Oracle manager interface
