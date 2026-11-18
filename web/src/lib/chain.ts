import { defineChain, getAddress, type Address } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

export const AEVUM_CHAIN_ID = 44005;
export const AEVUM_RPC = "https://rpc-test.qday.info";
export const AEVUM_BUNDLER = "https://bundler.qday.info";
export const AEVUM_EXPLORER = "https://explorer-test.qday.info";

/** Block that created SubscriptionManager. Log scans start here. */
export const DEPLOY_BLOCK = 3_407_013n;

export const TUSD8_DECIMALS = 6;

export const TUSD8 = getAddress("0x456569838f1d43009A91ebA4263147Afd7233483");
export const SUBSCRIPTION_MANAGER = getAddress("0x51202A87aFdc07085e9586bc5E30a81a8cC4ff13");
export const SESSION_KEY_REGISTRY = getAddress("0x5fB5817ABb539C8628b45c0C0eC95797D2C85F26");

/** Canonical ERC-4337 EntryPoint v0.7. The Aevum bundler returns this address. */
export const ENTRY_POINT = getAddress(entryPoint07Address);

/**
 * QDay stablecoin paymaster. `asset()` is tUSD8, but validation only accepts a
 * plain tUSD8 transfer or a call to 0xf45e7f39caba1d2055f613970575a7e7069636be.
 * It reverts on SubscriptionManager, so this checkout does not name it.
 */
export const STABLECOIN_PAYMASTER = getAddress("0x8DdF5E51c470257642e2c17E43977901b1173eFa");

/**
 * Kernel v3.1 contracts that are already on Aevum.
 * The usual ZeroDev meta factory (0xd703aaE79538628d27099B8c4f621bE4CCd142d5)
 * has no code here. UserOperations go through the meta factory below, which
 * approves the Kernel v3.1 factory.
 */
export const KERNEL_FACTORY = getAddress("0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419");
export const KERNEL_META_FACTORY = getAddress("0x007cb4a07296b53ea5e53d043888230797b8fd01");
export const KERNEL_ECDSA_VALIDATOR = getAddress("0x845ADb2C711129d4f3966735eD98a9F09fC4cE57");

/** Gas the subscriber paymaster may spend while it checks the call and pulls its fee. */
export const PAYMASTER_VERIFICATION_GAS = 300_000n;
export const PAYMASTER_POST_OP_GAS = 200_000n;

/** Fixed UserOperation gas. Enable-mode installs the session key during validation. */
export const USEROP_CALL_GAS = 700_000n;
export const USEROP_VERIFICATION_GAS = 1_000_000n;
export const USEROP_PRE_VERIFICATION_GAS = 150_000n;

/** Kernel v3.1 `execute` selector. The session key is allowed to call only this. */
export const EXECUTE_SELECTOR = "0xe9ae5c53" as const;

/** Already on Aevum. Session keys sign through this module. One owner per permission id. */
export const ECDSA_SIGNER = getAddress("0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF");

/** Flat tUSD8 the paymaster pulls after a sponsored UserOperation. 10000 = 0.01 tUSD8. */
export const SPONSOR_FEE = 10_000n;

/**
 * Finite tUSD8 the subscriber approves to the paymaster.
 * Live charges on Aevum have been a few hundred base units (under 0.001 tUSD8).
 * 0.1 tUSD8 leaves headroom and is not `type(uint256).max`.
 */
export const PAYMASTER_GAS_ALLOWANCE = 100_000n;

/** The only faucet-funded account. It holds the demo's tUSD8 and the tQDAY for the two wallet transactions. */
export const DEMO_MERCHANT = getAddress("0xCDB8793ec57DcdcC432CA083792dE9fb78d46750");

export const DEMO_AMOUNT = 1_000_000n;
export const DEMO_CAP = 2_000_000n;
export const DEMO_PERIOD_SECONDS = 2_592_000n;
export const DEMO_SHORT_PERIOD_SECONDS = 120n;
export const DEMO_TRIAL_SECONDS = 0n;
export const DEMO_METADATA = "Pro Plan — 1 tUSD8 / period";
export const DEMO_FUND = 3_000_000n;
/** EntryPoint deposit for deploying the subscriber account and paying its UserOperations. */
export const DEMO_GAS_DEPOSIT = 50_000_000_000_000_000n;
export const YEAR_SECONDS = 365n * 24n * 60n * 60n;

export const aevum = defineChain({
  id: AEVUM_CHAIN_ID,
  name: "QDay Aevum",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [AEVUM_RPC] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: AEVUM_EXPLORER } },
  testnet: true,
});

export function explorerAddress(address: Address): string {
  return `${AEVUM_EXPLORER}/address/${address}`;
}

export function explorerTx(hash: string): string {
  return `${AEVUM_EXPLORER}/tx/${hash}`;
}
