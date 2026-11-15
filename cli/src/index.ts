import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  maxUint256,
  parseAbi,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const AEVUM_CHAIN_ID = 44005;
const TUSD8: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
const AEVUM_EXPLORER = "https://explorer-test.qday.info";
const YEAR = 365n * 24n * 60n * 60n;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/latest.json");

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
]);

type Deployment = {
  chainId: number;
  token: Address;
  sessionKeyRegistry: Address;
  subscriptionManager: Address;
  mockToken: boolean;
};

type Plan = {
  merchant: Address;
  amount: bigint;
  periodSeconds: bigint;
  trialSeconds: bigint;
  metadataURI: string;
};

const HELP = `RenewPay week-1 CLI

Reads RPC_URL and DEPLOYER_PRIVATE_KEY from the environment or from ${REPO_ROOT}/.env.
Private keys stay out of the repo. See .env.example.

  deploy
  create-plan --amount <raw> --period-seconds <n> [--trial-seconds <n>] [--metadata <uri>]
  subscribe --plan-id <bytes32> --session-key <address> --cap <raw> [--expiry <unix>]
  renew --subscription-id <bytes32> [--warp-seconds <n>]
  ids --merchant <address> --amount <raw> --period-seconds <n> [--trial-seconds <n>] [--metadata <uri>] --subscriber <address> --session-key <address>

Demo plan: --amount 9990000 (9.99 tUSD8) --period-seconds 2592000 --cap 10000000.
--warp-seconds is local Anvil only. Chain id 44005 refuses it.
On Aevum the settlement token is tUSD8 ${TUSD8}.
`;

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function redact(message: string): string {
  const secrets = ["DEPLOYER_PRIVATE_KEY", "SUBSCRIBER_PRIVATE_KEY", "MERCHANT_PRIVATE_KEY"]
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value));
  let out = message;
  for (const secret of secrets) {
    const withPrefix = secret.startsWith("0x") ? secret : `0x${secret}`;
    out = out.split(withPrefix).join("0x<redacted>");
    out = out.split(withPrefix.slice(2)).join("<redacted>");
  }
  return out;
}

function formatError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { shortMessage?: unknown; metaMessages?: unknown; cause?: unknown };
    if (typeof record.shortMessage === "string") parts.push(record.shortMessage);
    if (Array.isArray(record.metaMessages)) {
      for (const line of record.metaMessages) {
        if (typeof line === "string" && line.trim()) parts.push(line.trim());
      }
    }
    current = record.cause;
  }
  if (parts.length === 0) parts.push(error instanceof Error ? error.message : String(error));
  return redact([...new Set(parts)].join("\n"));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function privateKeyFromEnv(name: string): Hex {
  let raw = requireEnv(name);
  if (!raw.startsWith("0x")) raw = `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 32-byte hex private key.`);
  }
  return raw as Hex;
}

function parseArgs(argv: string[]) {
  const cmd = argv[0];
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) flags.set(key, "true");
    else {
      flags.set(key, next);
      i++;
    }
  }
  return { cmd, flags };
}

function flagBig(flags: Map<string, string>, name: string, fallback?: bigint): bigint {
  const raw = flags.get(name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer`);
  return BigInt(raw);
}

function flagAddress(flags: Map<string, string>, name: string): Address {
  const raw = flags.get(name);
  if (!raw || !isAddress(raw)) throw new Error(`--${name} must be an address`);
  return getAddress(raw);
}

function flagBytes32(flags: Map<string, string>, name: string): Hex {
  const raw = flags.get(name);
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`--${name} must be a bytes32 hex value`);
  return raw as Hex;
}

function planIdFor(
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

function subscriptionIdFor(subscriber: Address, planId: Hex, sessionKey: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "address" }],
      [subscriber, planId, sessionKey],
    ),
  );
}

function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(REPO_ROOT, "out", `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. From the repo root run: forge build`);
  }
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    abi: Abi;
    bytecode: { object: string } | string;
  };
  const raw = typeof json.bytecode === "string" ? json.bytecode : json.bytecode.object;
  if (!raw || raw === "0x") throw new Error(`${name} bytecode is empty. Run forge build.`);
  return { abi: json.abi, bytecode: (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex };
}

function loadDeployment(): Deployment | undefined {
  if (!existsSync(DEPLOYMENT_PATH)) return undefined;
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
}

function chainFor(chainId: number, rpcUrl: string) {
  if (chainId === AEVUM_CHAIN_ID) {
    return defineChain({
      id: chainId,
      name: "QDay Aevum",
      nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      blockExplorers: { default: { name: "Aevum Explorer", url: AEVUM_EXPLORER } },
      testnet: true,
    });
  }
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function connect(keyEnv: string) {
  const rpcUrl = requireEnv("RPC_URL");
  const account = privateKeyToAccount(privateKeyFromEnv(keyEnv));
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const chain = chainFor(chainId, rpcUrl);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const native = await publicClient.getBalance({ address: account.address });
  if (native === 0n) {
    throw new Error(`${account.address} has no native gas balance on chain ${chainId}.`);
  }
  return { rpcUrl, account, chainId, publicClient, wallet };
}

function txUrl(chainId: number, hash: Hex): string {
  return chainId === AEVUM_CHAIN_ID ? `${AEVUM_EXPLORER}/tx/${hash}` : hash;
}

async function send(
  publicClient: PublicClient,
  wallet: WalletClient,
  account: PrivateKeyAccount,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
) {
  const simulation = await publicClient.simulateContract({
    account,
    address,
    abi,
    functionName,
    args,
  });
  const hash = await wallet.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, result: simulation.result, receipt };
}

async function deployContract(
  publicClient: PublicClient,
  wallet: WalletClient,
  account: PrivateKeyAccount,
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await wallet.deployContract({ account, chain: null, abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deploy reverted: ${hash}`);
  }
  console.log(`  tx ${txUrl(await publicClient.getChainId(), hash)}`);
  return receipt.contractAddress;
}

function asPlan(value: unknown): Plan {
  if (Array.isArray(value)) {
    return {
      merchant: value[0] as Address,
      amount: value[1] as bigint,
      periodSeconds: value[2] as bigint,
      trialSeconds: value[3] as bigint,
      metadataURI: value[4] as string,
    };
  }
  const plan = value as Plan;
  return {
    merchant: plan.merchant,
    amount: plan.amount,
    periodSeconds: plan.periodSeconds,
    trialSeconds: plan.trialSeconds,
    metadataURI: plan.metadataURI,
  };
}

async function rpc(rpcUrl: string, method: string, params: unknown[]) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
}

async function warpLocal(rpcUrl: string, chainId: number, seconds: number) {
  if (chainId === AEVUM_CHAIN_ID) {
    throw new Error("--warp-seconds is refused on Aevum (chain id 44005).");
  }
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("--warp-seconds must be a positive integer");
  await rpc(rpcUrl, "evm_increaseTime", [seconds]);
  await rpc(rpcUrl, "evm_mine", []);
  console.log(`warped ${seconds} seconds on chain ${chainId}`);
}

function addresses(chainId: number) {
  const deployment = loadDeployment();
  if (deployment && deployment.chainId !== chainId) {
    throw new Error(
      `deployments/latest.json is chain ${deployment.chainId} but RPC is chain ${chainId}. Deploy again or set the address env vars.`,
    );
  }
  const managerRaw = process.env.SUBSCRIPTION_MANAGER_ADDRESS || deployment?.subscriptionManager;
  const registryRaw = process.env.SESSION_KEY_REGISTRY_ADDRESS || deployment?.sessionKeyRegistry;
  const envToken = process.env.TUSD8_ADDRESS;
  const envTokenIsAevumDefault = Boolean(envToken && isAddress(envToken) && getAddress(envToken) === TUSD8);
  let tokenRaw: string | undefined;
  if (chainId === AEVUM_CHAIN_ID) tokenRaw = TUSD8;
  else if (envToken && !envTokenIsAevumDefault) tokenRaw = envToken;
  else tokenRaw = deployment?.token;
  if (!managerRaw || !isAddress(managerRaw)) {
    throw new Error("Set SUBSCRIPTION_MANAGER_ADDRESS or run deploy.");
  }
  if (!tokenRaw || !isAddress(tokenRaw)) throw new Error("Set TUSD8_ADDRESS or run deploy.");
  return {
    manager: getAddress(managerRaw),
    registry: registryRaw && isAddress(registryRaw) ? getAddress(registryRaw) : undefined,
    token: getAddress(tokenRaw),
  };
}

async function deploy() {
  const { publicClient, wallet, account, chainId } = await connect("DEPLOYER_PRIVATE_KEY");
  console.log(`deployer ${account.address} on chain ${chainId}`);

  let token: Address;
  let mockToken = false;
  if (chainId === AEVUM_CHAIN_ID) {
    const requested = process.env.TUSD8_ADDRESS;
    if (requested && getAddress(requested) !== TUSD8) {
      throw new Error(`On Aevum, TUSD8_ADDRESS must be ${TUSD8}.`);
    }
    const code = await publicClient.getCode({ address: TUSD8 });
    if (!code || code === "0x") throw new Error(`tUSD8 has no code at ${TUSD8} on chain ${chainId}.`);
    token = TUSD8;
  } else if (process.env.TUSD8_ADDRESS && process.env.TUSD8_ADDRESS !== TUSD8) {
    token = getAddress(process.env.TUSD8_ADDRESS);
  } else {
    const mock = loadArtifact("MockTUSD8");
    token = await deployContract(publicClient, wallet, account, mock.abi, mock.bytecode, [6]);
    mockToken = true;
    const mintTo = process.env.SUBSCRIBER_PRIVATE_KEY
      ? privateKeyToAccount(privateKeyFromEnv("SUBSCRIBER_PRIVATE_KEY")).address
      : account.address;
    const minted = 1_000_000n * 10n ** 6n;
    await send(publicClient, wallet, account, token, mock.abi, "mint", [mintTo, minted]);
    console.log(`minted 1000000 mock tUSD8 to ${mintTo}`);
  }

  const decimals = await publicClient.readContract({
    address: token,
    abi: erc20,
    functionName: "decimals",
  });
  if (decimals !== 6) throw new Error(`settlement token decimals are ${decimals}, expected 6`);

  const registryArtifact = loadArtifact("SessionKeyRegistry");
  const registry = await deployContract(publicClient, wallet, account, registryArtifact.abi, registryArtifact.bytecode, []);
  const managerArtifact = loadArtifact("SubscriptionManager");
  const manager = await deployContract(publicClient, wallet, account, managerArtifact.abi, managerArtifact.bytecode, [
    token,
    registry,
  ]);
  await send(publicClient, wallet, account, registry, registryArtifact.abi, "setManager", [manager]);

  const deployment: Deployment = {
    chainId,
    token,
    sessionKeyRegistry: registry,
    subscriptionManager: manager,
    mockToken,
  };
  mkdirSync(dirname(DEPLOYMENT_PATH), { recursive: true });
  writeFileSync(DEPLOYMENT_PATH, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log(`tUSD8 ${token}${mockToken ? " (local mock)" : ""}`);
  console.log(`SessionKeyRegistry ${registry}`);
  console.log(`SubscriptionManager ${manager}`);
  console.log(`wrote ${DEPLOYMENT_PATH}`);
  if (chainId === AEVUM_CHAIN_ID) {
    console.log(`${AEVUM_EXPLORER}/address/${manager}`);
    console.log(`${AEVUM_EXPLORER}/address/${registry}`);
    console.log("Paste these addresses into the README table. They are not committed by this CLI.");
  }
}

async function createPlan(flags: Map<string, string>) {
  const keyEnv = process.env.MERCHANT_PRIVATE_KEY ? "MERCHANT_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY";
  const { publicClient, wallet, account, chainId } = await connect(keyEnv);
  const { manager } = addresses(chainId);
  const amount = flagBig(flags, "amount");
  const periodSeconds = flagBig(flags, "period-seconds");
  const trialSeconds = flagBig(flags, "trial-seconds", 0n);
  const metadata = flags.get("metadata") ?? "";
  const localId = planIdFor(account.address, amount, periodSeconds, trialSeconds, metadata);
  const abi = loadArtifact("SubscriptionManager").abi;
  const { hash, result } = await send(publicClient, wallet, account, manager, abi, "createPlan", [
    amount,
    periodSeconds,
    trialSeconds,
    metadata,
  ]);
  const planId = result as Hex;
  if (planId.toLowerCase() !== localId.toLowerCase()) {
    throw new Error(`plan id mismatch. chain ${planId} local ${localId}`);
  }
  console.log(`planId ${planId}`);
  console.log(`merchant ${account.address}`);
  console.log(`tx ${txUrl(chainId, hash)}`);
}

async function subscribe(flags: Map<string, string>) {
  const { publicClient, wallet, account, chainId } = await connect("SUBSCRIBER_PRIVATE_KEY");
  const { manager, token } = addresses(chainId);
  const planId = flagBytes32(flags, "plan-id");
  const sessionKey = flagAddress(flags, "session-key");
  const cap = flagBig(flags, "cap");
  const abi = loadArtifact("SubscriptionManager").abi;
  const plan = asPlan(
    await publicClient.readContract({ address: manager, abi, functionName: "getPlan", args: [planId] }),
  );
  const now = (await publicClient.getBlock()).timestamp;
  const expiry = flagBig(flags, "expiry", now + YEAR);
  if (expiry <= now) throw new Error("--expiry must be in the future");
  if (plan.periodSeconds === 0n) throw new Error("plan period is zero");
  const periods = (expiry - now + plan.periodSeconds - 1n) / plan.periodSeconds;
  if (periods === 0n) throw new Error("expiry does not cover a billing period");
  if (cap > 0n && periods > (maxUint256 - 1n) / cap) {
    throw new Error("refusing to approve: cap times periods overflows");
  }
  const allowance = cap * periods;
  if (allowance === 0n || allowance >= maxUint256) {
    throw new Error("refusing to approve an unlimited allowance");
  }

  const approveTx = await send(publicClient, wallet, account, token, erc20, "approve", [manager, allowance]);
  console.log(`approved ${allowance} (finite) tx ${txUrl(chainId, approveTx.hash)}`);

  const localSub = subscriptionIdFor(account.address, planId, sessionKey);
  const { hash, result } = await send(publicClient, wallet, account, manager, abi, "subscribe", [
    planId,
    sessionKey,
    cap,
    expiry,
  ]);
  const subscriptionId = result as Hex;
  if (subscriptionId.toLowerCase() !== localSub.toLowerCase()) {
    throw new Error(`subscription id mismatch. chain ${subscriptionId} local ${localSub}`);
  }
  const [subscriberBal, merchantBal] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [plan.merchant] }),
  ]);
  console.log(`subscriptionId ${subscriptionId}`);
  console.log(`sessionKey ${sessionKey}`);
  console.log(`expiry ${expiry}`);
  console.log(`subscriberBalance ${subscriberBal}`);
  console.log(`merchantBalance ${merchantBal}`);
  console.log(`tx ${txUrl(chainId, hash)}`);
}

async function renew(flags: Map<string, string>) {
  const { rpcUrl, publicClient, wallet, account, chainId } = await connect("DEPLOYER_PRIVATE_KEY");
  const { manager, token } = addresses(chainId);
  if (flags.has("warp-seconds")) {
    await warpLocal(rpcUrl, chainId, Number(flags.get("warp-seconds")));
  }
  const subscriptionId = flagBytes32(flags, "subscription-id");
  const abi = loadArtifact("SubscriptionManager").abi;
  const { hash } = await send(publicClient, wallet, account, manager, abi, "renewSubscription", [subscriptionId]);
  const sub = await publicClient.readContract({
    address: manager,
    abi,
    functionName: "getSubscription",
    args: [subscriptionId],
  });
  const record = (Array.isArray(sub) ? { subscriber: sub[0], merchant: sub[1], paidUntil: sub[8] } : sub) as {
    subscriber: Address;
    merchant: Address;
    paidUntil: bigint;
  };
  const [subscriberBal, merchantBal] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [record.subscriber] }),
    publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [record.merchant] }),
  ]);
  console.log(`renewed ${subscriptionId}`);
  console.log(`paidUntil ${record.paidUntil}`);
  console.log(`subscriberBalance ${subscriberBal}`);
  console.log(`merchantBalance ${merchantBal}`);
  console.log(`tx ${txUrl(chainId, hash)}`);
}

function ids(flags: Map<string, string>) {
  const merchant = flagAddress(flags, "merchant");
  const subscriber = flagAddress(flags, "subscriber");
  const sessionKey = flagAddress(flags, "session-key");
  const amount = flagBig(flags, "amount");
  const periodSeconds = flagBig(flags, "period-seconds");
  const trialSeconds = flagBig(flags, "trial-seconds", 0n);
  const metadata = flags.get("metadata") ?? "";
  const planId = planIdFor(merchant, amount, periodSeconds, trialSeconds, metadata);
  console.log(`planId ${planId}`);
  console.log(`subscriptionId ${subscriptionIdFor(subscriber, planId, sessionKey)}`);
}

async function main() {
  loadEnvFile(resolve(REPO_ROOT, ".env"));
  loadEnvFile(resolve(process.cwd(), ".env"));
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === "help" || flags.has("help")) {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "deploy") await deploy();
  else if (cmd === "create-plan") await createPlan(flags);
  else if (cmd === "subscribe") await subscribe(flags);
  else if (cmd === "renew") await renew(flags);
  else if (cmd === "ids") ids(flags);
  else throw new Error(`Unknown command ${cmd}`);
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});
