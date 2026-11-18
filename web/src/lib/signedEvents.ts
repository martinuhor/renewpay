import type { Address, Hex } from "viem";
import { canonicalWebhookBody, hmacSha256Hex, webhookSignaturesMatch, type WebhookBody } from "./webhook";
import type { Renewal, Subscription } from "./actions";

export type SignedEvent = { body: string; signature: string; valid: boolean };

export async function signWebhookBody(secret: string, event: WebhookBody): Promise<SignedEvent> {
  const body = canonicalWebhookBody(event);
  const signature = await hmacSha256Hex(secret, body);
  const valid = await webhookSignaturesMatch(secret, body, signature);
  return { body, signature, valid };
}

export function webhookBodiesFor(input: {
  merchant: Address;
  subscriptions: { id: Hex; sub: Subscription }[];
  renewals: Renewal[];
  reasons: Record<string, string>;
}): WebhookBody[] {
  const events: WebhookBody[] = [];
  for (const item of input.subscriptions) {
    const shared = {
      merchant: item.sub.merchant,
      subscriber: item.sub.subscriber,
      subscriptionId: item.id,
      paidUntil: item.sub.paidUntil.toString(),
      blockNumber: "",
    };
    events.push({
      ...shared,
      id: `chain:${item.id}:started`,
      type: "subscription.started",
      amount: item.sub.amount.toString(),
      reason: "",
      txHash: "",
    });
    if (item.sub.cancelled) {
      events.push({
        ...shared,
        id: `chain:${item.id}:cancelled`,
        type: "subscription.cancelled",
        amount: "",
        reason: "",
        txHash: "",
      });
      const reason = input.reasons[item.id];
      if (reason) {
        events.push({
          ...shared,
          id: `chain:${item.id}:failed`,
          type: "subscription.paymentFailed",
          amount: "",
          reason,
          txHash: "",
        });
      }
    }
  }
  for (const item of input.renewals) {
    const known = input.subscriptions.find((entry) => entry.id === item.subscriptionId);
    events.push({
      id: `chain:${item.txHash}:renewed`,
      type: "subscription.renewed",
      merchant: known?.sub.merchant ?? input.merchant,
      subscriber: item.subscriber,
      subscriptionId: item.subscriptionId,
      amount: item.amount.toString(),
      paidUntil: item.paidUntil.toString(),
      reason: "",
      txHash: item.txHash,
      blockNumber: "",
    });
  }
  return events;
}
