/** The published host injects this. There is no file fallback. */
export function webhookSecret(): string {
  const fromEnv = process.env.RENEWPAY_WEBHOOK_SECRET?.trim() ?? "";
  if (!fromEnv) throw new Error("The signed feed is not configured.");
  return fromEnv;
}
