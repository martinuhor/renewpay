import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { walletClientFor } from "./lib/account";
import { formatChainError } from "./lib/actions";
import { feedHeader, feedMessage } from "./lib/feedAuth";

type Signed = { body: string; signature: string; valid: boolean };
type Grant = { merchant: Address; expires: number; signature: Hex };

const GRANT_KEY = "renewpay.feedAuth";

function loadGrant(merchant: Address): Grant | null {
  try {
    const raw = sessionStorage.getItem(GRANT_KEY);
    if (!raw) return null;
    const grant = JSON.parse(raw) as Grant;
    if (grant.merchant !== merchant) return null;
    if (grant.expires < Math.floor(Date.now() / 1000) + 15) return null;
    return grant;
  } catch {
    return null;
  }
}

export function SignedFeed({ ethereum, merchant }: { ethereum?: EthereumProvider; merchant: Address | null }) {
  const [events, setEvents] = useState<Signed[]>([]);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const endpoint = merchant ? `${window.location.origin}/api/events?merchant=${merchant}` : "";

  useEffect(() => {
    setGrant(merchant ? loadGrant(merchant) : null);
  }, [merchant]);

  useEffect(() => {
    if (!merchant || !grant) return;
    let stop = false;
    const header = feedHeader(grant.expires, grant.signature);
    async function load() {
      const response = await fetch(`/api/events?merchant=${merchant}`, { headers: { "x-renewpay-feed": header } });
      const payload = (await response.json()) as { events?: Signed[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The signed feed did not answer.");
      if (stop) return;
      const next = payload.events ?? [];
      setEvents(next);
      setError(null);
      const confirmed: Record<string, boolean> = {};
      for (const event of next.slice(0, 4)) {
        const check = await fetch(`/api/events?merchant=${merchant}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-renewpay-feed": header },
          body: JSON.stringify({ merchant, body: event.body, signature: event.signature }),
        });
        const result = (await check.json()) as { valid?: boolean };
        confirmed[event.signature] = result.valid === true;
      }
      if (!stop) setChecks(confirmed);
    }
    void load().catch((cause: unknown) => {
      if (stop) return;
      setError(cause instanceof Error ? cause.message : "The signed feed did not answer.");
      if (cause instanceof Error && cause.message.includes("sign")) {
        sessionStorage.removeItem(GRANT_KEY);
        setGrant(null);
      }
    });
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 20_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [merchant, grant]);

  async function signFeed() {
    if (!ethereum || !merchant) return;
    setError(null);
    try {
      const expires = Math.floor(Date.now() / 1000) + 10 * 60;
      const signature = await walletClientFor(ethereum, merchant).signMessage({
        account: merchant,
        message: feedMessage(merchant, expires),
      });
      const next = { merchant, expires, signature };
      sessionStorage.setItem(GRANT_KEY, JSON.stringify(next));
      setGrant(next);
    } catch (cause) {
      setError(formatChainError(cause));
    }
  }

  return (
    <div className="inbox">
      <h3>Signed events</h3>
      <p className="lede">
        The feed covers recent chain history. The merchant wallet signs the request. The HMAC secret stays on the server, and a second request checks the signature.
      </p>
      {endpoint ? <p className="mono">{endpoint}</p> : <p className="lede">Connect the merchant wallet to load the feed.</p>}
      {merchant && !grant ? (
        <button className="ghost" type="button" disabled={!ethereum} onClick={() => void signFeed()}>
          Sign to load signed events
        </button>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {merchant && grant && events.length === 0 && !error ? <p className="lede">The feed is open. A signed event from the recent window appears here after subscribe.</p> : null}
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
