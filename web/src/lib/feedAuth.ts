import { getAddress, isHex, recoverMessageAddress, type Address, type Hex } from "viem";

const MAX_AHEAD_SECONDS = 15 * 60;
const MAX_BEHIND_SECONDS = 30;

export function feedMessage(merchant: Address, expires: number): string {
  return `RenewPay signed feed\n${getAddress(merchant)}\n${expires}`;
}

export function feedHeader(expires: number, signature: Hex): string {
  return `${expires}.${signature}`;
}

/** The merchant wallet must have signed this request. A bad header never reaches the chain. */
export async function merchantSignedFeed(merchant: Address, header: string): Promise<boolean> {
  const split = header.indexOf(".");
  if (split <= 0) return false;
  const expires = Number(header.slice(0, split));
  const signature = header.slice(split + 1);
  if (!Number.isInteger(expires) || !isHex(signature) || signature.length < 132) return false;
  const now = Math.floor(Date.now() / 1000);
  if (expires < now - MAX_BEHIND_SECONDS || expires > now + MAX_AHEAD_SECONDS) return false;
  try {
    const signer = await recoverMessageAddress({ message: feedMessage(merchant, expires), signature });
    return getAddress(signer) === getAddress(merchant);
  } catch {
    return false;
  }
}
