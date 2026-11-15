# RenewPay

RenewPay is a subscription-billing engine for SaaS products, content creators, and API services on QDay Aevum.

RenewPay is a subscription billing contract for QDay Aevum. A merchant publishes a tUSD8 plan. A subscriber authorizes a session key with a per-period spending cap and an expiry. The first period is collected on subscribe (unless the plan has a trial). Anyone can call `renewSubscription` once the next period is due. Only the subscriber can cancel, and cancellation revokes the session key.

This repository is the week-1 core: `SubscriptionManager`, `SessionKeyRegistry`, Foundry tests, and a Node CLI. It does not include a React app, ERC-4337 paymaster UserOperations, or a webhook server. No paymaster address is configured.

## Chain

| | |
| --- | --- |
| Network | QDay Aevum Testnet |
| Chain ID | 44005 (`0xABE5`) |
| RPC | https://rpc-test.qday.info |
| WebSocket | wss://rpc-test.qday.info |
| Explorer | https://explorer-test.qday.info |
| Native gas token | tQDAY, 18 decimals |

These are the Aevum endpoints published by QDay (https://qday.io/build and https://qday.io/official-links). `eth_chainId` on the RPC returns `0xabe5`.

## Settlement token

tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals.

The core flow uses this token only. On chain id 44005 the manager rejects any other token address. `SubscriptionManager` never calls `approve`. An allowance of `type(uint256).max` is rejected. The CLI approves `spendingCapPerPeriod * periodsUntilExpiry`, which is finite.

A plain local Anvil node is not Aevum, so it has no tUSD8. `npm run renewpay -- deploy` deploys a 6-decimal mock there and only there. An Anvil fork of Aevum keeps chain id 44005 and uses the real token.

## Contracts

`createPlan(amount, periodSeconds, trialSeconds, metadataURI)` stores a plan. `trialSeconds = 0` means no trial. The plan id is

```text
keccak256(abi.encode(merchant, amount, periodSeconds, trialSeconds, keccak256(bytes(metadataURI))))
```

The same merchant and the same terms always produce the same id.

`subscribe(planId, sessionKey, spendingCapPerPeriod, expiry)` records the session key in `SessionKeyRegistry` and snapshots `amount` and `periodSeconds` onto the subscription. There is no function that edits a plan or a live price.

`renewSubscription(subscriptionId)` is permissionless. It collects one period of the snapshotted amount when all of these hold:

- the subscription is not cancelled
- the session key is registered, not revoked, and not expired
- the period is due
- the snapshotted amount does not exceed the per-period cap
- the subscriber's tUSD8 balance and finite allowance both cover the amount

A failed check reverts with a named error. On the renewal path the contract emits `RenewalFailed` before reverting. The EVM drops logs when a transaction reverts, so the durable signal is the custom error (`SubscriptionIsCancelled`, `SessionKeyInactive`, `SessionKeyExpired`, `PeriodNotDue`, `CapExceeded`, `InsufficientBalance`, `InsufficientAllowance`, `UnlimitedAllowance`).

`cancelSubscription(subscriptionId)` is subscriber-only. It revokes the session key.

Week 1 stores the session key address. It does not validate ERC-4337 signatures, and it does not submit UserOperations to a paymaster.

## Contract addresses

Not deployed to Aevum yet.

| Contract | Address |
| --- | --- |
| SubscriptionManager | |
| SessionKeyRegistry | |

## Test

Clone with submodules so `lib/forge-std` is present (`git clone --recurse-submodules`). Then:

```bash
forge test
```

The suite covers plan creation, subscribe (including the first tUSD8 pull), renewal inside the cap, renewal over the cap, cancel then renew, and renewal after session-key expiry.

## CLI against local Anvil

```bash
cd cli
npm install
```

In another shell, start Anvil. Copy `.env.example` to `.env` at the repo root. Point `RPC_URL` at `http://127.0.0.1:8545`, and set `DEPLOYER_PRIVATE_KEY` and `SUBSCRIBER_PRIVATE_KEY` to two local Anvil accounts. Do not commit `.env`.

```bash
npm run renewpay -- deploy
npm run renewpay -- create-plan --amount 9990000 --period-seconds 2592000 --trial-seconds 0 --metadata ipfs://renewpay/pro
npm run renewpay -- subscribe --plan-id <planId> --session-key <address> --cap 10000000
npm run renewpay -- renew --subscription-id <subscriptionId> --warp-seconds 2592000
```

`9990000` is 9.99 tUSD8. `10000000` is a 10 tUSD8 cap. `2592000` is a 30-day period. `--expiry` defaults to 365 days from the latest block. `--warp-seconds` moves time on a local node and is refused on chain id 44005.

`deploy` writes `deployments/latest.json` (gitignored). Later commands read that file when the address env vars are empty.

## Deploy to Aevum

The deploy needs a funded account. Export `DEPLOYER_PRIVATE_KEY` locally. Do not put it in the repo. No Aevum deployment has been broadcast, so the address table stays empty until one is.

```bash
forge script script/Deploy.s.sol \
  --rpc-url https://rpc-test.qday.info \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

The CLI does the same thing when `RPC_URL` is the Aevum RPC:

```bash
cd cli
npm run renewpay -- deploy
```

On Aevum the token is fixed to tUSD8. The deployer needs tQDAY for gas. Subscribers need tUSD8 from the Aevum faucet (https://faucet.qday.info/en) before `subscribe`.

After a broadcast, verify on the Blockscout API. `SubscriptionManager`'s constructor arguments are the tUSD8 address and the registry address.

```bash
forge verify-contract \
  --chain-id 44005 \
  --verifier blockscout \
  --verifier-url https://explorer-test.qday.info/api \
  --constructor-args $(cast abi-encode "constructor(address,address)" 0x456569838f1d43009A91ebA4263147Afd7233483 <REGISTRY>) \
  <MANAGER> src/SubscriptionManager.sol:SubscriptionManager

forge verify-contract \
  --chain-id 44005 \
  --verifier blockscout \
  --verifier-url https://explorer-test.qday.info/api \
  <REGISTRY> src/SessionKeyRegistry.sol:SessionKeyRegistry
```

Paste the two addresses into the table above after that deploy. Do not invent them.

## Assumptions

See [SECURITY.md](SECURITY.md).