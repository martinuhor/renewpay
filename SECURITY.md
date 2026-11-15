# Security

Week-1 assumptions for SubscriptionManager and SessionKeyRegistry.

## What the contracts enforce

- Settlement is tUSD8 on Aevum (chain id 44005). The constructor rejects any other token address on that chain, and it rejects a token whose `decimals()` is not 6.
- The manager never calls `approve`. `transferFrom` pulls the snapshotted plan amount from the subscriber straight to the merchant. The contract does not custody tUSD8.
- An allowance of `type(uint256).max` is treated as unlimited and the pull reverts with `UnlimitedAllowance`. A finite allowance can still cover many periods. The CLI sets it to `cap * periods until expiry`.
- Each pull must be less than or equal to the session key's per-period cap. One pull happens per due period.
- `amount` and `periodSeconds` are copied onto the subscription at `subscribe`. No function edits a plan or a live subscription price.
- `cancelSubscription` is subscriber-only. It marks the subscription cancelled and revokes the session key. A later `renewSubscription` reverts with `SubscriptionIsCancelled`.
- `renewSubscription` is permissionless on purpose. A keeper can collect when the period is due and the checks pass. It cannot collect early, over the cap, after expiry, or after cancellation.
- Failed renewals revert with a named custom error. The renewal path emits `RenewalFailed` first. The EVM discards logs if the transaction reverts, so off-chain alerts should decode the revert data.

## What week 1 does not do

- Session keys are addresses recorded by the subscriber's own transaction. The contracts do not verify ERC-4337 UserOperation signatures. A subscriber can register any non-zero address. The cap, expiry, finite allowance, and cancellation are the bounds.
- The stablecoin paymaster is not integrated. There is no paymaster address in this repo. Gas for these calls is paid in the chain's native token (tQDAY on Aevum).
- No webhook authentication. That is a later service.
- The contracts are not upgradeable. There is no owner key that can seize funds or reprice a subscription.
- Fee-on-transfer and rebasing tokens are not supported. tUSD8 is assumed to transfer the exact amount. A fee-on-transfer token would show a successful pull while the merchant receives less.
- Sending native tQDAY to either contract sticks there. Neither contract has a withdraw path, and neither accepts native value on purpose.

## Local mock

`MockTUSD8` exists so Foundry tests and a non-Aevum Anvil node can run the same pull logic. The deploy script and the CLI refuse to point an Aevum deployment at any token other than tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`.
