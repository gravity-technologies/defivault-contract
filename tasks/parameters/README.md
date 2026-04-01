# Operation Parameter Templates

This directory holds committed JSON5 templates for task-driven operations.

Use `ignition/parameters/<environment>/` for Ignition deployment inputs.
Use `tasks/parameters/<environment>/` for Hardhat task inputs such as:

- strategy allocation and deallocation
- yield harvests
- yield-recipient schedule and execute flows
- emergency bridge operations
- vault and strategy upgrade tasks
- failed native deposit recovery

These files are templates, not execution records.
Keep stable environment defaults here, but do not commit incident-specific values or ad hoc operator payloads as canonical state.

For zkSync native ETH bridge flows, the bridge uses the asset-router sentinel
`0x0000000000000000000000000000000000000001`. Do not replace
`wrappedNativeToken` parameters with that sentinel; those fields must stay on the
actual wrapped-native ERC20 such as WETH.
