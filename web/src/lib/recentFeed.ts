import { getAddress, parseAbiItem, type Address, type Hash, type Hex } from "viem";
import { publicClient } from "./account";
import { DEPLOY_BLOCK, SUBSCRIPTION_MANAGER } from "./chain";
import { logWindows } from "./logs";
import { readSubscription, type Renewal, type Subscription } from "./actions";

/** Recent history only. A full scan from the deploy block is too easy to repeat. */
export const FEED_LOOKBACK = 12_000n;
const MAX_SUBSCRIPTIONS = 12;

const planCreated = parseAbiItem(
  "event PlanCreated(bytes32 indexed planId, address indexed merchant, uint256 amount, uint256 periodSeconds, uint256 trialSeconds, string metadataURI)",
);
const subscribed = parseAbiItem(
  "event Subscribed(bytes32 indexed subscriptionId, bytes32 indexed planId, address indexed subscriber, address sessionKey, uint256 spendingCapPerPeriod, uint256 expiry, uint256 charged, uint256 paidUntil)",
);
const renewed = parseAbiItem(
  "event SubscriptionRenewed(bytes32 indexed subscriptionId, address indexed subscriber, address indexed merchant, uint256 amount, uint256 paidUntil)",
);

export function feedStartBlock(latest: bigint, deployBlock = DEPLOY_BLOCK, lookback = FEED_LOOKBACK): bigint {
  if (latest <= deployBlock) return deployBlock;
  const start = latest - lookback;
  return start > deployBlock ? start : deployBlock;
}

export async function recentMerchantActivity(merchant: Address): Promise<{
  subscriptions: { id: Hex; sub: Subscription }[];
  renewals: Renewal[];
}> {
  const who = getAddress(merchant);
  const latest = await publicClient.getBlockNumber();
  const windows = logWindows(feedStartBlock(latest), latest);
  let hasPlan = false;
  for (const window of windows) {
    const plans = await publicClient.getLogs({
      address: SUBSCRIPTION_MANAGER,
      event: planCreated,
      args: { merchant: who },
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
    });
    if (plans.length > 0) {
      hasPlan = true;
      break;
    }
  }
  if (!hasPlan) return { subscriptions: [], renewals: [] };
  const subscriptionIds: Hex[] = [];
  const renewals: Renewal[] = [];
  for (const window of windows) {
    const [started, renewedLogs] = await Promise.all([
      publicClient.getLogs({
        address: SUBSCRIPTION_MANAGER,
        event: subscribed,
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
      }),
      publicClient.getLogs({
        address: SUBSCRIPTION_MANAGER,
        event: renewed,
        args: { merchant: who },
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
      }),
    ]);
    for (const log of started) {
      const id = log.args.subscriptionId;
      if (id && !subscriptionIds.includes(id)) subscriptionIds.push(id);
    }
    for (const log of renewedLogs) {
      renewals.push({
        subscriptionId: log.args.subscriptionId as Hex,
        subscriber: log.args.subscriber as Address,
        amount: log.args.amount ?? 0n,
        paidUntil: log.args.paidUntil ?? 0n,
        txHash: log.transactionHash as Hash,
      });
    }
    if (subscriptionIds.length >= MAX_SUBSCRIPTIONS) break;
  }
  const rows = await Promise.all(
    subscriptionIds.slice(0, MAX_SUBSCRIPTIONS).map(async (id) => {
      try {
        const sub = await readSubscription(id);
        return { id, sub };
      } catch {
        return null;
      }
    }),
  );
  return {
    subscriptions: rows.filter((row): row is { id: Hex; sub: Subscription } => row !== null && getAddress(row.sub.merchant) === who),
    renewals,
  };
}
