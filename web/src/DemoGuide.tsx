import { useEffect, useState } from "react";
import { formatEther, getAddress, type Address } from "viem";
import { merchantPlans, readBalances } from "./lib/actions";
import { formatTusd } from "./lib/billing";
import { DEMO_MERCHANT } from "./lib/chain";
import { DEMO_CANCELLED_KEY, DEMO_FUNDED_KEY, DEMO_PLAN_KEY, DEMO_RENEWED_KEY, DEMO_SUBSCRIPTION_KEY, readDemo } from "./lib/demo";

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function DemoGuide({ address }: { address: Address | null }) {
  const [native, setNative] = useState<bigint | null>(null);
  const [token, setToken] = useState<bigint | null>(null);
  const [plans, setPlans] = useState(0);
  const [marks, setMarks] = useState({ funded: "", subscribed: "", renewed: "", cancelled: "", planId: "" });

  useEffect(() => {
    const readMarks = () => {
      setMarks({
        funded: readDemo(DEMO_FUNDED_KEY),
        subscribed: readDemo(DEMO_SUBSCRIPTION_KEY),
        renewed: readDemo(DEMO_RENEWED_KEY),
        cancelled: readDemo(DEMO_CANCELLED_KEY),
        planId: readDemo(DEMO_PLAN_KEY),
      });
    };
    readMarks();
    window.addEventListener("renewpay-demo", readMarks);
    return () => window.removeEventListener("renewpay-demo", readMarks);
  }, []);

  useEffect(() => {
    if (!address) return;
    let stop = false;
    const load = () => {
      void Promise.all([readBalances(address), merchantPlans(address)])
        .then(([balances, rows]) => {
          if (stop) return;
          setNative(balances.native);
          setToken(balances.token);
          setPlans(rows.length);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener("renewpay-demo", load);
    return () => {
      stop = true;
      window.removeEventListener("renewpay-demo", load);
    };
  }, [address]);

  const rightWallet = address ? getAddress(address) === DEMO_MERCHANT : false;
  const hasGas = native !== null && native > 0n;
  const planReady = plans > 0 || marks.planId.length === 66;
  const steps = [
    { done: rightWallet && hasGas, text: `Connect ${short(DEMO_MERCHANT)}. This wallet holds the tUSD8 for the charges and the tQDAY for the account’s network fees.` },
    { done: planReady, text: "Merchant: leave the plan at 1 tUSD8 every 2 minutes and create it. The price is fixed once it is on chain." },
    { done: marks.funded.length > 0 && marks.subscribed.length > 0, text: "Subscriber: deposit 0.05 tQDAY, then subscribe. The first 1 tUSD8 moves to the merchant. The session key’s cap is 2 tUSD8 per period." },
    { done: marks.renewed === "1", text: "When the timer reaches zero, renew. Another 1 tUSD8 moves, still inside the cap." },
    { done: marks.cancelled === "1", text: "Cancel, then show why a renewal stops. The chain answers SubscriptionIsCancelled." },
  ];

  return (
    <section className="card guide">
      <h2>One subscription, start to finish</h2>
      <p className="lede">One wallet is the merchant and the owner of the subscriber account. Leave the numbers alone. The payment is tUSD8. The smart account’s network fee is a 0.05 tQDAY deposit, because QDay’s paymaster only sponsors a plain tUSD8 transfer.</p>
      <ol className="steps">
        {steps.map((step, index) => (
          <li key={step.text}>
            <span className={step.done ? "mark-step on" : "mark-step"}>{step.done ? "✓" : index + 1}</span>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
      {address ? (
        <p className="note">
          This wallet has {native === null ? "…" : formatEther(native)} tQDAY and {token === null ? "…" : formatTusd(token)} tUSD8.
          {rightWallet ? "" : ` Switch to ${short(DEMO_MERCHANT)} before you create a plan.`}
        </p>
      ) : (
        <p className="warn">Connect the wallet in the corner first. Pick {short(DEMO_MERCHANT)} in MetaMask.</p>
      )}
    </section>
  );
}
