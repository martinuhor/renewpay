import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { WebhookBody } from "./lib/webhook";

type InboxEvent = {
  type: string;
  signature: string;
  receivedAt: string;
  verified: boolean;
  payload: WebhookBody;
};

const LABELS: Record<string, string> = {
  "subscription.started": "First payment",
  "subscription.renewed": "Renewed",
  "subscription.cancelled": "Cancelled",
  "subscription.paymentFailed": "Renewal stopped",
};

function isLocalCheckout(): boolean {
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost";
}

export function Inbox({ merchant }: { merchant: Address | null }) {
  const localInbox = isLocalCheckout();
  const [events, setEvents] = useState<InboxEvent[] | null>(null);
  const [offline, setOffline] = useState(!localInbox);

  useEffect(() => {
    if (!localInbox) return;
    let stop = false;
    async function poll() {
      try {
        const query = merchant ? `?merchant=${merchant}` : "";
        const response = await fetch(`/inbox${query}`);
        if (!response.ok) throw new Error("Inbox unavailable.");
        const body = (await response.json()) as { events: InboxEvent[] };
        if (!stop) {
          setEvents(body.events);
          setOffline(false);
        }
      } catch {
        if (!stop) setOffline(true);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [localInbox, merchant]);

  return (
    <div className="inbox">
      <h3>Signed webhook inbox</h3>
      {!localInbox ? (
        <p className="lede">
          The chain lists above are enough for the demo clicks. The signed inbox stays on your machine. Run <code>cd web && npm run webhook</code>, then open the checkout with <code>npm run dev</code>. This page does not call it.
        </p>
      ) : offline || events === null ? (
        <p className="lede">
          Inbox is not running. Start it with <code>cd web && npm run webhook</code> in another terminal.
        </p>
      ) : events.length === 0 ? (
        <p className="lede">Inbox is up. Deliveries show up here after subscribe, renew, and cancel.</p>
      ) : (
        <div className="list">
          {events.map((event) => (
            <article className="item" key={event.payload.id}>
              <div>{LABELS[event.type] ?? event.type}</div>
              <div className="lede">{event.payload.reason || event.payload.amount || event.payload.subscriptionId}</div>
              <div className="note">{event.verified ? "HMAC-SHA256 verified" : "Unverified"} · {event.signature.slice(0, 16)}…</div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
