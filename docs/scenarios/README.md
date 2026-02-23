# Scenario Guide: How to Read These Flows

## Why These Files Exist
These scenario docs are not API specs.
They are operator/developer mental models for common and uncommon flows in the vault.

Use them when you ask:
- "What is the normal path for this operation?"
- "What weird edge path can happen in production?"
- "Why does this code branch exist?"

## Scenario Index
- `native-eth-weth-handling.md`: native-intent boundary rules, wrapped-native ingress invariant, bridge/harvest ETH conversion points.
- `yield-harvesting.md`: yield extraction path, treasury payout semantics, slippage checks, write-down side effects.
- `tvl-reporting-underlying-and-non-underlying.md`: exact-token reporting model and how root/component queries differ.
- `strategy-generic-adapter-flow.md`: vault-level adapter contract and tracking assumptions that apply to all protocols.
- `strategy-aave-1to1-scalar.md`: concrete behavior of current `AaveV3Strategy` (including explicit 1:1 scalar assumption).
- `strategy-non-1to1-scalar.md`: design guidance for adapters that need non-1:1 conversion/index/oracle-aware scalar logic.

## Recommended Reading Order
1. `strategy-generic-adapter-flow.md` (shared baseline contract).
2. Then pick one implementation profile:
   - `strategy-aave-1to1-scalar.md` for current deployed path in this repo.
   - `strategy-non-1to1-scalar.md` for future adapters with conversion/index-driven scalar exposure.

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
- **Boundary token**: token value at mutating API boundary.
  Example: `rebalanceToL2(address(0), amount)` where `address(0)` means native intent.
- **Canonical token**: internal accounting key (always ERC20 address).
  Example: native intent canonicalizes to `wrappedNativeToken`.
- **Root token**: token-domain key used for a strategy binding in vault registry.
  Example: `USDT` for `(USDT, AaveStrategy)`.
- **Component token**: token returned inside `assets(token).components`.
  Example: `aUSDT` and residual `USDT`.
- **Receipt token**: non-root component token representing invested position.
  Example: `aUSDT`.
- **Principal-bearing exposure**: scalar used for cap/harvest math.
  Example: `principalBearingExposure(USDT)`.
- **Tracked token**: token included in on-chain tracked token registry.
  Example: root token + discovered non-root receipt token.

## Important Distinction (Harvest)
Harvest emits two different telemetry surfaces in one tx:
- `Deallocate.received`: vault-side measured strategy unwind delta.
- `YieldHarvested.received`: treasury-side net receipt after payout.

Do not treat those as duplicates.
