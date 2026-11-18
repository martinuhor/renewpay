import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { renewalRevert, type Renewal, type Subscription } from "./lib/actions";
import { formatTusd } from "./lib/billing";
import { canonicalWebhookBody, type WebhookBody, type WebhookType } from "./lib/webhook";

const LABELS: Record<WebhookType, string> = {
  "subscription.started": "First payment",
  "subscription.renewed": "Renewed",
  "subscription.cancelled": "Cancelled",
  "subscription.paymentFailed": "Renewal stopped",
};

function body(input: WebhookBody): WebhookBody {
  return input;
}

export function Notices({
  merchant,
  subscriptions,
  renewals,
}: {
  merchant: Address | null;
  subscriptions: { id: Hex; sub: Subscription }[];
  renewals: Renewal[];
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    const cancelled = subscriptions.filter((item) => item.sub.cancelled);
    if (cancelled.length === 0) return;
    let stop = false;
    void Promise.all(
      cancelled.map(async (item) => [item.id, await renewalRevert(item.id)] as const),
    )
      .then((rows) => {
        if (!stop) setReasons(Object.fromEntries(rows));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [subscriptions]);

  const events: WebhookBody[] = [];
  for (const item of subscriptions) {
    const shared = {
      merchant: item.sub.merchant,
      subscriber: item.sub.subscriber,
      subscriptionId: item.id,
      paidUntil: item.sub.paidUntil.toString(),
      blockNumber: "",
    };
    events.push(body({
      ...shared,
      id: `chain:${item.id}:started`,
      type: "subscription.started",
      amount: item.sub.amount.toString(),
      reason: "",
      txHash: "",
    }));
    if (item.sub.cancelled) {
      events.push(body({
        ...shared,
        id: `chain:${item.id}:cancelled`,
        type: "subscription.cancelled",
        amount: "",
        reason: "",
        txHash: "",
      }));
      const reason = reasons[item.id];
      if (reason) {
        events.push(body({
          ...shared,
          id: `chain:${item.id}:failed`,
          type: "subscription.paymentFailed",
          amount: "",
          reason,
          txHash: "",
        }));
      }
    }
  }
  for (const item of renewals) {
    const known = subscriptions.find((entry) => entry.id === item.subscriptionId);
    events.push(body({
      id: `chain:${item.txHash}:renewed`,
      type: "subscription.renewed",
      merchant: known?.sub.merchant ?? merchant ?? item.subscriber,
      subscriber: item.subscriber,
      subscriptionId: item.subscriptionId,
      amount: item.amount.toString(),
      paidUntil: item.paidUntil.toString(),
      reason: "",
      txHash: item.txHash,
      blockNumber: "",
    }));
  }

  return (
    <div className="inbox">
      <h3>What the merchant is told</h3>
      <p className="lede">
        The signed feed above is the one a merchant can verify. These cards are the same events, read straight from Aevum in the browser.
      </p>
      {events.length === 0 ? (
        <p className="lede">Nothing to deliver until a plan has a subscriber.</p>
      ) : (
        <div className="list">
          {events.map((event) => (
            <article className="item" key={event.id}>
              <div>{LABELS[event.type]}</div>
              <div className="lede">
                {event.reason || (event.amount ? `${formatTusd(BigInt(event.amount))} tUSD8` : event.subscriptionId)}
              </div>
              <pre className="mono notice-body">{canonicalWebhookBody(event)}</pre>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
