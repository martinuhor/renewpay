/** Aevum rejects eth_getLogs when toBlock - fromBlock is greater than 1000. */
export const MAX_LOG_SPAN = 1000n;

export type LogWindow = { fromBlock: bigint; toBlock: bigint };

/**
 * Inclusive windows whose `toBlock - fromBlock` never exceeds `span`.
 * A span of 1000 is the largest Aevum accepts.
 */
export function logWindows(fromBlock: bigint, toBlock: bigint, span = MAX_LOG_SPAN): LogWindow[] {
  if (span <= 0n) throw new Error("Log span must be positive.");
  if (toBlock < fromBlock) return [];
  const windows: LogWindow[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + span > toBlock ? toBlock : cursor + span;
    windows.push({ fromBlock: cursor, toBlock: end });
    if (end === toBlock) break;
    cursor = end + 1n;
  }
  return windows;
}
