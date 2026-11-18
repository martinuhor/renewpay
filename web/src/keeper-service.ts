/**
 * Renews a due subscription after the checkout tab is closed.
 * It reads a file the user saved once. It does not read a wallet private key.
 */
import { readFileSync } from "node:fs";
import { formatChainError } from "./lib/account";
import { parseKeeperFile } from "./lib/keeperCall";
import { keeperTick } from "./lib/keeperRun";

const path = process.argv[2] ?? ".keeper/session.json";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.log(`Save the checkout download as ${path}, then run this again. Leave this terminal open. The browser can close.`);
    process.exitCode = 1;
    return;
  }
  const file = parseKeeperFile(raw);
  console.log(`Keeper watching ${file.subscriptionId}. Close the checkout if you want. This process is what stays running.`);
  for (;;) {
    try {
      const tick = await keeperTick(file);
      console.log(tick.message);
      if (tick.stop) return;
    } catch (cause) {
      const message = formatChainError(cause);
      console.log(message);
      if (/allowance|cancelled|revoked|expired|Arm the keeper/i.test(message)) return;
    }
    await sleep(20_000);
  }
}

void main();
