import { useState } from "react";
import { isHex, type Address, type Hex } from "viem";
import { buildKeeperFile, downloadKeeperFile } from "./lib/armKeeper";
import { formatChainError } from "./lib/actions";
import { DEMO_SUBSCRIPTION_KEY, readDemo } from "./lib/demo";

export function Keeper({ ethereum, owner }: { ethereum?: EthereumProvider; owner: Address | null }) {
  const [note, setNote] = useState("The keeper runs in a terminal on your machine, so it can renew after you close this page. It uses the session key, calls only renewSubscription, and does not raise the allowance.");
  const [pending, setPending] = useState(false);

  async function arm() {
    if (!ethereum || !owner) return;
    const id = readDemo(DEMO_SUBSCRIPTION_KEY);
    if (!isHex(id) || id.length !== 66) {
      setNote("Subscribe first. Then arm the keeper once.");
      return;
    }
    setPending(true);
    try {
      const file = await buildKeeperFile({ ethereum, owner, subscriptionId: id as Hex });
      downloadKeeperFile(file);
      setNote(file.enableSignature
        ? "The wallet approved the session key. Save the download as web/.keeper/session.json and run npm run keeper. Leave that terminal open. You can close this page. That file is the session key, not your wallet key. Do not commit it or paste it into chat."
        : "Save the download as web/.keeper/session.json and run npm run keeper. Leave that terminal open. You can close this page. The session key was already approved. That file is not your wallet key. Do not commit it or paste it into chat.");
    } catch (cause) {
      setNote(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card">
      <h2>Keeper</h2>
      <p className="lede">{note}</p>
      <button className="primary" type="button" disabled={pending || !ethereum || !owner} onClick={() => void arm()}>
        {pending ? "Waiting for the wallet…" : "Arm the keeper once"}
      </button>
    </section>
  );
}
