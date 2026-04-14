# SGHO Accounting

This note explains the SGHO lane in the simplest accounting terms.

Assume the lane uses a stablecoin `vaultToken` such as `USDT` or `USDC`.

For this lane, the accounting model is:

- `vaultToken`, direct `GHO`, and `sGHO.previewRedeem(...)` are treated as the same stable-value unit
- entry and exit fees are handled separately by vault policy
- the strategy does not keep principal state; the vault does

## Route

```text
ENTRY

vaultToken
  |
  | deposit
  v
static aToken
  |
  | GSM sell
  v
GHO
  |
  | deposit
  v
sGHO


EXIT

sGHO
  |
  | withdraw
  v
GHO
  |
  | GSM buy
  v
static aToken
  |
  | redeem
  v
vaultToken
```

## Where Fees Matter

```text
ENTRY

vaultToken
  |
  | 1. vaultToken -> static aToken
  |    explicit fee: no
  |    note: ERC4626 rounding can leave tiny dust
  v
static aToken
  |
  | 2. static aToken -> GSM sell -> GHO
  |    explicit fee: yes in principle
  |    current SGHO lane assumption: sell fee is 0 at initialization
  v
GHO
  |
  | 3. GHO -> sGHO
  |    explicit fee: no
  |    note: ERC4626 share rounding can leave tiny dust
  v
sGHO

Entry accounting:
- spent    = what left the vault
- invested = net stable-value amount that actually made it into the SGHO position
- fee      = spent - invested
- costBasis increases by invested
```

```text
EXIT

sGHO
  |
  | 1. sGHO -> GHO
  |    explicit fee: no
  |    note: liquidity limits can block exit, but that is not a fee
  v
GHO
  |
  | 2. GHO -> GSM buy -> static aToken
  |    explicit fee: yes
  |    this is the main SGHO exit fee
  v
static aToken
  |
  | 3. static aToken -> vaultToken
  |    explicit fee: no
  |    note: ERC4626 redeem rounding can leave tiny dust
  v
vaultToken

Exit accounting:
- requestedPrincipal   = tracked principal the vault is consuming
- economicRecoverable  = min(requestedPrincipal, totalExposure)
- received             = what came back from the strategy route
- loss                 = requestedPrincipal - economicRecoverable
- fee                  = economicRecoverable - received
```

## Variable Diagram

```text
ENTRY

requested amount
   |
   +--> spent by vault
           |
           +--> invested principal in sGHO
           |
           +--> entry fee / dust

costBasis += invested
```

```text
EXIT

requested principal
   |
   +--> economically recoverable principal
   |       |
   |       +--> received from strategy route
   |       |
   |       +--> exit fee
   |
   +--> impairment / loss

costBasis -= requested principal
```

## Simple Examples

### Example 1: Clean Entry

```text
vault allocates: 100
route returns:   100 GHO
sGHO deposit:    100 shares worth 100

spent    = 100
invested = 100
fee      = 0
costBasis += 100
```

### Example 2: Tiny Entry Dust

```text
vault allocates: 100
route returns:   100 GHO
sGHO deposit rounds to shares worth 99.9999

spent    = 100
invested = 99.9999
fee      = 0.0001
costBasis += 99.9999
```

### Example 3: Exit Fee But No Loss

```text
requestedPrincipal = 100
totalExposure      = 100
route receives     = 99

economicRecoverable = 100
loss                = 0
fee                 = 1
```

### Example 4: Economic Loss

```text
requestedPrincipal = 100
totalExposure      = 97
route receives     = 96.9

economicRecoverable = 97
loss                = 3
fee                 = 0.1
```

The key split is:

- loss means the position is economically worth less than tracked principal
- fee means the route returned less than economically recoverable value
- temporary illiquidity is neither; it is fail-closed and should revert
