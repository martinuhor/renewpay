export const WEBHOOK_TYPES = [
  "subscription.started",
  "subscription.renewed",
  "subscription.cancelled",
  "subscription.paymentFailed",
] as const;

export type WebhookType = (typeof WEBHOOK_TYPES)[number];

/** Same keys, same order, so the HMAC covers one canonical body. */
export type WebhookBody = {
  id: string;
  type: WebhookType;
  merchant: string;
  subscriber: string;
  subscriptionId: string;
  amount: string;
  paidUntil: string;
  reason: string;
  txHash: string;
  blockNumber: string;
};

export function canonicalWebhookBody(input: WebhookBody): string {
  const ordered: WebhookBody = {
    id: input.id,
    type: input.type,
    merchant: input.merchant,
    subscriber: input.subscriber,
    subscriptionId: input.subscriptionId,
    amount: input.amount,
    paidUntil: input.paidUntil,
    reason: input.reason,
    txHash: input.txHash,
    blockNumber: input.blockNumber,
  };
  return JSON.stringify(ordered);
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare for the local inbox token. Empty and mismatched lengths fail. */
export function inboxTokenMatches(expected: string, presented: string): boolean {
  if (expected.length === 0 || expected.length !== presented.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function webhookSignaturesMatch(secret: string, body: string, header: string): Promise<boolean> {
  const expected = await hmacSha256Hex(secret, body);
  const actual = header.trim().toLowerCase().replace(/^0x/, "");
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return mismatch === 0;
}
