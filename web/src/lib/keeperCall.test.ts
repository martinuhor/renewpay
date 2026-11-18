import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { managerAbi } from "./abi";
import { EXECUTE_SELECTOR, SUBSCRIPTION_MANAGER } from "./chain";
import { keeperChoice, parseKeeperFile, renewOnlyCallData } from "./keeperCall";

const id = `0x${"ab".repeat(32)}` as const;

describe("background keeper", () => {
  it("renews only when the period is due and the subscription is still active", () => {
    assert.equal(keeperChoice({ exists: true, cancelled: false, paidUntil: 100n }, 99n), "wait");
    assert.equal(keeperChoice({ exists: true, cancelled: false, paidUntil: 100n }, 100n), "renew");
    assert.equal(keeperChoice({ exists: true, cancelled: true, paidUntil: 1n }, 100n), "cancelled");
    assert.equal(keeperChoice({ exists: false, cancelled: false, paidUntil: 0n }, 1n), "missing");
  });

  it("encodes a single renewSubscription and does not touch an allowance", () => {
    const data = renewOnlyCallData(id);
    const renew = encodeFunctionData({ abi: managerAbi, functionName: "renewSubscription", args: [id] });
    assert.equal(data.startsWith(EXECUTE_SELECTOR), true);
    assert.equal(data.toLowerCase().includes(renew.slice(2).toLowerCase()), true);
    assert.equal(data.toLowerCase().includes(SUBSCRIPTION_MANAGER.slice(2).toLowerCase()), true);
    assert.equal(data.toLowerCase().includes("095ea7b3"), false);
  });

  it("reads a keeper file and refuses a truncated session key", () => {
    const file = {
      version: 1,
      subscriber: "0xCDB8793ec57DcdcC432CA083792dE9fb78d46750",
      subscriptionId: id,
      sessionPrivateKey: generatePrivateKey(),
      paymaster: "0x0000000000000000000000000000000000000001",
      policy: "0x0000000000000000000000000000000000000002",
      enableSignature: null,
      enableNonce: null,
    };
    assert.equal(parseKeeperFile(JSON.stringify(file)).subscriber, "0xCDB8793ec57DcdcC432CA083792dE9fb78d46750");
    assert.throws(() => parseKeeperFile(JSON.stringify({ ...file, sessionPrivateKey: "0xabc" })), /session key/i);
  });
});
