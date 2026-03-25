# V2 Accounting Walkthrough

This note explains V2 accounting using the GHO lane as the concrete example.

Assume the lane's `vaultToken` is `USDT`.

In that setup:

- principal is tracked in `USDT`
- `GHO` is the intermediate route token
- `stkGHO` is the invested position token
- the strategy executes the route
- the vault owns the accounting ledger

## Mental Model

```text
                     route execution
        +----------------------------------------+
        |                                        |
        v                                        |
USDT vault token -> GSM -> GHO -> staking -> stkGHO
        ^                                       |
        |                                       |
        +------ GSM <- GHO <- unstake ----------+

Accounting unit: USDT

The vault tracks:
  costBasis[USDT][strategy]  = tracked principal
  harvestableYield           = max(0, totalExposure - costBasis)

The strategy tracks:
  nothing about principal
```

The strategy is a route adapter. It accepts `USDT`, converts through `GHO`, stakes into `stkGHO`, and later unwinds back to `USDT`.

The vault is the accountant. It decides what is principal, what is residual yield, what fee was paid, and whether treasury reimbursement should happen.

## Main Code Surfaces

- [IYieldStrategyV2](../../contracts/interfaces/IYieldStrategyV2.sol): defines the V2 unit model. Amounts are in vault-token units.
- [GsmStkGhoStrategy](../../contracts/strategies/GsmStkGhoStrategy.sol): executes `vaultToken -> GHO -> stkGHO` and the reverse path.
- [GRVTL1TreasuryVault](../../contracts/vault/GRVTL1TreasuryVault.sol): public vault surface and cost-basis view.
- [GRVTL1TreasuryVaultOpsModule](../../contracts/vault/GRVTL1TreasuryVaultOpsModule.sol): accounting engine for allocation, deallocation, harvest, and reimbursement.
- [VaultStrategyOpsLib](../../contracts/vault/VaultStrategyOpsLib.sol): shared reads and helpers for exposure, harvestable yield, and reimbursement measurement.

Useful entry points:

- `GsmStkGhoStrategy.allocate(amount)`
- `GsmStkGhoStrategy.withdraw(amount)`
- `GRVTL1TreasuryVaultOpsModule.allocateVaultTokenToStrategy(token, strategy, amount)`
- `GRVTL1TreasuryVaultOpsModule.deallocateVaultTokenFromStrategy(token, strategy, amount)`
- `GRVTL1TreasuryVaultOpsModule.deallocateAllVaultTokenFromStrategy(token, strategy)`
- `GRVTL1TreasuryVaultOpsModule.harvestYieldFromStrategy(token, strategy, amount, minReceived)`

## Allocation Flow

```text
Allocator
  |
  v
Vault.allocateVaultTokenToStrategy(USDT, strategy, amount)
  |
  | 1. approve exact USDT amount to strategy
  | 2. record vault USDT balance before
  v
Strategy.allocate(amount)
  |
  | 3. pull USDT from vault
  | 4. swap USDT -> GHO
  | 5. stake GHO -> stkGHO
  | 6. return invested, denominated in USDT-equivalent units
  v
Vault accounting
  |
  | 7. spent = balanceBefore - balanceAfter
  | 8. fee = spent - invested
  | 9. require invested <= spent
  | 10. require fee <= entry fee cap
  | 11. reimburse fee from treasury if fee > 0
  | 12. costBasis += invested
```

Important point: for V2, `costBasis` increases by `invested`, not by the gross amount requested and not by the measured `spent`.

Why:

- `costBasis` is meant to represent deployed principal, not every token that left the vault.
- entry friction is treated as a fee, not as productive principal.
- the strategy knows the fixed route and can report the net vault-token-equivalent value actually deployed.
- the vault still measures `spent` as a sanity check and rejects impossible accounting, such as `invested > spent`.
- if the entry fee is allowed by policy, reimbursement restores vault-side cash without inflating principal.

Example:

```text
Before:
  vault idle USDT:        1,000
  strategy costBasis:         0

Allocate:
  requested amount:         100 USDT
  vault-side spent:         100 USDT
  strategy invested:         99 USDT-equivalent
  entry fee:                  1 USDT

After:
  strategy costBasis:        99
  treasury reimbursement:     1 USDT, if fee is within cap
```

The reimbursement restores vault-side cashflow. It does not increase principal. Principal is still `99`.

### Entry Fee Cap Nuance

The vault checks the fee cap before reimbursement.

For a fee to be reimbursed, it must first be allowed by `entryCapBps`.

```text
fee = spent - invested
maxFee = spent * entryCapBps / 10_000

if fee > maxFee:
  revert
else if fee > 0:
  reimburse exactly fee
```

The intended GHO lane policy currently uses:

```text
entryCapBps = 0
exitCapBps  = 7
policyActive = true
```

So if the GHO entry path charges any entry fee when `entryCapBps = 0`, allocation should revert instead of reimbursing.

## Exposure And Yield

The strategy reports `totalExposure()` in gross vault-token units.

For a USDT lane, that means gross `USDT`-equivalent exposure.

```text
strategy exact balances:
  idle USDT
  idle GHO
  stkGHO shares

strategy totalExposure():
  idle USDT
  + gross USDT-equivalent value of GHO and stkGHO assets
```

The vault computes raw residual yield as:

```text
harvestableYield = max(0, totalExposure - costBasis)
```

Example:

```text
Current state:
  costBasis:       99 USDT
  totalExposure:  105 USDT-equivalent

Raw harvestable yield:
  105 - 99 = 6 USDT-equivalent
```

The strategy does not label the `6` as yield. The vault derives that because gross exposure is above tracked principal.

Residual yield can come from:

- stkGHO share-price appreciation
- claimed stkGHO rewards
- idle GHO sitting in the strategy
- idle USDT sitting in the strategy
- unsolicited tokens that increase reported exposure

## Tracked Principal Exit Flow

```text
Allocator/Admin
  |
  v
Vault.deallocateVaultTokenFromStrategy(USDT, strategy, amount)
  |
  | 1. require amount <= costBasis
  v
Strategy.withdraw(amount)
  |
  | 2. sweep idle USDT first
  | 3. compute GHO needed for remaining gross USDT amount
  | 4. use idle GHO if available
  | 5. unstake stkGHO -> GHO if needed
  | 6. swap GHO -> USDT
  | 7. send USDT to vault
  v
Vault accounting
  |
  | 8. received = vault USDT balance delta
  | 9. fee = amount - received
  | 10. require fee <= exit fee cap
  | 11. reimburse fee from treasury if fee > 0
  | 12. costBasis -= amount
```

Important point: for V2 tracked principal exits, `costBasis` decreases by the requested gross amount, not by the net amount received.

Why:

- the caller is asking to consume a gross slice of tracked principal exposure.
- the route may return less than that gross amount because of exit fees.
- that shortfall is handled as a fee and, for tracked flows, reimbursed if it passes the configured cap.
- reducing `costBasis` by only `received` would leave paid exit fees behind as fake remaining principal.
- keeping the route proceeds and treasury reimbursement separate makes the ledger easier to audit.

Example:

```text
Before:
  strategy costBasis:     99 USDT

Deallocate:
  requested amount:       40 USDT gross exposure
  route proceeds:      39.97 USDT
  exit fee:             0.03 USDT
  reimbursement:        0.03 USDT, if fee is within cap

After:
  strategy costBasis:     59 USDT
  vault receives:      39.97 USDT from strategy
  vault receives:       0.03 USDT from treasury
```

The route and treasury are intentionally separate cashflows:

```text
strategy route proceeds:  actual USDT returned by the route
treasury reimbursement:  policy top-up for tracked principal fees
costBasis change:        gross principal amount consumed
```

## Full Principal Exit And Loss

`deallocateAllVaultTokenFromStrategy` is the V2 loss-recognition path.

It computes:

```text
withdrawable = min(costBasis, totalExposure)
loss = costBasis - withdrawable
```

Then it withdraws `withdrawable`, applies the same exit fee cap and reimbursement logic, and zeroes `costBasis`.

Why:

- `deallocateAll` is the explicit lane cleanup and loss-recognition path.
- if exposure is below cost basis, the difference is a real impairment, not residual principal to keep carrying.
- zeroing `costBasis` prevents the vault from reporting stale principal after the lane has been fully unwound as far as the strategy can support.
- any value above principal remains residual and must be handled through harvest, not mixed into the principal exit.

Example without impairment:

```text
Before:
  costBasis:       99
  totalExposure:  105

deallocateAll:
  withdrawable:    99
  loss:             0

After:
  costBasis:        0
  residual remains: 6, harvest path only
```

Example with impairment:

```text
Before:
  costBasis:       99
  totalExposure:   94

deallocateAll:
  withdrawable:    94
  loss:             5

After:
  costBasis:        0
```

This is deliberate: V2 recognizes loss during a real unwind, not through a separate bookkeeping write-down.

## Harvest Flow

Harvest is not principal recovery. Harvest realizes residual value only.

Why:

- residual is defined as value above tracked principal: `max(0, totalExposure - costBasis)`.
- harvesting residual should not change the amount of tracked principal still assigned to the strategy.
- harvest belongs to the protocol, so its route fees are not reimbursed.
- keeping harvest separate from principal exit prevents yield realization from hiding losses or changing the principal ledger.

```text
Vault.harvestYieldFromStrategy(USDT, strategy, amount, minReceived)
  |
  | 1. residual = max(0, totalExposure - costBasis)
  | 2. require amount <= residual
  | 3. call strategy.withdraw(amount)
  | 4. received = vault USDT balance delta
  | 5. fee = amount - received
  | 6. require fee <= exit fee cap
  | 7. no reimbursement
  | 8. pay received USDT to yieldRecipient
```

Example:

```text
Before:
  costBasis:       99 USDT
  totalExposure:  105 USDT-equivalent
  residual:         6 USDT-equivalent

Harvest:
  requested:        6 USDT gross exposure
  route proceeds: 5.995 USDT
  exit fee:      0.005 USDT
  reimbursement:    0

After:
  costBasis:       99 USDT
  yieldRecipient: receives 5.995 USDT
```

Harvest fees are not reimbursed because harvest belongs to the protocol, not to tracked-principal protection.

## Reimbursement Rules

Reimbursement applies to tracked flows only:

- V2 allocation, after entry fee cap check
- V2 tracked deallocation, after exit fee cap check
- V2 `deallocateAll`, after exit fee cap check

Reimbursement does not apply to:

- harvest
- unsupported fees above cap
- fees when the treasury cannot reimburse the exact requested amount

The reimbursement amount must be exact. If the vault expects `0.03 USDT`, the treasury must return exactly `0.03 USDT`, or the call reverts.

## One Worked Timeline

This timeline uses a non-zero entry fee to show the generic V2 reimbursement shape. With the current intended GHO policy (`entryCapBps = 0`), that entry fee would revert instead of being reimbursed.

```text
Initial:
  vault idle USDT:       1,000
  strategy costBasis:        0
  strategy exposure:         0

1. Allocate 100 USDT
  spent:                   100
  invested:                 99
  entry fee:                 1
  reimbursement:             1, if allowed by entryCapBps
  costBasis after:          99

2. Position appreciates
  totalExposure:           105
  costBasis:                99
  raw harvestable yield:     6

3. Deallocate 40 USDT tracked principal
  route proceeds:        39.97
  exit fee:               0.03
  reimbursement:          0.03, if allowed by exitCapBps
  costBasis after:          59

4. Harvest 6 USDT residual
  route proceeds:        5.995
  harvest exit fee:      0.005
  reimbursement:             0
  costBasis after:          59

5. Deallocate all remaining principal
  withdrawable: min(costBasis, totalExposure)
  loss: costBasis - withdrawable
  costBasis after:           0
```

## Short Version

For a USDT GHO lane:

```text
USDT is principal.
GHO is route inventory.
stkGHO is the invested position.
costBasis is the vault's principal ledger.
totalExposure is gross USDT-equivalent strategy value.
residual yield is max(0, totalExposure - costBasis).
tracked-flow fees are reimbursed only after passing caps.
harvest fees are never reimbursed.
```

## Read Next

- [v2-strategy-brief.md](v2-strategy-brief.md)
- [accounting-and-tvl.md](accounting-and-tvl.md)
- [strategy-model.md](strategy-model.md)
- [../integrations/gho-stkgho.md](../integrations/gho-stkgho.md)
- [../design-decisions/08-gho-fixed-route-policy.md](../design-decisions/08-gho-fixed-route-policy.md)
