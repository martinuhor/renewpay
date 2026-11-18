import { useEffect, useState } from "react";
import type { Address } from "viem";

type Signed = { body: string; signature: string; valid: boolean };

export function SignedFeed({ merchant }: { merchant: Address | null }) {
  const [events, setEvents] = useState<Signed[]>([]);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const endpoint = merchant ? `${window.location.origin}/api/events?merchant=${merchant}` : "";

  useEffect(() => {
    if (!merchant) return;
    let stop = false;
    async function load() {
      const response = await fetch(`/api/events?merchant=${merchant}`);
      if (!response.ok) throw new Error("The signed feed did not answer.");
      const payload = (await response.json()) as { events?: Signed[] };
      if (stop) return;
      const next = payload.events ?? [];
      setEvents(next);
      setError(null);
      const confirmed: Record<string, boolean> = {};
      for (const event of next.slice(0, 4)) {
        const check = await fetch("/api/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: event.body, signature: event.signature }),
        });
        const result = (await check.json()) as { valid?: boolean };
        confirmed[event.signature] = result.valid === true;
      }
      if (!stop) setChecks(confirmed);
    }
    void load().catch((cause: unknown) => {
      if (!stop) setError(cause instanceof Error ? cause.message : "The signed feed did not answer.");
    });
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 20_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [merchant]);

  return (
    <div className="inbox">
      <h3>Signed events</h3>
      <p className="lede">
        These bodies come from the public feed on this site. The HMAC secret stays on the server. A second request checks the signature and does not receive the secret.
      </p>
      {endpoint ? <p className="mono">{endpoint}</p> : <p className="lede">Connect the merchant wallet to load the feed.</p>}
      {error ? <p className="error">{error}</p> : null}
      {merchant && events.length === 0 && !error ? <p className="lede">The feed is up. A signed event appears here after subscribe.</p> : null}
      <div className="list">
        {events.slice(0, 6).map((event) => (
          <article className="item" key={event.signature}>
            <div>{checks[event.signature] ? "Signature matches" : "Checking the signature"}</div>
            <pre className="mono notice-body">{event.body}</pre>
            <div className="mono">x-qday-signature {event.signature}</div>
          </article>
        ))}
      </div>
    </div>
  );
}
