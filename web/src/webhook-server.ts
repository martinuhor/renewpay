/**
 * Local signed webhook inbox for the RenewPay demo.
 * It reads public logs and simulates renewals. It never holds a private key
 * and it never sends a transaction.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "./lib/account";
import { managerAbi } from "./lib/abi";
import { DEPLOY_BLOCK, SUBSCRIPTION_MANAGER } from "./lib/chain";
import { logWindows } from "./lib/logs";
import {
  canonicalWebhookBody,
  hmacSha256Hex,
  inboxTokenMatches,
  webhookSignaturesMatch,
  type WebhookBody,
  type WebhookType,
} from "./lib/webhook";

const PORT = 8787;
const MAX_BODY_BYTES = 16_384;
const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".webhook");
mkdirSync(dataDir, { recursive: true });

function loadSecret(): string {
  const path = join(dataDir, "secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First run creates the HMAC secret. It stays on this machine.
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

const secret = loadSecret();
const db = new DatabaseSync(join(dataDir, "inbox.sqlite"));
db.exec(`
  create table if not exists events (
    id text primary key,
    merchant text not null,
    type text not null,
    body text not null,
    signature text not null,
    received_at text not null
  );
  create table if not exists subscriptions (
    id text primary key,
    merchant text not null,
    subscriber text not null,
    paid_until text not null,
    cancelled integer not null
  );
  create table if not exists meta (key text primary key, value text not null);
`);

const subscribed = parseAbiItem(
  "event Subscribed(bytes32 indexed subscriptionId, bytes32 indexed planId, address indexed subscriber, address sessionKey, uint256 spendingCapPerPeriod, uint256 expiry, uint256 charged, uint256 paidUntil)",
);
const renewed = parseAbiItem(
  "event SubscriptionRenewed(bytes32 indexed subscriptionId, address indexed subscriber, address indexed merchant, uint256 amount, uint256 paidUntil)",
);
const cancelled = parseAbiItem(
  "event SubscriptionCancelled(bytes32 indexed subscriptionId, address indexed subscriber)",
);

type Tracked = { id: Hex; merchant: Address; subscriber: Address; paidUntil: bigint; cancelled: boolean };

function remembered(): Map<string, Tracked> {
  const rows = db.prepare("select id, merchant, subscriber, paid_until, cancelled from subscriptions").all() as {
    id: string;
    merchant: string;
    subscriber: string;
    paid_until: string;
    cancelled: number;
  }[];
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id as Hex,
        merchant: getAddress(row.merchant),
        subscriber: getAddress(row.subscriber),
        paidUntil: BigInt(row.paid_until),
        cancelled: row.cancelled === 1,
      },
    ]),
  );
}

function saveSubscription(sub: Tracked): void {
  db.prepare(
    `insert into subscriptions (id, merchant, subscriber, paid_until, cancelled)
     values (?, ?, ?, ?, ?)
     on conflict(id) do update set merchant = excluded.merchant, subscriber = excluded.subscriber,
       paid_until = excluded.paid_until, cancelled = excluded.cancelled`,
  ).run(sub.id, sub.merchant, sub.subscriber, sub.paidUntil.toString(), sub.cancelled ? 1 : 0);
}

function cursor(): bigint {
  const row = db.prepare("select value from meta where key = 'block'").get() as { value: string } | undefined;
  return row ? BigInt(row.value) : DEPLOY_BLOCK - 1n;
}

function saveCursor(block: bigint): void {
  db.prepare("insert into meta (key, value) values ('block', ?) on conflict(key) do update set value = excluded.value").run(block.toString());
}

function seen(id: string): boolean {
  return Boolean(db.prepare("select id from events where id = ?").get(id));
}

function bodyFor(input: WebhookBody): WebhookBody {
  return input;
}

async function postHook(payload: WebhookBody): Promise<void> {
  if (seen(payload.id)) return;
  const raw = canonicalWebhookBody(payload);
  const signature = await hmacSha256Hex(secret, raw);
  const response = await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-qday-signature": signature },
    body: raw,
  });
  if (!response.ok) throw new Error(`Inbox rejected ${payload.id} (${response.status}).`);
}

function revertName(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((item) => item instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? "Reverted";
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : "Reverted";
}

async function scan(): Promise<void> {
  const latest = await publicClient.getBlockNumber();
  const from = cursor() + 1n;
  const tracked = remembered();
  if (from <= latest) {
    const windows = logWindows(from, latest);
    const collected: { kind: WebhookType; blockNumber: bigint; logIndex: number; payload: WebhookBody; track?: Tracked }[] = [];
    for (let index = 0; index < windows.length; index += 4) {
      const batch = windows.slice(index, index + 4);
      const [started, renewedLogs, cancelledLogs] = await Promise.all([
        Promise.all(batch.map((window) => publicClient.getLogs({ address: SUBSCRIPTION_MANAGER, event: subscribed, fromBlock: window.fromBlock, toBlock: window.toBlock }))),
        Promise.all(batch.map((window) => publicClient.getLogs({ address: SUBSCRIPTION_MANAGER, event: renewed, fromBlock: window.fromBlock, toBlock: window.toBlock }))),
        Promise.all(batch.map((window) => publicClient.getLogs({ address: SUBSCRIPTION_MANAGER, event: cancelled, fromBlock: window.fromBlock, toBlock: window.toBlock }))),
      ]);
      for (const log of started.flat()) {
        const subscriptionId = log.args.subscriptionId;
        const subscriber = log.args.subscriber;
        if (!subscriptionId || !subscriber) continue;
        const onChain = await publicClient.readContract({
          address: SUBSCRIPTION_MANAGER,
          abi: managerAbi,
          functionName: "getSubscription",
          args: [subscriptionId],
        });
        const merchant = getAddress(onChain.merchant);
        const track: Tracked = {
          id: subscriptionId,
          merchant,
          subscriber: getAddress(subscriber),
          paidUntil: onChain.paidUntil,
          cancelled: onChain.cancelled,
        };
        tracked.set(subscriptionId, track);
        collected.push({
          kind: "subscription.started",
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          track,
          payload: bodyFor({
            id: `${log.transactionHash}:${log.logIndex}`,
            type: "subscription.started",
            merchant,
            subscriber: track.subscriber,
            subscriptionId,
            amount: (log.args.charged ?? 0n).toString(),
            paidUntil: (log.args.paidUntil ?? 0n).toString(),
            reason: "",
            txHash: log.transactionHash ?? "",
            blockNumber: (log.blockNumber ?? 0n).toString(),
          }),
        });
      }
      for (const log of renewedLogs.flat()) {
        const subscriptionId = log.args.subscriptionId;
        const merchant = log.args.merchant ? getAddress(log.args.merchant) : undefined;
        const subscriber = log.args.subscriber ? getAddress(log.args.subscriber) : undefined;
        if (!subscriptionId || !merchant || !subscriber) continue;
        const track = tracked.get(subscriptionId) ?? {
          id: subscriptionId,
          merchant,
          subscriber,
          paidUntil: log.args.paidUntil ?? 0n,
          cancelled: false,
        };
        track.paidUntil = log.args.paidUntil ?? track.paidUntil;
        tracked.set(subscriptionId, track);
        collected.push({
          kind: "subscription.renewed",
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          track,
          payload: bodyFor({
            id: `${log.transactionHash}:${log.logIndex}`,
            type: "subscription.renewed",
            merchant,
            subscriber,
            subscriptionId,
            amount: (log.args.amount ?? 0n).toString(),
            paidUntil: (log.args.paidUntil ?? 0n).toString(),
            reason: "",
            txHash: log.transactionHash ?? "",
            blockNumber: (log.blockNumber ?? 0n).toString(),
          }),
        });
      }
      for (const log of cancelledLogs.flat()) {
        const subscriptionId = log.args.subscriptionId;
        const subscriber = log.args.subscriber ? getAddress(log.args.subscriber) : undefined;
        if (!subscriptionId || !subscriber) continue;
        const known = tracked.get(subscriptionId);
        const merchant = known?.merchant ?? getAddress(
          (await publicClient.readContract({
            address: SUBSCRIPTION_MANAGER,
            abi: managerAbi,
            functionName: "getSubscription",
            args: [subscriptionId],
          })).merchant,
        );
        const track: Tracked = {
          id: subscriptionId,
          merchant,
          subscriber,
          paidUntil: known?.paidUntil ?? 0n,
          cancelled: true,
        };
        tracked.set(subscriptionId, track);
        collected.push({
          kind: "subscription.cancelled",
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          track,
          payload: bodyFor({
            id: `${log.transactionHash}:${log.logIndex}`,
            type: "subscription.cancelled",
            merchant,
            subscriber,
            subscriptionId,
            amount: "",
            paidUntil: track.paidUntil.toString(),
            reason: "",
            txHash: log.transactionHash ?? "",
            blockNumber: (log.blockNumber ?? 0n).toString(),
          }),
        });
      }
    }
    collected.sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
      return left.logIndex - right.logIndex;
    });
    for (const item of collected) {
      if (item.track) saveSubscription(item.track);
      await postHook(item.payload);
    }
    saveCursor(latest);
  }

  const now = (await publicClient.getBlock()).timestamp;
  for (const sub of tracked.values()) {
    if (!sub.cancelled && now < sub.paidUntil) continue;
    const id = `fail:${sub.id}:${sub.cancelled ? "cancelled" : "due"}`;
    if (seen(id)) continue;
    try {
      await publicClient.simulateContract({
        address: SUBSCRIPTION_MANAGER,
        abi: managerAbi,
        functionName: "renewSubscription",
        args: [sub.id],
      });
    } catch (cause) {
      const reason = revertName(cause);
      if (reason === "PeriodNotDue") continue;
      await postHook({
        id,
        type: "subscription.paymentFailed",
        merchant: sub.merchant,
        subscriber: sub.subscriber,
        subscriptionId: sub.id,
        amount: "",
        paidUntil: sub.paidUntil.toString(),
        reason,
        txHash: "",
        blockNumber: latest.toString(),
      });
    }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        request.pause();
        reject(new Error("Body too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function inboxAuthorized(request: IncomingMessage): boolean {
  const header = request.headers["x-renewpay-inbox"];
  const presented = Array.isArray(header) ? header[0] ?? "" : header ?? "";
  return inboxTokenMatches(secret, presented);
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/hook") {
    let raw: string;
    try {
      raw = await readBody(request);
    } catch {
      send(response, 413, { ok: false, error: "Body too large." });
      request.destroy();
      return;
    }
    const header = request.headers["x-qday-signature"];
    const signature = Array.isArray(header) ? header[0] : header ?? "";
    if (!(await webhookSignaturesMatch(secret, raw, signature))) {
      send(response, 401, { ok: false, error: "Bad signature." });
      return;
    }
    const payload = JSON.parse(raw) as WebhookBody;
    db.prepare(
      "insert into events (id, merchant, type, body, signature, received_at) values (?, ?, ?, ?, ?, ?) on conflict(id) do nothing",
    ).run(payload.id, payload.merchant, payload.type, raw, signature, new Date().toISOString());
    send(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/inbox") {
    if (!inboxAuthorized(request)) {
      send(response, 401, { ok: false, error: "Inbox token required." });
      return;
    }
    const merchant = url.searchParams.get("merchant");
    const rows = (merchant
      ? db.prepare("select type, body, signature, received_at from events where lower(merchant) = lower(?) order by received_at desc limit 40").all(merchant)
      : db.prepare("select type, body, signature, received_at from events order by received_at desc limit 40").all()) as {
      type: string;
      body: string;
      signature: string;
      received_at: string;
    }[];
    send(response, 200, {
      ok: true,
      events: rows.map((row) => ({
        type: row.type,
        signature: row.signature,
        receivedAt: row.received_at,
        verified: true,
        payload: JSON.parse(row.body) as WebhookBody,
      })),
    });
    return;
  }
  send(response, 404, { ok: false });
});

let scanning = false;
async function tick(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    await scan();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    scanning = false;
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RenewPay webhook inbox at http://127.0.0.1:${PORT}`);
  void tick();
  setInterval(() => void tick(), 10_000);
});
