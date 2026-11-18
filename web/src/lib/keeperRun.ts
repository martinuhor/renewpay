import { concatHex, getAddress, toHex, type Address, type Hash, type Hex } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { formatChainError, publicClient } from "./account";
import { readSubscription } from "./actions";
import {
  AEVUM_BUNDLER,
  AEVUM_CHAIN_ID,
  ENTRY_POINT,
  PAYMASTER_POST_OP_GAS,
  PAYMASTER_VERIFICATION_GAS,
  USEROP_CALL_GAS,
  USEROP_PRE_VERIFICATION_GAS,
  USEROP_VERIFICATION_GAS,
} from "./chain";
import { keeperChoice, renewOnlyCallData, type KeeperFile } from "./keeperCall";
import {
  enableDataFor,
  kernelEnableNonce,
  packEnableSignature,
  permissionIdFor,
  permissionNonceKey,
  sessionPermissionEnabled,
} from "./sponsorship";

const nonceAbi = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

export type KeeperTick = { stop: boolean; message: string; hash?: Hash };

export async function keeperTick(file: KeeperFile, now = BigInt(Math.floor(Date.now() / 1000))): Promise<KeeperTick> {
  const subscription = await readSubscription(file.subscriptionId);
  const choice = keeperChoice(subscription, now);
  if (choice === "missing") return { stop: true, message: "That subscription is not on chain. The keeper stopped." };
  if (choice === "cancelled") return { stop: true, message: "The subscription is cancelled. The keeper stopped." };
  if (choice === "wait") {
    const left = Number(subscription.paidUntil - now);
    return { stop: false, message: `Not due. Next renewal in ${left}s. The browser can stay closed.` };
  }
  if (getAddress(subscription.subscriber) !== file.subscriber) {
    return { stop: true, message: "The keeper file does not match this subscriber. Arm it again." };
  }
  if (getAddress(subscription.sessionKey) !== getAddress(privateKeyToAccount(file.sessionPrivateKey).address)) {
    return { stop: true, message: "The session key in the file is not the key on this subscription. Arm it again." };
  }
  const hash = await submitRenewOnly(file);
  return { stop: false, message: `Renewed ${hash}. The call was only renewSubscription.`, hash };
}

async function submitRenewOnly(file: KeeperFile): Promise<Hash> {
  const deposit = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [file.paymaster],
  });
  if (deposit === 0n) throw new Error("Fund the paymaster with 0.05 tQDAY first. The subscriber then pays 0.01 tUSD8.");
  const enabled = await sessionPermissionEnabled(file.subscriber, file.policy, privateKeyToAccount(file.sessionPrivateKey).address);
  const mode = enabled ? "0x00" : "0x01";
  if (!enabled) {
    if (!file.enableSignature || file.enableNonce === null) {
      throw new Error("Arm the keeper once in the checkout so the wallet can approve the session key.");
    }
    const nonce = await kernelEnableNonce(file.subscriber);
    if (nonce !== file.enableNonce) throw new Error("Arm the keeper again. The wallet approval is stale.");
  }
  const permissionId = permissionIdFor(file.policy, privateKeyToAccount(file.sessionPrivateKey).address);
  const nonce = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: nonceAbi,
    functionName: "getNonce",
    args: [file.subscriber, permissionNonceKey(mode, permissionId)],
  });
  const callData = renewOnlyCallData(file.subscriptionId);
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const floor = 1_000_000n;
  const maxPriorityFeePerGas = base > floor ? base : floor;
  const operation = {
    sender: file.subscriber,
    nonce,
    callData,
    callGasLimit: USEROP_CALL_GAS,
    verificationGasLimit: USEROP_VERIFICATION_GAS,
    preVerificationGas: USEROP_PRE_VERIFICATION_GAS,
    maxFeePerGas: base * 2n + maxPriorityFeePerGas,
    maxPriorityFeePerGas,
    paymaster: file.paymaster,
    paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
    paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS,
    paymasterData: "0x" as Hex,
    signature: "0x" as Hex,
  };
  const hash = getUserOperationHash({
    userOperation: operation,
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: "0.7",
    chainId: AEVUM_CHAIN_ID,
  });
  const sessionSignature = await privateKeyToAccount(file.sessionPrivateKey).signMessage({ message: { raw: hash } });
  const userOpSignature = concatHex(["0xff", sessionSignature]);
  const sessionKey = privateKeyToAccount(file.sessionPrivateKey).address;
  operation.signature =
    !enabled && file.enableSignature
      ? packEnableSignature(enableDataFor(file.policy, sessionKey), file.enableSignature, userOpSignature)
      : userOpSignature;
  return send(operation);
}

async function send(operation: {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
  signature: Hex;
}): Promise<Hash> {
  const rpc: Record<string, string> = {
    sender: operation.sender,
    nonce: toHex(operation.nonce),
    callData: operation.callData,
    callGasLimit: toHex(operation.callGasLimit),
    verificationGasLimit: toHex(operation.verificationGasLimit),
    preVerificationGas: toHex(operation.preVerificationGas),
    maxFeePerGas: toHex(operation.maxFeePerGas),
    maxPriorityFeePerGas: toHex(operation.maxPriorityFeePerGas),
    paymaster: operation.paymaster,
    paymasterVerificationGasLimit: toHex(operation.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: toHex(operation.paymasterPostOpGasLimit),
    paymasterData: operation.paymasterData,
    signature: operation.signature,
  };
  const opHash = (await bundler("eth_sendUserOperation", [rpc, ENTRY_POINT])) as Hash;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const receipt = (await bundler("eth_getUserOperationReceipt", [opHash])) as {
      success?: boolean;
      reason?: string;
      receipt?: { transactionHash?: Hash };
    } | null;
    if (receipt) {
      if (receipt.success === false) throw new Error(receipt.reason || "The UserOperation reverted.");
      const hash = receipt.receipt?.transactionHash;
      if (!hash) throw new Error("The UserOperation was included without a transaction hash.");
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("The UserOperation was not included. Check the paymaster deposit and try again.");
}

async function bundler(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(AEVUM_BUNDLER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(formatChainError(new Error(body.error.message || "The bundler rejected the UserOperation.")));
  return body.result ?? null;
}
