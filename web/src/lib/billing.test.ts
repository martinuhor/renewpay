import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, keccak256, toBytes } from "viem";
import { erc20Abi, managerAbi } from "./abi";
import {
  MAX_UINT256,
  assertFiniteApprovals,
  cancelCalls,
  managerAllowanceForRenew,
  paymasterGasAllowance,
  planIdFor,
  renewCalls,
  sessionKeyFromBytes,
  subscribeCalls,
  subscriptionAllowance,
  subscriptionIdFor,
} from "./billing";
import { PAYMASTER_GAS_ALLOWANCE, SPONSOR_FEE, SUBSCRIPTION_MANAGER, TUSD8 } from "./chain";

const merchant = getAddress("0xCDB8793ec57DcdcC432CA083792dE9fb78d46750");
const sessionKey = getAddress("0x00000000000000000000000000000000000000a1");

describe("plan and subscription ids", () => {
  it("matches the Solidity encoding", () => {
    const amount = 1_000_000n;
    const period = 2_592_000n;
    const trial = 0n;
    const metadata = "Pro Plan — 1 tUSD8 / period";
    const id = planIdFor(merchant, amount, period, trial, metadata);
    const again = planIdFor(merchant, amount, period, trial, metadata);
    assert.equal(id, again);
    assert.notEqual(id, planIdFor(merchant, amount, period, trial, `${metadata} `));
    const metaHash = keccak256(toBytes(metadata));
    assert.match(metaHash, /^0x[0-9a-f]{64}$/);
    assert.equal(id.length, 66);
  });

  it("binds the subscription id to the subscriber, plan, and session key", () => {
    const planId = planIdFor(merchant, 1_000_000n, 2_592_000n, 0n, "Pro");
    const subscriber = getAddress("0x00000000000000000000000000000000000000b2");
    const id = subscriptionIdFor(subscriber, planId, sessionKey);
    assert.notEqual(id, subscriptionIdFor(merchant, planId, sessionKey));
    assert.equal(id, subscriptionIdFor(subscriber, planId, sessionKey));
  });
});

describe("allowances", () => {
  const now = 1_700_000_000n;
  const period = 2_592_000n;
  const expiry = now + 365n * 24n * 60n * 60n;

  it("approves two periods of the cap, including a year of 2-minute periods", () => {
    const cap = 2_000_000n;
    const allowance = subscriptionAllowance(cap, now, expiry, period);
    assert.equal(allowance, cap * 2n);
    const shortPeriod = 120n;
    const demo = subscriptionAllowance(cap, now, expiry, shortPeriod);
    assert.equal(demo, 4_000_000n);
    const yearOfShortPeriods = (expiry - now + shortPeriod - 1n) / shortPeriod;
    assert.ok(yearOfShortPeriods > 100_000n);
    assert.ok(demo < cap * yearOfShortPeriods);
    assert.ok(demo < MAX_UINT256);
  });

  it("refuses an unlimited allowance", () => {
    assert.throws(() => subscriptionAllowance(MAX_UINT256, now, now + period, period), /unlimited|overflow/i);
    assert.throws(() => subscriptionAllowance(0n, now, expiry, period), /cap/i);
    assert.throws(() => subscriptionAllowance(1n, now, now, period), /future/i);
  });

  it("keeps the paymaster gas allowance finite", () => {
    assert.equal(paymasterGasAllowance(), PAYMASTER_GAS_ALLOWANCE);
    assert.equal(PAYMASTER_GAS_ALLOWANCE, 100_000n);
    assert.ok(PAYMASTER_GAS_ALLOWANCE < MAX_UINT256);
  });
});

describe("user operation calls", () => {
  const now = 1_700_000_000n;
  const period = 2_592_000n;
  const expiry = now + 365n * 24n * 60n * 60n;
  const planId = planIdFor(merchant, 1_000_000n, period, 0n, "Pro");

  it("encodes subscribe against the live manager selectors", () => {
    const paymaster = getAddress("0x000000000000000000000000000000000000dEa2");
    const { calls, subscriptionAllowance: allowance } = subscribeCalls({
      planId,
      sessionKey,
      cap: 2_000_000n,
      expiry,
      now,
      periodSeconds: period,
      paymaster,
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.to, TUSD8);
    assert.equal(calls[1]?.to, TUSD8);
    assert.equal(calls[2]?.to, SUBSCRIPTION_MANAGER);
    assert.ok(calls[0]?.data.startsWith("0x095ea7b3"));
    assert.equal(BigInt(`0x${calls[0]?.data.slice(10 + 64)}`), allowance);
    assert.equal(BigInt(`0x${calls[1]?.data.slice(10 + 64)}`), PAYMASTER_GAS_ALLOWANCE);
    assert.ok(calls[2]?.data.startsWith("0x6ce07b7a"));
    assertFiniteApprovals(calls);
    const direct = encodeFunctionData({
      abi: managerAbi,
      functionName: "subscribe",
      args: [planId, sessionKey, 2_000_000n, expiry],
    });
    assert.equal(calls[2]?.data, direct);
    assert.ok(direct.startsWith("0x6ce07b7a"));
  });

  it("encodes renew and cancel without an unlimited approval", () => {
    const id = subscriptionIdFor(merchant, planId, sessionKey);
    const renew = renewCalls(id, null);
    assert.ok(renew.at(-1)?.data.startsWith("0x391a20a7"));
    const replaced = renewCalls(id, 4_000_000n);
    assert.equal(replaced.length, 2);
    assert.equal(BigInt(`0x${replaced[0]?.data.slice(10 + 64)}`), 4_000_000n);
    assert.throws(() => renewCalls(id, MAX_UINT256), /unlimited/i);
    const paymaster = getAddress("0x000000000000000000000000000000000000dEa2");
    const cancel = cancelCalls(id, paymaster);
    assert.equal(cancel.length, 3);
    assert.equal(BigInt(`0x${cancel[0]?.data.slice(10 + 64)}`), 0n);
    assert.equal(BigInt(`0x${cancel[1]?.data.slice(10 + 64)}`), SPONSOR_FEE);
    assert.ok(cancel.at(-1)?.data.startsWith("0xd21f1ffc"));
    assertFiniteApprovals(renew);
    assertFiniteApprovals(cancel);
    assert.equal(managerAllowanceForRenew(MAX_UINT256, 4_000_000n), 4_000_000n);
    assert.equal(managerAllowanceForRenew(4_000_000n, 4_000_000n), null);
    assert.equal(managerAllowanceForRenew(2_000_000n, 4_000_000n), null);
    assert.equal(managerAllowanceForRenew(1_999_999n, 4_000_000n), 4_000_000n);
    assert.throws(() => managerAllowanceForRenew(0n, MAX_UINT256), /unlimited/i);
  });

  it("rejects the zero session key", () => {
    assert.throws(() => sessionKeyFromBytes(new Uint8Array(20)), /zero/i);
  });
});

describe("erc20 approve selector", () => {
  it("is the selector the allowance guard recognizes", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SUBSCRIPTION_MANAGER, 1n],
    });
    assert.ok(data.startsWith("0x095ea7b3"));
  });
});
