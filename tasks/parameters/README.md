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
