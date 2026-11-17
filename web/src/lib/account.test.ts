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
    assert.equal(formatChainError(reverted), "SubscriptionIsCancelled");
  });

  it("keeps a wallet message when there is no custom error", () => {
    assert.equal(formatChainError(new Error("User rejected the request.")), "User rejected the request.");
  });
});
