const memory: { value: string } = { value: "" };

/** Server-only HMAC secret. Never send this to the browser. */
export async function webhookSecret(): Promise<string> {
  const fromEnv = process.env.RENEWPAY_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (memory.value) return memory.value;
  const fromDisk = await readStoredSecret();
  if (fromDisk) {
    memory.value = fromDisk;
    return fromDisk;
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  memory.value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await storeSecret(memory.value);
  return memory.value;
}

async function readStoredSecret(): Promise<string> {
  if (!process.versions?.node) return "";
  try {
    const { readFileSync } = await import("node:fs");
    for (const path of secretPaths()) {
      try {
        const value = readFileSync(path, "utf8").trim();
        if (value) return value;
      } catch {
        // The file is missing on a fresh machine.
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function storeSecret(value: string): Promise<void> {
  if (!process.versions?.node) return;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const path = "/tmp/renewpay-webhook-secret";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
  } catch {
    // A read-only function keeps the secret in memory for this process.
  }
}

function secretPaths(): string[] {
  return ["/tmp/renewpay-webhook-secret", "web/.webhook/secret", ".webhook/secret"];
}
