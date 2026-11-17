import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalWebhookBody, hmacSha256Hex, webhookSignaturesMatch, type WebhookBody } from "./webhook";

const sample: WebhookBody = {
  id: "0xabc:1",
  type: "subscription.renewed",
  merchant: "0xCDB8793ec57DcdcC432CA083792dE9fb78d46750",
  subscriber: "0x00000000000000000000000000000000000000b2",
  subscriptionId: `0x${"11".repeat(32)}`,
  amount: "1000000",
  paidUntil: "1700000120",
  reason: "",
  txHash: `0x${"ab".repeat(32)}`,
  blockNumber: "3411000",
};

describe("webhook signatures", () => {
  it("signs the canonical body and rejects a tampered payload", async () => {
    const body = canonicalWebhookBody(sample);
    const secret = "renewpay-demo-secret";
    const signature = await hmacSha256Hex(secret, body);
    assert.equal(signature.length, 64);
    assert.equal(await webhookSignaturesMatch(secret, body, signature), true);
    assert.equal(await webhookSignaturesMatch(secret, body, `0x${signature}`), true);
    const tampered = canonicalWebhookBody({ ...sample, amount: "2000000" });
    assert.equal(await webhookSignaturesMatch(secret, tampered, signature), false);
    assert.equal(await webhookSignaturesMatch("other-secret", body, signature), false);
  });
});
