import { useEffect, useState } from "react";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { formatChainError, readSubscription, renew } from "./lib/actions";
import { explorerTx } from "./lib/chain";
import { DEMO_RENEWED_KEY, DEMO_SUBSCRIPTION_KEY, markDemo, readDemo } from "./lib/demo";
import { savedPaymaster, sessionSigner } from "./lib/sponsorship";

const RECEIPT_KEY = "renewpay.keeperReceipt";

export function Keeper({ ethereum, owner }: { ethereum?: EthereumProvider; owner: Address | null }) {
  const [note, setNote] = useState("The keeper renews a due subscription from this browser. You do not click Renew. Cancel stays on the wallet.");
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    const saved = readDemo(RECEIPT_KEY);
    if (isHex(saved) && saved.length === 66) setHash(saved);
    if (!ethereum || !owner) return;
    const wallet = ethereum;
    const who = owner;
    let stop = false;
    let busy = false;
    let waitUntil = 0;

    async function tick() {
      if (stop || busy || Date.now() < waitUntil) return;
      const id = readDemo(DEMO_SUBSCRIPTION_KEY);
      if (!isHex(id) || id.length !== 66) return;
      if (!savedPaymaster()) {
        setNote("Deploy and fund the paymaster. The keeper renews after that, without a Renew click.");
        return;
      }
      busy = true;
      try {
        const subscription = await readSubscription(id as Hex);
        if (!subscription.exists || subscription.cancelled) {
          setNote("This subscription is cancelled. The keeper will not renew it.");
          return;
        }
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (now < subscription.paidUntil) {
          const left = Number(subscription.paidUntil - now);
          setNote(`Keeper is watching. The next charge is in ${left}s. The session key will sign it. Cancel stays on the wallet.`);
          return;
        }
        const signer = sessionSigner();
        if (getAddress(signer.address) !== getAddress(subscription.sessionKey)) {
          setNote("This browser does not hold that session key, so the keeper cannot sign the renewal.");
          waitUntil = Date.now() + 60_000;
          return;
        }
        setNote("The period is due. The keeper is submitting the renewal. The first time, approve the session key in the wallet.");
        const result = await renew({
          ethereum: wallet,
          owner: who,
          subscriber: getAddress(subscription.subscriber),
          subscriptionId: id as Hex,
          sessionKey: getAddress(subscription.sessionKey),
          cap: subscription.spendingCapPerPeriod,
          expiry: subscription.expiry,
          periodSeconds: subscription.periodSeconds,
        });
        markDemo(DEMO_RENEWED_KEY, "1");
        markDemo(RECEIPT_KEY, result.hash);
        setHash(result.hash);
        setNote(result.firstEnable
          ? "The keeper renewed it. The wallet approved the session key, and the key signed the renewal."
          : "The keeper renewed it. The session key signed, and nobody clicked Renew.");
      } catch (cause) {
        const message = formatChainError(cause);
        setNote(message);
        waitUntil = Date.now() + (/rejected/i.test(message) ? 120_000 : 30_000);
      } finally {
        busy = false;
      }
    }

    void tick();
    const timer = window.setInterval(() => void tick(), 5_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [ethereum, owner]);

  return (
    <section className="card">
      <h2>Keeper</h2>
      <p className="lede">{note}</p>
      {hash ? <p><a href={explorerTx(hash)}>{explorerTx(hash)}</a></p> : null}
    </section>
  );
}
