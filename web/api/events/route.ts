import { getAddress, isAddress } from "viem";
import { merchantSignedFeed } from "../../src/lib/feedAuth";
import { recentMerchantActivity } from "../../src/lib/recentFeed";
import { signWebhookBody, webhookBodiesFor } from "../../src/lib/signedEvents";
import { webhookSignaturesMatch } from "../../src/lib/webhook";
import { webhookSecret } from "../../src/server/secret";

const MAX_BODY = 16_384;
const CACHE_MS = 60_000;
const MAX_CACHE = 16;
const MAX_SCANS = 2;

type Signed = { body: string; signature: string; valid: boolean };
const cache = new Map<string, { at: number; events: Signed[] }>();
const inflight = new Map<string, Promise<Signed[]>>();
let scans = 0;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function configuredSecret(): string | Response {
  try {
    return webhookSecret();
  } catch {
    return json({ error: "The signed feed is not configured." }, 503);
  }
}

async function authorized(request: Request, merchant: `0x${string}`): Promise<Response | null> {
  const header = request.headers.get("x-renewpay-feed") ?? "";
  if (!(await merchantSignedFeed(merchant, header))) {
    return json({ error: "The merchant wallet has to sign this feed request." }, 401);
  }
  return null;
}

async function signedEvents(merchant: `0x${string}`, secret: string): Promise<Signed[]> {
  const hit = cache.get(merchant);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;
  const pending = inflight.get(merchant);
  if (pending) return pending;
  if (scans >= MAX_SCANS) throw new Error("busy");
  scans += 1;
  const job = (async () => {
    const { subscriptions, renewals } = await recentMerchantActivity(merchant);
    const events = await Promise.all(
      webhookBodiesFor({ merchant, subscriptions, renewals, reasons: {} }).map((event) => signWebhookBody(secret, event)),
    );
    cache.set(merchant, { at: Date.now(), events });
    while (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      cache.delete(oldest);
    }
    return events;
  })().finally(() => {
    scans -= 1;
    inflight.delete(merchant);
  });
  inflight.set(merchant, job);
  return job;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const merchantRaw = url.searchParams.get("merchant") ?? "";
  if (!isAddress(merchantRaw)) return json({ error: "Pass the merchant address." }, 400);
  const merchant = getAddress(merchantRaw);
  const secret = configuredSecret();
  if (secret instanceof Response) return secret;
  const denied = await authorized(request, merchant);
  if (denied) return denied;
  try {
    return json({ events: await signedEvents(merchant, secret) });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "busy") {
      return json({ error: "The feed is busy. Try again in a minute." }, 429);
    }
    return json({ error: "The signed feed failed." }, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return new Response("The body is too large.", { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("The body is too large.", { status: 413 });
  let parsed: { body?: unknown; signature?: unknown; merchant?: unknown };
  try {
    parsed = JSON.parse(raw) as { body?: unknown; signature?: unknown; merchant?: unknown };
  } catch {
    return json({ valid: false }, 400);
  }
  if (typeof parsed.merchant !== "string" || !isAddress(parsed.merchant)) return json({ valid: false }, 401);
  const merchant = getAddress(parsed.merchant);
  const secret = configuredSecret();
  if (secret instanceof Response) return secret;
  const denied = await authorized(request, merchant);
  if (denied) return denied;
  if (typeof parsed.body !== "string" || typeof parsed.signature !== "string") return json({ valid: false }, 400);
  const valid = await webhookSignaturesMatch(secret, parsed.body, parsed.signature);
  return json({ valid });
}
