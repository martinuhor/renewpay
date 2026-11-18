import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChainError } from "./account";

describe("chain errors", () => {
  it("names SubscriptionIsCancelled when the RPC hides the revert", () => {
    const rpc = {
      data: "0x1bc77ade",
      details: "execution reverted",
      shortMessage: "RPC Request failed.",
    };
    const reverted = {
      name: "ContractFunctionRevertedError",
      shortMessage: 'The contract function "renewSubscription" reverted.',
      details: "execution reverted",
      data: { errorName: "SubscriptionIsCancelled", args: [] },
      cause: {
        shortMessage: "Execution reverted for an unknown reason.",
        details: "execution reverted",
        cause: rpc,
      },
    };
    const text = formatChainError(reverted);
    assert.match(text, /cancelled/i);
    assert.equal(text.includes("0x"), false);
  });

  it("keeps a wallet rejection readable", () => {
    assert.equal(formatChainError(new Error("User rejected the request.")), "The wallet request was rejected.");
  });

  it("hides a raw revert blob", () => {
    const text = formatChainError(new Error("execution reverted: 0x1bc77ade1234abcd"));
    assert.equal(text.includes("0x"), false);
  });
});
