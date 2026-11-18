import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, managerAbi } from "./abi";
import {
  PAYMASTER_GAS_ALLOWANCE,
  SUBSCRIPTION_MANAGER,
  TUSD8,
  TUSD8_DECIMALS,
} from "./chain";

/** Matches `type(uint256).max`. The manager reverts `UnlimitedAllowance` on this value. */
export const MAX_UINT256 = (1n << 256n) - 1n;

export type Call = { to: Address; data: Hex; value: bigint };

const APPROVE_SELECTOR = "0x095ea7b3";

export function formatTusd(amount: bigint): string {
  return formatUnits(amount, TUSD8_DECIMALS);
}

export function formatPeriod(seconds: bigint): string {
  if (seconds === 120n) return "2 minutes";
  if (seconds > 0n && seconds % 86_400n === 0n) {
    const days = seconds / 86_400n;
    return days === 1n ? "1 day" : `${days.toString()} days`;
  }
  if (seconds > 0n && seconds % 60n === 0n) {
    const minutes = seconds / 60n;
    return minutes === 1n ? "1 minute" : `${minutes.toString()} minutes`;
  }
  return `${seconds.toString()} seconds`;
}

export function parseTusdInput(raw: string): bigint {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error("Enter a non-negative integer.");
  return BigInt(trimmed);
}

export function planIdFor(
  merchant: Address,
  amount: bigint,
  periodSeconds: bigint,
  trialSeconds: bigint,
  metadataURI: string,
): Hex {
  const metaHash = keccak256(toBytes(metadataURI));
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [merchant, amount, periodSeconds, trialSeconds, metaHash],
    ),
  );
}

export function subscriptionIdFor(subscriber: Address, planId: Hex, sessionKey: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "address" }],
      [subscriber, planId, sessionKey],
    ),
  );
}

/**
 * Periods the checkout pre-approves. Two covers the first charge and one renewal.
 * The session key can expire later. A year of 2-minute periods is not pre-approved.
 */
export const APPROVED_PERIODS = 2n;

/**
 * Finite allowance for the next few pulls: `cap * APPROVED_PERIODS`.
 * Refuses zero and `type(uint256).max`. Expiry is checked so a dead session key is not funded.
 */
export function subscriptionAllowance(cap: bigint, now: bigint, expiry: bigint, periodSeconds: bigint): bigint {
  if (cap <= 0n) throw new Error("Spending cap must be greater than zero.");
  if (periodSeconds <= 0n) throw new Error("Billing period must be greater than zero.");
  if (expiry <= now) throw new Error("Expiry must be in the future.");
  const covered = (expiry - now + periodSeconds - 1n) / periodSeconds;
  if (covered <= 0n) throw new Error("Expiry does not cover a billing period.");
  if (APPROVED_PERIODS > (MAX_UINT256 - 1n) / cap) throw new Error("That cap would overflow the allowance.");
  const allowance = cap * APPROVED_PERIODS;
  if (allowance <= 0n || allowance >= MAX_UINT256) {
    throw new Error("Refusing an unlimited tUSD8 allowance.");
  }
  return allowance;
}

export function paymasterGasAllowance(): bigint {
  if (PAYMASTER_GAS_ALLOWANCE <= 0n || PAYMASTER_GAS_ALLOWANCE >= MAX_UINT256) {
    throw new Error("Refusing an unlimited paymaster allowance.");
  }
  return PAYMASTER_GAS_ALLOWANCE;
}

export function finiteFund(amount: bigint): bigint {
  if (amount <= 0n || amount >= MAX_UINT256) throw new Error("The tUSD8 transfer amount has to be finite and above zero.");
  return amount;
}

export function sessionKeyFromBytes(bytes: Uint8Array): Address {
  if (bytes.length !== 20) throw new Error("A session key address is 20 bytes.");
  if (bytes.every((byte) => byte === 0)) throw new Error("The session key address is zero.");
  return getAddress(toHex(bytes));
}

export function randomSessionKey(): Address {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return sessionKeyFromBytes(bytes);
}

function approve(spender: Address, amount: bigint): Call {
  if (amount <= 0n || amount >= MAX_UINT256) throw new Error("Refusing an unlimited tUSD8 allowance.");
  return {
    to: TUSD8,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

function managerCall(functionName: "subscribe" | "renewSubscription" | "cancelSubscription", args: readonly unknown[]): Call {
  return {
    to: SUBSCRIPTION_MANAGER,
    value: 0n,
    data: encodeFunctionData({
      abi: managerAbi,
      functionName,
      args: args as never,
    }),
  };
}

export function assertFiniteApprovals(calls: readonly Call[]): void {
  for (const call of calls) {
    if (getAddress(call.to) !== TUSD8) continue;
    if (!call.data.toLowerCase().startsWith(APPROVE_SELECTOR)) continue;
    const amount = BigInt(`0x${call.data.slice(10 + 64)}`);
    if (amount >= MAX_UINT256) throw new Error("Refusing an unlimited tUSD8 allowance.");
  }
}

export function subscribeCalls(input: {
  planId: Hex;
  sessionKey: Address;
  cap: bigint;
  expiry: bigint;
  now: bigint;
  periodSeconds: bigint;
  paymaster: Address;
}): { calls: Call[]; subscriptionAllowance: bigint } {
  const allowance = subscriptionAllowance(input.cap, input.now, input.expiry, input.periodSeconds);
  const calls = [
    approve(SUBSCRIPTION_MANAGER, allowance),
    approve(input.paymaster, paymasterGasAllowance()),
    managerCall("subscribe", [input.planId, input.sessionKey, input.cap, input.expiry]),
  ];
  assertFiniteApprovals(calls);
  return { calls, subscriptionAllowance: allowance };
}

export function renewCalls(subscriptionId: Hex, replaceManagerAllowance: bigint | null): Call[] {
  const calls: Call[] = [];
  if (replaceManagerAllowance !== null) {
    if (replaceManagerAllowance >= MAX_UINT256) throw new Error("Refusing an unlimited tUSD8 allowance.");
    calls.push(approve(SUBSCRIPTION_MANAGER, replaceManagerAllowance));
  }
  calls.push(managerCall("renewSubscription", [subscriptionId]));
  assertFiniteApprovals(calls);
  return calls;
}

export function cancelCalls(subscriptionId: Hex): Call[] {
  const calls = [managerCall("cancelSubscription", [subscriptionId])];
  assertFiniteApprovals(calls);
  return calls;
}

/**
 * Replace the manager allowance only when it cannot cover another pull.
 * One pull is at most the per-period cap. A still-sufficient balance is left alone.
 */
export function managerAllowanceForRenew(current: bigint, finite: bigint): bigint | null {
  if (finite <= 0n || finite >= MAX_UINT256) throw new Error("Refusing an unlimited tUSD8 allowance.");
  if (current >= MAX_UINT256) return finite;
  const onePeriod = finite / APPROVED_PERIODS;
  if (onePeriod > 0n && current >= onePeriod) return null;
  return finite;
}
