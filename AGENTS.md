# Solidity Engineering Rules (Production Grade)

This file defines non-negotiable standards for any agent contributing Solidity code in this repository.

## Scope
- Applies to all Solidity contracts, libraries, tests, deployment scripts, and upgrade scripts.
- Assume adversarial conditions, MEV, and hostile integrations by default.

## Core Principles
- Prefer correctness and safety over micro-optimizations.
- Keep contracts simple, explicit, and auditable.
- Minimize trust assumptions and privileged operations.
- Treat every external interaction as untrusted.

## Security Rules
- Use the latest stable Solidity compiler in `0.8.x`; avoid outdated compiler versions.
- Pin pragma to an exact version (no wide floating ranges in production contracts).
- Use custom errors instead of revert strings for gas + clarity.
- Validate every external input, including addresses, amounts, and array lengths.
- Use checks-effects-interactions ordering for all external calls.
- Protect sensitive flows with reentrancy guards where applicable.
- Prefer pull-based over push-based value transfers.
- Never use `tx.origin` for authorization.
- Never rely on block timestamp/number randomness for critical logic.
- Handle ERC20 tokens defensively (non-standard return values, fee-on-transfer behavior when relevant).
- Use explicit access control (`Ownable`, `AccessControl`, or role manager) and enforce least privilege.
- Use two-step ownership transfer and timelocks for critical admin paths where practical.
- Emit events for all state-changing admin actions and critical user actions.

## Upgradeability Rules (If Used)
- Use Transparent upgradeable contracts as the default proxy pattern.
- Use battle-tested proxy/admin implementations (e.g., OpenZeppelin TransparentUpgradeableProxy + ProxyAdmin).
- Reserve storage gaps and never reorder/remove storage variables.
- Explicitly document storage layout constraints.
- Gate upgrades with strict access control plus operational delay controls.

## Math and Accounting
- Keep accounting invariant-driven (`totalAssets`, `totalShares`, debt ceilings, etc.).
- Define and test invariant properties before implementation.
- Use fixed-point math libraries for precision-sensitive logic.
- Round in a documented, consistent direction and test edge cases.
- Avoid silent truncation assumptions; comment and test all rounding behavior.

## Gas Optimization Rules
- Use `uint256` for arithmetic and storage unless smaller types are provably beneficial in packed structs.
- Pack storage intentionally in structs; verify slot layout impact.
- Cache repeated storage reads into memory/local variables.
- Use `immutable` for constructor-set constants and `constant` for compile-time values.
- Prefer custom errors to reduce deployment/runtime gas.
- Avoid unbounded loops over user-controlled or growing storage.
- Use `unchecked` only when overflow is impossible and proven by bounds.
- Prefer calldata over memory for external function array/bytes/string args.
- Minimize storage writes; avoid writing unchanged values.
- Emit only required event fields; index only fields needed for querying.

## Code Quality
- Keep functions small and single-purpose.
- Prefer explicit naming (`depositAssets`, `withdrawShares`) over ambiguous names.
- Document all external/public functions with NatSpec including assumptions and failure modes.
- Remove dead code and unused state variables.
- No inline assembly unless strictly necessary; if used, document safety assumptions and add focused tests.

## Testing Requirements
- Include unit tests for success, revert, and edge cases for every external/public function.
- Add fuzz tests for arithmetic/accounting/state transitions.
- Add invariant tests for core protocol properties.
- Include integration tests covering realistic multi-step user flows.
- Include adversarial tests (reentrancy attempts, malformed token behavior, griefing scenarios).
- Use minimum two distinct actor roles in tests (admin + user; often attacker too).
- Test pause/emergency paths and role revocations.

## Tooling and Analysis
- Run formatting and lint checks before proposing changes.
- Run static analysis (e.g., Slither) for every security-sensitive change.
- Run gas snapshots/benchmarks for performance-critical changes and compare deltas.
- Reject PRs that increase gas materially without justification.

## Deployment and Operations
- Use environment-specific config; never hardcode private keys or RPC URLs.
- Verify constructor/initializer params and addresses before deployment.
- Require deployment checklists and post-deploy verification steps.
- Verify source code and ABI on the target explorer after deployment.
- Use multisig for privileged ownership on production networks.
- Maintain a pause/incident response playbook for production.

## Documentation
- Keep README and docs aligned with on-chain behavior.
- Document all trust assumptions and privileged roles.
- Document known limitations and out-of-scope threats.

## Commit Hygiene
- Use Conventional Commits for all changes.
- Allowed types include `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, and `ci`.
- Format: `type(scope): short summary` (example: `feat(vault): add capped deposit guard`).
- Keep each commit small, focused, and human-reviewable.

## PR Acceptance Gate
- A change is not production-ready unless all items below are true:
- Security assumptions are explicit.
- Tests (unit + fuzz/invariant where relevant) pass.
- Gas impact is measured for hot paths.
- Access control and upgrade safety (if any) are reviewed.
- Events and failure modes are documented.
