# Security

Assumptions for SubscriptionManager, SessionKeyRegistry, and the checkout.

## What the contracts enforce

- Settlement is tUSD8 on Aevum (chain id 44005). The constructor rejects any other token address on that chain, and it rejects a token whose `decimals()` is not 6.
- The manager never calls `approve`. `transferFrom` pulls the snapshotted plan amount from the subscriber straight to the merchant. The contract does not custody tUSD8.
- An allowance of `type(uint256).max` is treated as unlimited and the pull reverts with `UnlimitedAllowance`. A finite allowance can still cover many periods. The CLI sets it to `cap * periods until expiry`.
- Each pull must be less than or equal to the session key's per-period cap. One pull happens per due period.
- `amount` and `periodSeconds` are copied onto the subscription at `subscribe`. No function edits a plan or a live subscription price.
- `cancelSubscription` is subscriber-only. It marks the subscription cancelled and revokes the session key. A later `renewSubscription` reverts with `SubscriptionIsCancelled`.
- `renewSubscription` is permissionless on purpose. A keeper can collect when the period is due and the checks pass. It cannot collect early, over the cap, after expiry, or after cancellation.
- Failed renewals revert with a named custom error. The renewal path emits `RenewalFailed` first. The EVM discards logs if the transaction reverts, so off-chain alerts should decode the revert data.

## Limits

- Session keys are addresses recorded by the subscriber. The contracts do not verify an ERC-4337 signature over that key. A subscriber can register any non-zero address. The cap, expiry, finite allowance, and cancellation are the bounds.
- The contracts are not upgradeable. There is no owner key that can seize funds or reprice a subscription.
- Fee-on-transfer and rebasing tokens are not supported. tUSD8 is assumed to transfer the exact amount. A fee-on-transfer token would show a successful pull while the merchant receives less.
- Sending native tQDAY to either contract sticks there. Neither contract has a withdraw path, and neither accepts native value on purpose.

## Checkout

- The CLI sends ordinary transactions. On Aevum those pay gas in tQDAY.
- The checkout sends `subscribe`, `renewSubscription`, and `cancelSubscription` as EntryPoint v0.7 UserOperations through `https://bundler.qday.info`. QDay’s paymaster `0x8DdF5E51c470257642e2c17E43977901b1173eFa` reverts validation unless the call is a tUSD8 transfer or a call to `0xf45e7f39caba1d2055f613970575a7e7069636be`, and it has no allowlist setter. The checkout deploys its own paymaster, which accepts only those three calls and a finite `approve`. It then pulls 0.01 tUSD8. The paymaster's EntryPoint deposit is tQDAY, funded once by the wallet. The subscription allowance is `cap × 2`, enough for the first charge and one renewal. It does not pre-approve every period until the session-key expiry. `type(uint256).max` still reverts with `UnlimitedAllowance`.
- The session key's private key stays in the browser's local storage. It is not in the repository. The first renewal installs a Kernel permission limited by `RenewOnlyPolicy` to `renewSubscription` and a manager approval of at most 20 tUSD8. The key cannot transfer tUSD8 elsewhere. Cancel is still signed by the owner and revokes the key in `SessionKeyRegistry`.
- Moving tUSD8 onto the Kernel subscriber account, and `createPlan`, are ordinary wallet transactions. Their network fee is tQDAY.
- `npm run webhook` is a local inbox bound to `127.0.0.1`. It verifies `x-qday-signature` with HMAC-SHA256, stores the body in `web/.webhook/inbox.sqlite`, and keeps the secret in `web/.webhook/secret`. Both paths are gitignored. `GET /inbox` requires that secret in `x-renewpay-inbox`. The local dev server adds the header. The published page does not request the inbox and does not send the wallet address to it. Responses carry no cross-origin header. A body over 16 KiB is refused before the signature check. The process only reads public chain data and simulates renewals. It has no private key and it does not submit transactions. A failed renewal still has no durable log, because the EVM drops `RenewalFailed` on revert; the inbox records the simulated revert instead.

## Local mock

`MockTUSD8` exists so Foundry tests and a non-Aevum Anvil node can run the same pull logic. The deploy script and the CLI refuse to point an Aevum deployment at any token other than tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`.
