import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LOG_SPAN, logWindows } from "./logs";

describe("log windows", () => {
  it("keeps every window inside Aevum's 1000-block cap and covers the range", () => {
    const from = 3_407_013n;
    const to = from + 4_819n;
    const windows = logWindows(from, to);
    assert.ok(windows.length > 1);
    assert.equal(windows[0]?.fromBlock, from);
    assert.equal(windows.at(-1)?.toBlock, to);
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      assert.ok(window);
      assert.ok(window.toBlock - window.fromBlock <= MAX_LOG_SPAN);
      const next = windows[index + 1];
      if (next) assert.equal(next.fromBlock, window.toBlock + 1n);
    }
  });

  it("uses one window when the range is already legal, and none when it is backwards", () => {
    assert.deepEqual(logWindows(10n, 10n), [{ fromBlock: 10n, toBlock: 10n }]);
    assert.deepEqual(logWindows(10n, 1010n), [{ fromBlock: 10n, toBlock: 1010n }]);
    assert.deepEqual(logWindows(5n, 4n), []);
  });
});
