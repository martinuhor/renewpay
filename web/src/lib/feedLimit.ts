/** How many new chain scans the public feed will start in one window. */
export const FEED_SCAN_LIMIT = 4;
export const FEED_SCAN_WINDOW_MS = 60_000;

export function takeScanSlot(
  stamps: readonly number[],
  now: number,
  limit = FEED_SCAN_LIMIT,
  windowMs = FEED_SCAN_WINDOW_MS,
): { ok: boolean; stamps: number[] } {
  const fresh = stamps.filter((stamp) => now - stamp < windowMs);
  if (fresh.length >= limit) return { ok: false, stamps: fresh };
  return { ok: true, stamps: [...fresh, now] };
}
