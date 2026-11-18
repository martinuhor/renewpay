import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { feedHeader, feedMessage, merchantSignedFeed } from "./feedAuth";
import { feedStartBlock, FEED_LOOKBACK } from "./recentFeed";

describe("merchant feed auth", () => {
  it("accepts a fresh signature from the merchant and rejects a swapped expiry", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const expires = Math.floor(Date.now() / 1000) + 600;
    const signature = await account.signMessage({ message: feedMessage(account.address, expires) });
    const header = feedHeader(expires, signature);
    assert.equal(await merchantSignedFeed(account.address, header), true);
    assert.equal(await merchantSignedFeed(account.address, `${expires + 1}.${signature}`), false);
    assert.equal(await merchantSignedFeed(account.address, ""), false);
  });

  it("keeps the public feed inside a short lookback", () => {
    const deploy = 3_407_013n;
    const latest = deploy + 200_000n;
    const start = feedStartBlock(latest, deploy);
    assert.equal(start, latest - FEED_LOOKBACK);
    assert.ok(latest - start <= FEED_LOOKBACK);
    assert.equal(feedStartBlock(deploy + 100n, deploy), deploy);
  });
});
