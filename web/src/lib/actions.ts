import { getAddress, parseAbiItem, type Address, type Hash, type Hex } from "viem";
import { erc20Abi, managerAbi } from "./abi";
import { ensureAevum, formatChainError, publicClient, subscriberAccount, userOpClient, walletClientFor } from "./account";
import {
  cancelCalls,
  finiteFund,
  managerAllowanceForRenew,
  paymasterGasAllowance,
  renewCalls,
  subscribeCalls,
  subscriptionAllowance,
  type Call,
} from "./billing";
import {
  DEPLOY_BLOCK,
  STABLECOIN_PAYMASTER,
  SUBSCRIPTION_MANAGER,
  TUSD8,
} from "./chain";
import { logWindows, type LogWindow } from "./logs";

const planCreated = parseAbiItem(
  "event PlanCreated(bytes32 indexed planId, address indexed merchant, uint256 amount, uint256 periodSeconds, uint256 trialSeconds, string metadataURI)",
);
const subscribed = parseAbiItem(
  "event Subscribed(bytes32 indexed subscriptionId, bytes32 indexed planId, address indexed subscriber, address sessionKey, uint256 spendingCapPerPeriod, uint256 expiry, uint256 charged, uint256 paidUntil)",
);
const renewed = parseAbiItem(
  "event SubscriptionRenewed(bytes32 indexed subscriptionId, address indexed subscriber, address indexed merchant, uint256 amount, uint256 paidUntil)",
);

async function chunked<T>(read: (window: LogWindow) => Promise<readonly T[]>): Promise<T[]> {
  const latest = await publicClient.getBlockNumber();
  const windows = logWindows(DEPLOY_BLOCK, latest);
  const logs: T[] = [];
  for (let index = 0; index < windows.length; index += 4) {
    const batch = await Promise.all(windows.slice(index, index + 4).map((window) => read(window)));
    for (const part of batch) logs.push(...part);
  }
  return logs;
}

export type Plan = {
  merchant: Address;
  amount: bigint;
  periodSeconds: bigint;
  trialSeconds: bigint;
  metadataURI: string;
};

export type Subscription = {
  subscriber: Address;
  merchant: Address;
  planId: Hex;
  sessionKey: Address;
  spendingCapPerPeriod: bigint;
  expiry: bigint;
  amount: bigint;
  periodSeconds: bigint;
  paidUntil: bigint;
  cancelled: boolean;
  exists: boolean;
};

export type Renewal = {
  subscriptionId: Hex;
  subscriber: Address;
  amount: bigint;
  paidUntil: bigint;
  txHash: Hash;
};

function asPlan(value: unknown): Plan {
  const plan = value as Plan;
  return {
    merchant: plan.merchant,
    amount: plan.amount,
    periodSeconds: plan.periodSeconds,
    trialSeconds: plan.trialSeconds,
    metadataURI: plan.metadataURI,
  };
}

function asSubscription(value: unknown): Subscription {
  const sub = value as Subscription;
  return {
    subscriber: sub.subscriber,
    merchant: sub.merchant,
    planId: sub.planId,
    sessionKey: sub.sessionKey,
    spendingCapPerPeriod: sub.spendingCapPerPeriod,
    expiry: sub.expiry,
    amount: sub.amount,
    periodSeconds: sub.periodSeconds,
    paidUntil: sub.paidUntil,
    cancelled: sub.cancelled,
    exists: sub.exists,
  };
}

async function sendUserOperation(ethereum: EthereumProvider, calls: readonly Call[]): Promise<Hash> {
  await ensureAevum(ethereum);
  const account = await subscriberAccount(ethereum);
  const bundler = userOpClient(account);
  const callData = await account.encodeCalls(calls.map((call) => ({ to: call.to, data: call.data, value: call.value })));
  const hash = await bundler.sendUserOperation({ account, callData });
  const receipt = await bundler.waitForUserOperationReceipt({ hash });
  return receipt.receipt.transactionHash;
}

export async function readBalances(address: Address): Promise<{ token: bigint; native: bigint }> {
  const [token, native] = await Promise.all([
    publicClient.readContract({
      address: TUSD8,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    publicClient.getBalance({ address }),
  ]);
  return { token, native };
}

export async function readAllowance(owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({
    address: TUSD8,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function readPlan(planId: Hex): Promise<Plan> {
  const plan = await publicClient.readContract({
    address: SUBSCRIPTION_MANAGER,
    abi: managerAbi,
    functionName: "getPlan",
    args: [planId],
  });
  return asPlan(plan);
}

export async function readSubscription(subscriptionId: Hex): Promise<Subscription> {
  const sub = await publicClient.readContract({
    address: SUBSCRIPTION_MANAGER,
    abi: managerAbi,
    functionName: "getSubscription",
    args: [subscriptionId],
  });
  return asSubscription(sub);
}

export async function blockTimestamp(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

export async function createPlan(input: {
  ethereum: EthereumProvider;
  merchant: Address;
  amount: bigint;
  periodSeconds: bigint;
  trialSeconds: bigint;
  metadataURI: string;
}): Promise<{ hash: Hash; planId: Hex }> {
  await ensureAevum(input.ethereum);
  const wallet = walletClientFor(input.ethereum, input.merchant);
  const simulation = await publicClient.simulateContract({
    account: input.merchant,
    address: SUBSCRIPTION_MANAGER,
    abi: managerAbi,
    functionName: "createPlan",
    args: [input.amount, input.periodSeconds, input.trialSeconds, input.metadataURI],
  });
  const hash = await wallet.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("createPlan reverted.");
  const planId = simulation.result;
  return { hash, planId };
}

export async function fundSubscriber(input: {
  ethereum: EthereumProvider;
  from: Address;
  to: Address;
  amount: bigint;
}): Promise<Hash> {
  const amount = finiteFund(input.amount);
  await ensureAevum(input.ethereum);
  const wallet = walletClientFor(input.ethereum, input.from);
  const simulation = await publicClient.simulateContract({
    account: input.from,
    address: TUSD8,
    abi: erc20Abi,
    functionName: "transfer",
    args: [input.to, amount],
  });
  const hash = await wallet.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The tUSD8 transfer reverted.");
  return hash;
}

export async function subscribe(input: {
  ethereum: EthereumProvider;
  planId: Hex;
  sessionKey: Address;
  cap: bigint;
  expiry: bigint;
  periodSeconds: bigint;
}): Promise<Hash> {
  const now = await blockTimestamp();
  const { calls } = subscribeCalls({ ...input, now });
  return sendUserOperation(input.ethereum, calls);
}

export async function renew(input: {
  ethereum: EthereumProvider;
  subscriber: Address;
  subscriptionId: Hex;
  cap: bigint;
  expiry: bigint;
  periodSeconds: bigint;
}): Promise<Hash> {
  const now = await blockTimestamp();
  const finite = subscriptionAllowance(input.cap, now, input.expiry, input.periodSeconds);
  const current = await readAllowance(input.subscriber, SUBSCRIPTION_MANAGER);
  const calls = renewCalls(input.subscriptionId, managerAllowanceForRenew(current, finite));
  return sendUserOperation(input.ethereum, calls);
}

export async function cancel(ethereum: EthereumProvider, subscriptionId: Hex): Promise<Hash> {
  return sendUserOperation(ethereum, cancelCalls(subscriptionId));
}

/** Read-only. Names the revert a renewal would hit, without sending a transaction. */
export async function renewalRevert(subscriptionId: Hex): Promise<string> {
  try {
    await publicClient.simulateContract({
      address: SUBSCRIPTION_MANAGER,
      abi: managerAbi,
      functionName: "renewSubscription",
      args: [subscriptionId],
    });
    return "A renewal would succeed right now.";
  } catch (cause) {
    return formatChainError(cause);
  }
}

export async function merchantPlans(merchant: Address): Promise<{ planId: Hex; plan: Plan; txHash: Hash }[]> {
  const logs = await chunked((window) =>
    publicClient.getLogs({
      address: SUBSCRIPTION_MANAGER,
      event: planCreated,
      args: { merchant },
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
    }),
  );
  return logs.map((log) => ({
    planId: log.args.planId as Hex,
    txHash: log.transactionHash as Hash,
    plan: {
      merchant,
      amount: log.args.amount ?? 0n,
      periodSeconds: log.args.periodSeconds ?? 0n,
      trialSeconds: log.args.trialSeconds ?? 0n,
      metadataURI: log.args.metadataURI ?? "",
    },
  }));
}

export async function merchantSubscriptions(merchant: Address): Promise<{ id: Hex; sub: Subscription }[]> {
  const logs = await chunked((window) =>
    publicClient.getLogs({
      address: SUBSCRIPTION_MANAGER,
      event: subscribed,
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
    }),
  );
  const ids = [...new Set(logs.map((log) => log.args.subscriptionId).filter((id): id is Hex => Boolean(id)))];
  const rows = await Promise.all(
    ids.map(async (id) => {
      try {
        const sub = await readSubscription(id);
        return { id, sub };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row): row is { id: Hex; sub: Subscription } => row !== null && getAddress(row.sub.merchant) === merchant);
}

export async function merchantRenewals(merchant: Address): Promise<Renewal[]> {
  const logs = await chunked((window) =>
    publicClient.getLogs({
      address: SUBSCRIPTION_MANAGER,
      event: renewed,
      args: { merchant },
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
    }),
  );
  return logs.map((log) => ({
    subscriptionId: log.args.subscriptionId as Hex,
    subscriber: log.args.subscriber as Address,
    amount: log.args.amount ?? 0n,
    paidUntil: log.args.paidUntil ?? 0n,
    txHash: log.transactionHash as Hash,
  }));
}

export function paymasterSpender(): Address {
  return STABLECOIN_PAYMASTER;
}

export function gasAllowance(): bigint {
  return paymasterGasAllowance();
}

export { formatChainError };
