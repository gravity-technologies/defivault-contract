# Production Roles

Live mainnet state as checked on 2026-04-01.

## Wallets

| Wallet             | Address                                      | Type                                     | Vault `0xC95Fedb8Bdc763e4ef093D14e8196afafBB48f45` | Yield timelock `0x4e29715b7Ca2569678027c01627D936235eA36De` | GRVT fee token `0xAB3B124052F0389D1cbED221d912026Ac995bb95` | Notes                                  |
| ------------------ | -------------------------------------------- | ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| Engineering Safe   | `0x3a23919d4aA39e096E9d6420fd6a2861A20B19e5` | Multisig (2/3)                           | `DEFAULT_ADMIN_ROLE`, `VAULT_ADMIN_ROLE`           | `ADMIN_ROLE`, `PROPOSER_ROLE`                               | None                                                        | Owns all 3 ProxyAdmin contracts        |
| Bootstrap deployer | `0x340d75F15bF97aF6AE518d746063c591bB5368f0` | EOA                                      | None                                               | None                                                        | None                                                        | Throwaway deploy signer only           |
| Haoze operator     | `0x4738eDE7Fb2d3E5596867cf60c668779de7CE8C4` | EOA                                      | `PAUSER_ROLE`, `ALLOCATOR_ROLE`, `REBALANCER_ROLE` | `EXECUTOR_ROLE`                                             | None                                                        | Not an Engineering Safe owner on-chain |
| Minh operator      | `0x29496817aB0820A5aDa4d5C656Ea8DF79Ba05F3A` | EOA                                      | `PAUSER_ROLE`, `ALLOCATOR_ROLE`, `REBALANCER_ROLE` | `EXECUTOR_ROLE`                                             | None                                                        | Engineering Safe owner                 |
| Aaron operator     | `0x9A4484BBDae765A84c802Cf0A4777D8b16AB1270` | EOA                                      | `PAUSER_ROLE`, `ALLOCATOR_ROLE`, `REBALANCER_ROLE` | None                                                        | None                                                        | Engineering Safe owner                 |
| Treasury Safe      | `0x6e1B2a22f8f3768040CFb0b0997851ffB5971439` | Multisig address reserved, not activated | Vault `yieldRecipient` target only                 | None                                                        | None                                                        | No code on L1 yet                      |

## Contract Control

| Contract                       | Address                                      | Controller / Role Holders                                                                                                                                                |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vault ProxyAdmin               | `0xF57Be7cB5B1c5e37fDb19DdF8E5A359A5e381575` | Owned by Engineering Safe                                                                                                                                                |
| Strategy ProxyAdmin            | `0x2B19C664F7b1D389A6a9d483acd283098613D84A` | Owned by Engineering Safe                                                                                                                                                |
| NativeBridgeGateway ProxyAdmin | `0x421a3f9b8665174B4FcF5fD4A9012B79be457f51` | Owned by Engineering Safe                                                                                                                                                |
| Engineering Safe               | `0x3a23919d4aA39e096E9d6420fd6a2861A20B19e5` | Owners on-chain: `0xF29bFff344c7ef0186432fE30C39fda0cca0550b`, `0x29496817aB0820A5aDa4d5C656Ea8DF79Ba05F3A`, `0x9A4484BBDae765A84c802Cf0A4777D8b16AB1270`; threshold `2` |
| GRVT fee token                 | `0xAB3B124052F0389D1cbED221d912026Ac995bb95` | Vault has `MINTER_ROLE`                                                                                                                                                  |

## Treasury Safe Status

- The treasury recipient address is set to `0x6e1B2a22f8f3768040CFb0b0997851ffB5971439`.
- We have not added any owners to the Treasury multisig safe yet.
- The address currently has no code on Ethereum mainnet.
- The vault already points `yieldRecipient` at this address, but the Safe itself is not activated on-chain yet.
