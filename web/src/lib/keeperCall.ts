import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  isAddress,
  isHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { managerAbi } from "./abi";
import { EXECUTE_SELECTOR, SUBSCRIPTION_MANAGER } from "./chain";

const APPROVE_SELECTOR = "095ea7b3";

export type KeeperFile = {
  version: 1;
  subscriber: Address;
  subscriptionId: Hex;
  sessionPrivateKey: Hex;
  paymaster: Address;
  policy: Address;
  enableSignature: Hex | null;
  enableNonce: number | null;
};

export type KeeperChoice = "missing" | "cancelled" | "wait" | "renew";

export function keeperChoice(input: { exists: boolean; cancelled: boolean; paidUntil: bigint }, now: bigint): KeeperChoice {
  if (!input.exists) return "missing";
  if (input.cancelled) return "cancelled";
  if (now < input.paidUntil) return "wait";
  return "renew";
}

/** One Kernel execute whose only inner call is renewSubscription. No approval. */
export function renewOnlyCallData(subscriptionId: Hex): Hex {
  const data = encodeFunctionData({
    abi: managerAbi,
    functionName: "renewSubscription",
    args: [subscriptionId],
  });
  const mode = encodePacked(
    ["bytes1", "bytes1", "bytes4", "bytes4", "bytes22"],
    ["0x00", "0x00", "0x00000000", "0x00000000", `0x${"00".repeat(22)}`],
  );
  const encoded = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "execute",
        stateMutability: "payable",
        inputs: [
          { name: "execMode", type: "bytes32" },
          { name: "executionCalldata", type: "bytes" },
        ],
        outputs: [],
      },
    ],
    functionName: "execute",
    args: [mode, concatHex([SUBSCRIPTION_MANAGER, toHex(0n, { size: 32 }), data])],
  });
  if (!encoded.startsWith(EXECUTE_SELECTOR)) throw new Error("The renewal was not encoded as a Kernel execute.");
  if (encoded.toLowerCase().includes(APPROVE_SELECTOR)) throw new Error("The keeper tried to change an allowance.");
  return encoded;
}

export function parseKeeperFile(raw: string): KeeperFile {
  const parsed = JSON.parse(raw) as Partial<KeeperFile>;
  const subscriber = parsed.subscriber ?? "";
  const paymaster = parsed.paymaster ?? "";
  const policy = parsed.policy ?? "";
  const subscriptionId = parsed.subscriptionId ?? "";
  const sessionPrivateKey = parsed.sessionPrivateKey ?? "";
  if (parsed.version !== 1) throw new Error("This keeper file is from a different checkout.");
  if (!isAddress(subscriber) || !isAddress(paymaster) || !isAddress(policy)) {
    throw new Error("The keeper file is missing an address.");
  }
  if (!isHex(subscriptionId) || subscriptionId.length !== 66) {
    throw new Error("The keeper file is missing the subscription.");
  }
  if (!isHex(sessionPrivateKey) || sessionPrivateKey.length !== 66) {
    throw new Error("The keeper file is missing the session key.");
  }
  const enableSignature = parsed.enableSignature ?? null;
  if (enableSignature !== null && (!isHex(enableSignature) || enableSignature.length < 132)) {
    throw new Error("The keeper file has a bad enable signature.");
  }
  const enableNonce = parsed.enableNonce ?? null;
  if (enableNonce !== null && !Number.isInteger(enableNonce)) throw new Error("The keeper file has a bad enable nonce.");
  return {
    version: 1,
    subscriber: getAddress(subscriber),
    subscriptionId,
    sessionPrivateKey,
    paymaster: getAddress(paymaster),
    policy: getAddress(policy),
    enableSignature,
    enableNonce,
  };
}
