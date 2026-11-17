import { decodeErrorResult, type Address, type EIP1193Provider, type Hex, type WalletClient, createPublicClient, createWalletClient, custom, http } from "viem";
import { managerAbi } from "./abi";
import { createBundlerClient, type BundlerClient } from "viem/account-abstraction";
import { toKernelSmartAccount } from "permissionless/accounts";
import {
  AEVUM_BUNDLER,
  AEVUM_CHAIN_ID,
  AEVUM_RPC,
  aevum,
  ENTRY_POINT,
  KERNEL_ECDSA_VALIDATOR,
  KERNEL_FACTORY,
  KERNEL_META_FACTORY,
} from "./chain";

export type KernelAccount = Awaited<ReturnType<typeof toKernelSmartAccount>>;

export const publicClient = createPublicClient({
  chain: aevum,
  transport: http(AEVUM_RPC),
});

function providerOf(ethereum: EthereumProvider): EIP1193Provider {
  return {
    request: ({ method, params }) =>
      ethereum.request({
        method,
        params: Array.isArray(params) ? params : undefined,
      }),
  } as EIP1193Provider;
}

export function walletClientFor(ethereum: EthereumProvider, address: Address): WalletClient {
  return createWalletClient({
    account: address,
    chain: aevum,
    transport: custom(ethereum),
  });
}

export async function subscriberAccount(ethereum: EthereumProvider): Promise<KernelAccount> {
  return toKernelSmartAccount({
    client: publicClient,
    owners: [providerOf(ethereum)],
    version: "0.3.1",
    entryPoint: { address: ENTRY_POINT, version: "0.7" },
    factoryAddress: KERNEL_FACTORY,
    metaFactoryAddress: KERNEL_META_FACTORY,
    validatorAddress: KERNEL_ECDSA_VALIDATOR,
    useMetaFactory: true,
  });
}

export function userOpClient(account: KernelAccount): BundlerClient {
  return createBundlerClient({
    account,
    chain: aevum,
    client: publicClient,
    transport: http(AEVUM_BUNDLER),
  });
}

export async function ensureAevum(ethereum: EthereumProvider): Promise<void> {
  const chainId = await ethereum.request({ method: "eth_chainId" });
  if (typeof chainId === "string" && Number.parseInt(chainId, 16) === AEVUM_CHAIN_ID) return;
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xABE5" }],
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) throw error;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0xABE5",
          chainName: "QDay Aevum",
          nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
          rpcUrls: ["https://rpc-test.qday.info"],
          blockExplorerUrls: ["https://explorer-test.qday.info"],
        },
      ],
    });
  }
}

function namedRevert(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("errorName" in data)) return null;
  const name = (data as { errorName?: unknown }).errorName;
  if (typeof name !== "string" || name.length === 0) return null;
  const args = (data as { args?: unknown }).args;
  if (!Array.isArray(args) || args.length === 0) return name;
  const rendered = args.map((arg) => (typeof arg === "bigint" ? arg.toString() : String(arg))).join(", ");
  return `${name}(${rendered})`;
}

function revertDataName(data: unknown): string | null {
  const named = namedRevert(data);
  if (named) return named;
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: managerAbi, data: data as Hex });
    return namedRevert(decoded) ?? decoded.errorName;
  } catch {
    return null;
  }
}

/** Prefer the Solidity custom error. Aevum's RPC text hides it behind "unknown reason". */
export function formatChainError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { data?: unknown; shortMessage?: unknown; details?: unknown; message?: unknown; cause?: unknown };
    const name = revertDataName(record.data);
    if (name) return name;
    if (typeof record.shortMessage === "string") parts.push(record.shortMessage);
    if (typeof record.details === "string" && record.details.trim()) parts.push(record.details.trim());
    current = record.cause;
  }
  if (parts.length === 0) {
    parts.push(error instanceof Error ? error.message : String(error));
  }
  return [...new Set(parts)].join("\n");
}
