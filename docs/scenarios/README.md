# Scenario Guide: How to Read These Flows

## Why These Files Exist

These scenario docs are not API specs.
They explain common and uncommon vault flows in plain terms for operators and developers.

Use them when you ask:

- "What is the normal path for this operation?"
- "What weird edge path can happen in production?"
- "Why does this code branch exist?"

## Scenario Index

- `native-eth-weth-handling.md`: how native ETH enters and leaves the system, when it is wrapped, and where ETH conversions happen.
- `yield-harvesting.md`: yield extraction path, treasury payout semantics, and slippage checks.
- `tvl-reporting-underlying-and-non-underlying.md`: per-token TVL reporting and how direct token queries differ from per-strategy breakdowns.
- `strategy-generic-adapter-flow.md`: the rules every strategy adapter must follow and how the vault tracks reported tokens.
- `strategy-aave-1to1-scalar.md`: the current `AaveV3Strategy` behavior, including the 1:1 exposure assumption.
- `strategy-non-1to1-scalar.md`: guidance for adapters that need share, index, or oracle conversion to calculate exposure.

## Recommended Reading Order

1. `strategy-generic-adapter-flow.md` (shared baseline contract).
2. Then pick one implementation profile:
   - `strategy-aave-1to1-scalar.md` for current deployed path in this repo.
   - `strategy-non-1to1-scalar.md` for future adapters that need conversion logic to calculate exposure.

## Quick File Chooser

- If you are integrating current Aave USDT/aUSDT strategy: read `strategy-aave-1to1-scalar.md`.
- If you are designing a new adapter with index/share conversion: read `strategy-non-1to1-scalar.md`.
- If you are validating vault interface invariants for any strategy type: read `strategy-generic-adapter-flow.md`.

## How to Use

For each scenario file, read in this order:

1. **What this is for**: practical purpose.
2. **Most common flow**: the path most calls should follow.
3. **Ad-hoc / incident flows**: uncommon but supported paths.
4. **Why this is complex**: the design pressure/tradeoff.
5. **Debug checklist**: where to look when behavior is unexpected.

## Shared Terminology

- **Call token**: the token value passed into a write function.
  Example: `rebalanceErc20ToL2(address(0), amount)` where `address(0)` means "bridge native ETH".
- **Vault token**: ERC20 token used for a strategy pair in the vault registry.
  Example: `USDT` for `(USDT, AaveStrategy)`.
- **TVL token**: any exact ERC20 token surfaced by vault TVL reporting.
  Example: `USDT` and `aUSDT`.
- **Component token**: token returned inside the `positionBreakdown(vaultToken)` array.
  Example: `aUSDT` and residual `USDT`.
- **Receipt token**: non-vault-token component token representing invested position.
  Example: `aUSDT`.
- **Strategy exposure**: single number the vault uses for cap and harvest math.
  Example: `strategyExposure(USDT)`.
- **Tracked TVL token**: token included in on-chain TVL-token registry.
  Example: `USDT` or `aUSDT`.

## Important Distinction (Harvest)

Harvest emits two different event values in one transaction:

- `VaultTokenDeallocatedFromStrategy.received`: amount the vault measured coming back from the strategy.
- `YieldHarvested.received`: amount the treasury received after payout.

Do not treat those as duplicates.
