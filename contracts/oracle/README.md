# Oracle Management Contracts

This directory contains oracle network management contracts for real-time compliance validation.

## Contracts

- `OracleManager.sol` - The gate: node registry and lifecycle (owner or
  operator pause, unpause and emergency-designate; the owner registers,
  removes, sets weights, reputation and threshold, and can override a
  query's result with `emergencyOverride`), the query registry, and the
  one vote entry, `submitResponse`; Ownable2Step
- `ConsensusOracle.sol` - The manager's weighted engine: built for one
  manager, every write manager-only, no owner; snapshots every registered node's weight
  when a query opens and resolves a side at `consensusThreshold` percent
  (66 by default); it refuses to open a query with fewer than two
  registered nodes (`TooFewNodes`) or one a single node could resolve
  alone (`SingleNodeQuorum`, Task 5.1); an expired query closes without
  a verdict
- `WhitelistOracle.sol` - Whitelist entries; an approval lists at the
  tier its query was raised with or raises a lower entry to it, never
  lowers (Task 4.12); `addToWhitelist` (owner or list manager) names
  its tier in the call and alone lowers one; `whitelistStanding` (live,
  tier) is the one read ComplianceRules and the custody manager make
  (Task 4.17), so an oracle without it cannot be bound and an older bound
  one would revert every transfer: upgrades redeploy the list oracles
- `BlacklistOracle.sol` - Blacklist entries; applies a resolved verdict;
  `emergencyBlacklist` needs the manager's emergency designation and an
  active node
- `ListOracleBase.sol` - Abstract base of both list oracles, not deployed:
  oracle status and reputation, signature check, list-manager role, pause
  and the verdict rules (Task 4.8): a verdict applies only with at least
  `minimumConsensusOracles` supporting nodes (default and floor 2,
  `TooFewVoters`, Task 5.1); Ownable2Step (the ceremony nominates, ops
  accepts). The owner or list manager writes any entry directly, tier 5
  and CRITICAL included, with no vote; a consensus severity only sets the
  duration (D44 a; who should own the list oracles is an audit item)
- `OracleQueryPayload.sol` - Abstract base of OracleManager: the query
  types and what a query's data must carry (a blacklist severity 0..3, a
  whitelist tier 1..5, required), checked when the query opens; only the
  manager's owner raises tier 5 or a CRITICAL query (`TierRequiresOwner`,
  `SeverityRequiresOwner`)

## Interfaces

- `IOracle.sol` - Oracle interface
- `IOracleManager.sol` - Oracle manager interface
