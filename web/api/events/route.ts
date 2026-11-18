import { getAddress, isAddress } from "viem";
import { merchantRenewals, merchantSubscriptions, renewalRevert } from "../../src/lib/actions";
import { signWebhookBody, webhookBodiesFor } from "../../src/lib/signedEvents";
import { webhookSignaturesMatch } from "../../src/lib/webhook";
import { webhookSecret } from "../../src/server/secret";

const MAX_BODY = 16_384;
const cache = new Map<string, { at: number; events: { body: string; signature: string; valid: boolean }[] }>();

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const merchantRaw = url.searchParams.get("merchant") ?? "";
  if (!isAddress(merchantRaw)) {
    return Response.json({ error: "Pass the merchant address." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const merchant = getAddress(merchantRaw);
  const hit = cache.get(merchant);
  if (hit && Date.now() - hit.at < 15_000) {
    return Response.json({ events: hit.events }, { headers: { "cache-control": "no-store" } });
  }
  const [subscriptions, renewals] = await Promise.all([
    merchantSubscriptions(merchant),
    merchantRenewals(merchant),
  ]);
  const cancelled = subscriptions.filter((item) => item.sub.cancelled).slice(0, 5);
  const reasons: Record<string, string> = {};
  await Promise.all(
    cancelled.map(async (item) => {
      reasons[item.id] = await renewalRevert(item.id);
    }),
  );
  const secret = await webhookSecret();
  const events = await Promise.all(
    webhookBodiesFor({ merchant, subscriptions, renewals, reasons }).map((event) => signWebhookBody(secret, event)),
  );
  cache.set(merchant, { at: Date.now(), events });
  return Response.json({ events }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return new Response("The body is too large.", { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("The body is too large.", { status: 413 });
  let parsed: { body?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(raw) as { body?: unknown; signature?: unknown };
  } catch {
    return Response.json({ valid: false }, { status: 400 });
  }
  if (typeof parsed.body !== "string" || typeof parsed.signature !== "string") {
    return Response.json({ valid: false }, { status: 400 });
  }
  const valid = await webhookSignaturesMatch(await webhookSecret(), parsed.body, parsed.signature);
  return Response.json({ valid }, { headers: { "cache-control": "no-store" } });
}
