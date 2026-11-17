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
    { done: rightWallet && hasGas, text: `Connect ${short(DEMO_MERCHANT)}. That wallet already has the tQDAY for the two normal transactions and the tUSD8 for the subscription.` },
    { done: planReady, text: "On Merchant, leave the form as it is (1 tUSD8, 120 seconds) and click Create plan. Confirm in the wallet. The fee is a little tQDAY." },
    { done: marks.funded.length > 0 && marks.subscribed.length > 0, text: "Open Subscriber, same wallet. Click Move 3 tUSD8, then Subscribe. Confirm both. Subscribe’s network fee is tUSD8." },
    { done: marks.renewed === "1", text: "When the Billing timer reaches zero, click Renew and confirm. Another 1 tUSD8 moves. The fee is tUSD8." },
    { done: marks.cancelled === "1", text: "Click Cancel, then Show why a renewal stops. The reason should be SubscriptionIsCancelled." },
  ];

  return (
    <section className="card guide">
      <h2>Do these five clicks</h2>
      <p className="lede">One wallet plays both roles. You are the merchant. The subscriber is the smart account on the next tab. Leave the numbers alone.</p>
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
