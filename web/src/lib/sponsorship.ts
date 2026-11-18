import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  pad,
  slice,
  toHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { paymasterAbi, paymasterBytecode, policyBytecode } from "./contracts";
import { subscriberAccount, publicClient, walletClientFor, type KernelAccount } from "./account";
import {
  AEVUM_BUNDLER,
  AEVUM_CHAIN_ID,
  DEMO_GAS_DEPOSIT,
  ECDSA_SIGNER,
  ENTRY_POINT,
  EXECUTE_SELECTOR,
  PAYMASTER_POST_OP_GAS,
  PAYMASTER_VERIFICATION_GAS,
  USEROP_CALL_GAS,
  USEROP_PRE_VERIFICATION_GAS,
  USEROP_VERIFICATION_GAS,
  aevum,
} from "./chain";
import { DEMO_PAYMASTER_FUNDED_KEY, DEMO_PAYMASTER_KEY, DEMO_POLICY_KEY, markDemo, readDemo } from "./demo";

const SESSION_SECRET = "renewpay.sessionSecret";
const ENABLE_TYPEHASH = "0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505";
const UNSTAKE_DELAY = 86_400;

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

const kernelAbi = [
  {
    type: "function",
    name: "currentNonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "permissionConfig",
    stateMutability: "view",
    inputs: [{ name: "pId", type: "bytes4" }],
    outputs: [
      { name: "permissionFlag", type: "bytes2" },
      { name: "signer", type: "address" },
      { name: "policyData", type: "bytes22[]" },
    ],
  },
] as const;

export type PreparedCall = { to: Address; data: Hex; value: bigint };

export function sessionSigner(): { privateKey: Hex; address: Address } {
  const saved = localStorage.getItem(SESSION_SECRET);
  const privateKey = saved && isHex(saved) && saved.length === 66 ? saved : generatePrivateKey();
  if (privateKey !== saved) localStorage.setItem(SESSION_SECRET, privateKey);
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export function rotateSessionSigner(): Address {
  const privateKey = generatePrivateKey();
  localStorage.setItem(SESSION_SECRET, privateKey);
  return privateKeyToAccount(privateKey).address;
}

export function savedPolicy(): Address | null {
  const value = readDemo(DEMO_POLICY_KEY);
  return isAddress(value) ? getAddress(value) : null;
}

export function savedPaymaster(): Address | null {
  const value = readDemo(DEMO_PAYMASTER_KEY);
  return isAddress(value) ? getAddress(value) : null;
}

export function requirePaymaster(): Address {
  const paymaster = savedPaymaster();
  if (!paymaster) throw new Error("Deploy the paymaster, then fund it, before this step.");
  return paymaster;
}

export function permissionIdFor(policy: Address, sessionKey: Address): Hex {
  const policyBytes = concatHex(["0x0000", policy]);
  const policyList = encodeAbiParameters([{ type: "bytes[]" }], [[policyBytes]]);
  const signerId = encodeAbiParameters([{ type: "bytes" }], [concatHex([ECDSA_SIGNER, sessionKey])]);
  const packed = encodeAbiParameters([{ type: "bytes[]" }], [[policyList, "0x0000", signerId]]);
  return slice(keccak256(packed), 0, 4);
}

export function enableDataFor(policy: Address, sessionKey: Address): Hex {
  const policyBytes = concatHex(["0x0000", policy]);
  const signerBytes = concatHex(["0x0000", ECDSA_SIGNER, sessionKey]);
  return encodeAbiParameters([{ type: "bytes[]" }], [[policyBytes, signerBytes]]);
}

export function validationIdFor(permissionId: Hex): Hex {
  return concatHex(["0x02", pad(permissionId, { size: 20, dir: "right" })]);
}

export function permissionNonceKey(mode: "0x00" | "0x01", permissionId: Hex): bigint {
  return BigInt(concatHex([mode, "0x02", pad(permissionId, { size: 20, dir: "right" }), "0x0000"]));
}

export function packEnableSignature(enableData: Hex, enableSignature: Hex, userOpSignature: Hex): Hex {
  return concatHex([
    zeroAddress,
    encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }, { type: "bytes" }, { type: "bytes" }],
      [enableData, "0x", EXECUTE_SELECTOR, enableSignature, userOpSignature],
    ),
  ]);
}

export function enableDigest(input: {
  account: Address;
  validationId: Hex;
  nonce: number;
  validatorData: Hex;
}): Hex {
  return hashTypedData({
    domain: { name: "Kernel", version: "0.3.1", chainId: AEVUM_CHAIN_ID, verifyingContract: input.account },
    types: {
      Enable: [
        { name: "validationId", type: "bytes21" },
        { name: "nonce", type: "uint32" },
        { name: "hook", type: "address" },
        { name: "validatorData", type: "bytes" },
        { name: "hookData", type: "bytes" },
        { name: "selectorData", type: "bytes" },
      ],
    },
    primaryType: "Enable",
    message: {
      validationId: input.validationId,
      nonce: input.nonce,
      hook: zeroAddress,
      validatorData: input.validatorData,
      hookData: "0x",
      selectorData: EXECUTE_SELECTOR,
    },
  });
}

export const KERNEL_ENABLE_TYPEHASH = ENABLE_TYPEHASH;

export async function deployPolicy(ethereum: EthereumProvider, from: Address): Promise<Address> {
  const address = await deploy(ethereum, from, policyBytecode);
  markDemo(DEMO_POLICY_KEY, address);
  return address;
}

export async function deployPaymaster(ethereum: EthereumProvider, from: Address): Promise<Address> {
  const address = await deploy(ethereum, from, paymasterBytecode);
  markDemo(DEMO_PAYMASTER_KEY, address);
  return address;
}

export async function fundPaymaster(ethereum: EthereumProvider, from: Address, paymaster: Address): Promise<Hash> {
  const wallet = walletClientFor(ethereum, from);
  const hash = await wallet.writeContract({
    account: from,
    chain: aevum,
    address: paymaster,
    abi: paymasterAbi,
    functionName: "fund",
    args: [UNSTAKE_DELAY],
    value: DEMO_GAS_DEPOSIT,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Funding the paymaster reverted.");
  markDemo(DEMO_PAYMASTER_FUNDED_KEY, "1");
  return hash;
}

async function deploy(ethereum: EthereumProvider, from: Address, bytecode: Hex): Promise<Address> {
  const wallet = walletClientFor(ethereum, from);
  const hash = await wallet.deployContract({
    account: from,
    chain: aevum,
    abi: [],
    bytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("The deploy reverted.");
  return receipt.contractAddress;
}

type Operation = {
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
  factory?: Address;
  factoryData?: Hex;
};

export async function sendOwnerOperation(ethereum: EthereumProvider, calls: readonly PreparedCall[]): Promise<Hash> {
  const paymaster = requirePaymaster();
  await assertPaymasterFunded(paymaster);
  const account = await subscriberAccount(ethereum);
  const sender = await account.getAddress();
  const callData = await account.encodeCalls(calls.map((call) => ({ to: call.to, data: call.data, value: call.value })));
  const nonce = await account.getNonce();
  const operation = await fillOperation({ account, sender, nonce, callData, paymaster, signature: "0x" });
  operation.signature = await account.signUserOperation({ ...operation, chainId: AEVUM_CHAIN_ID });
  return submit(operation);
}

export async function sendSessionRenewal(input: {
  ethereum: EthereumProvider;
  owner: Address;
  subscriber: Address;
  calls: readonly PreparedCall[];
  sessionKey: Address;
  privateKey: Hex;
}): Promise<{ hash: Hash; firstEnable: boolean }> {
  const paymaster = requirePaymaster();
  const policy = savedPolicy();
  if (!policy) throw new Error("Deploy the renew policy before renewing.");
  if (getAddress(privateKeyToAccount(input.privateKey).address) !== getAddress(input.sessionKey)) {
    throw new Error("This browser does not hold that session key. Subscribe again with the key shown here.");
  }
  await assertPaymasterFunded(paymaster);
  const account = await subscriberAccount(input.ethereum);
  const sender = await account.getAddress();
  if (getAddress(sender) !== getAddress(input.subscriber)) {
    throw new Error("The connected wallet does not own this subscriber account.");
  }
  const callData = await account.encodeCalls(input.calls.map((call) => ({ to: call.to, data: call.data, value: call.value })));
  const permissionId = permissionIdFor(policy, input.sessionKey);
  const enabled = await permissionEnabled(sender, permissionId);
  const mode = enabled ? "0x00" : "0x01";
  const nonce = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: nonceAbi,
    functionName: "getNonce",
    args: [sender, permissionNonceKey(mode, permissionId)],
  });
  let enableSignature: Hex | null = null;
  let validatorData: Hex | null = null;
  if (!enabled) {
    const currentNonce = await publicClient.readContract({
      address: sender,
      abi: kernelAbi,
      functionName: "currentNonce",
    });
    validatorData = enableDataFor(policy, input.sessionKey);
    const wallet = walletClientFor(input.ethereum, input.owner);
    enableSignature = await wallet.signTypedData({
      account: input.owner,
      domain: { name: "Kernel", version: "0.3.1", chainId: AEVUM_CHAIN_ID, verifyingContract: sender },
      types: {
        Enable: [
          { name: "validationId", type: "bytes21" },
          { name: "nonce", type: "uint32" },
          { name: "hook", type: "address" },
          { name: "validatorData", type: "bytes" },
          { name: "hookData", type: "bytes" },
          { name: "selectorData", type: "bytes" },
        ],
      },
      primaryType: "Enable",
      message: {
        validationId: validationIdFor(permissionId),
        nonce: currentNonce,
        hook: zeroAddress,
        validatorData,
        hookData: "0x",
        selectorData: EXECUTE_SELECTOR,
      },
    });
  }
  const operation = await fillOperation({ account, sender, nonce, callData, paymaster, signature: "0x" });
  const hash = getUserOperationHash({
    userOperation: { ...operation, signature: "0x" },
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: "0.7",
    chainId: AEVUM_CHAIN_ID,
  });
  const sessionSignature = await privateKeyToAccount(input.privateKey).signMessage({ message: { raw: hash } });
  const userOpSignature = concatHex(["0xff", sessionSignature]);
  operation.signature =
    enableSignature && validatorData
      ? packEnableSignature(validatorData, enableSignature, userOpSignature)
      : userOpSignature;
  return { hash: await submit(operation), firstEnable: !enabled };
}

async function permissionEnabled(account: Address, permissionId: Hex): Promise<boolean> {
  const config = await publicClient.readContract({
    address: account,
    abi: kernelAbi,
    functionName: "permissionConfig",
    args: [permissionId],
  });
  return getAddress(config[1]) === ECDSA_SIGNER;
}

async function assertPaymasterFunded(paymaster: Address): Promise<void> {
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
    args: [paymaster],
  });
  if (deposit === 0n) throw new Error("Fund the paymaster with 0.05 tQDAY first. The subscriber then pays 0.01 tUSD8.");
}

async function fillOperation(input: {
  account: KernelAccount;
  sender: Address;
  nonce: bigint;
  callData: Hex;
  paymaster: Address;
  signature: Hex;
}): Promise<Operation> {
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const floor = 1_000_000n;
  const maxPriorityFeePerGas = base > floor ? base : floor;
  const maxFeePerGas = base * 2n + maxPriorityFeePerGas;
  const code = await publicClient.getCode({ address: input.sender });
  const operation: Operation = {
    sender: input.sender,
    nonce: input.nonce,
    callData: input.callData,
    callGasLimit: USEROP_CALL_GAS,
    verificationGasLimit: USEROP_VERIFICATION_GAS,
    preVerificationGas: USEROP_PRE_VERIFICATION_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster: input.paymaster,
    paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
    paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS,
    paymasterData: "0x",
    signature: input.signature,
  };
  if (!code || code === "0x") {
    const factoryArgs = await input.account.getFactoryArgs();
    operation.factory = factoryArgs.factory;
    operation.factoryData = factoryArgs.factoryData;
  }
  return operation;
}

async function submit(operation: Operation): Promise<Hash> {
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
  if (operation.factory && operation.factoryData && operation.factoryData !== "0x") {
    rpc.factory = operation.factory;
    rpc.factoryData = operation.factoryData;
  }
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
  if (body.error) throw new Error(body.error.message || "The bundler rejected the UserOperation.");
  return body.result ?? null;
}
