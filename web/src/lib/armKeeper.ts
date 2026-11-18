import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletClientFor } from "./account";
import { readSubscription } from "./actions";
import { AEVUM_CHAIN_ID, EXECUTE_SELECTOR } from "./chain";
import type { KeeperFile } from "./keeperCall";
import { requirePaymaster, savedPolicy, sessionSigner, sessionPermissionEnabled, kernelEnableNonce, enableDataFor, permissionIdFor, validationIdFor } from "./sponsorship";

export async function buildKeeperFile(input: {
  ethereum: EthereumProvider;
  owner: Address;
  subscriptionId: Hex;
}): Promise<KeeperFile> {
  const signer = sessionSigner();
  const policy = savedPolicy();
  const paymaster = requirePaymaster();
  if (!policy) throw new Error("Deploy the renew policy before arming the keeper.");
  const subscription = await readSubscription(input.subscriptionId);
  if (!subscription.exists || subscription.cancelled) throw new Error("Subscribe before arming the keeper.");
  if (getAddress(subscription.sessionKey) !== getAddress(signer.address)) {
    throw new Error("This browser does not hold that session key. Subscribe again with the key shown here.");
  }
  const subscriber = getAddress(subscription.subscriber);
  const enabled = await sessionPermissionEnabled(subscriber, policy, signer.address);
  let enableSignature: Hex | null = null;
  let enableNonce: number | null = null;
  if (!enabled) {
    enableNonce = await kernelEnableNonce(subscriber);
    const validatorData = enableDataFor(policy, signer.address);
    const wallet = walletClientFor(input.ethereum, input.owner);
    enableSignature = await wallet.signTypedData({
      account: input.owner,
      domain: { name: "Kernel", version: "0.3.1", chainId: AEVUM_CHAIN_ID, verifyingContract: subscriber },
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
        validationId: validationIdFor(permissionIdFor(policy, signer.address)),
        nonce: enableNonce,
        hook: zeroAddress,
        validatorData,
        hookData: "0x",
        selectorData: EXECUTE_SELECTOR,
      },
    });
  }
  return {
    version: 1,
    subscriber,
    subscriptionId: input.subscriptionId,
    sessionPrivateKey: signer.privateKey,
    paymaster,
    policy,
    enableSignature,
    enableNonce,
  };
}

export function downloadKeeperFile(file: KeeperFile): void {
  const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "session.json";
  link.click();
  URL.revokeObjectURL(url);
}

export function keeperFileMatchesSession(file: KeeperFile): boolean {
  return getAddress(privateKeyToAccount(file.sessionPrivateKey).address) === getAddress(sessionSigner().address);
}
