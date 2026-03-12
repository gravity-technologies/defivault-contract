# Cached Tracked TVL-Token Registry

## Metadata

- Audience: contributors, indexers, operators
- Purpose: explain why tracked TVL token discovery is cached instead of live-derived
- Decision type: reporting and operational resilience

## Context

Indexers and operators need a discoverable token set for TVL reads, but computing that set from live strategy reads on every query would be expensive and fragile.

The vault also needs to keep working when one strategy read path is temporarily unhealthy.

## Decision

The vault maintains a cached tracked-token registry driven by:

- supported vault tokens,
- cached `strategy.tvlTokens(vaultToken)` lists for active pairs,
- admin overrides from `setTrackedTvlTokenOverride(token, enabled, forceTrack)`.

Live strategy scans are not used for every registry read.

## Alternatives Considered

Live token discovery on every read:

- rejected because read paths would depend on downstream strategy health,
- rejected because it would be more expensive and less predictable.

Deriving tracked tokens from `positionBreakdown(vaultToken)` on demand:

- rejected because it would conflate registry membership with live diagnostic reads,
- rejected because malformed strategy reporting would break cheap token discovery.

## Consequences

- `getTrackedTvlTokens()` and `isTrackedTvlToken(token)` are storage-backed,
- registry updates happen on relevant vault write paths,
- `refreshStrategyTvlTokens(vaultToken, strategy)` exists as an explicit resync hook,
- conservative behavior can keep token tracking in place through transient strategy read failures.

## Read Behavior

- `tokenTotals(token)` is strict and reverts on invalid strategy reads,
- `tokenTotalsConservative(token)` and `tokenTotalsBatch(tokens)` skip failed reads and report `skippedStrategies`,
- `trackedTvlTokenTotals()` gives indexers a one-call conservative snapshot of the current tracked set.

## Operational Implications

- if a strategy changes which tokens it reports, the cached list updates on the next relevant write path or explicit refresh,
- stale or pinned tracking usually points to a missing refresh, a missing write-path sync, or a strategy read failure,
- the admin override exists as a break-glass recovery tool, not as the normal synchronization path.

## Related Docs

- [raw-token-tvl-accounting.md](raw-token-tvl-accounting.md)
- [../concepts/accounting-and-tvl.md](../concepts/accounting-and-tvl.md)
- [../../contracts/interfaces/IL1TreasuryVault.sol](../../contracts/interfaces/IL1TreasuryVault.sol)
