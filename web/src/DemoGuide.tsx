import { useEffect, useState } from "react";
import { formatEther, getAddress, type Address } from "viem";
import { merchantPlans, readBalances } from "./lib/actions";
import { formatTusd } from "./lib/billing";
import { DEMO_MERCHANT } from "./lib/chain";
import { DEMO_CANCELLED_KEY, DEMO_FUNDED_KEY, DEMO_PAYMASTER_FUNDED_KEY, DEMO_PAYMASTER_KEY, DEMO_PLAN_KEY, DEMO_POLICY_KEY, DEMO_RENEWED_KEY, DEMO_SUBSCRIPTION_KEY, readDemo } from "./lib/demo";

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function DemoGuide({ address }: { address: Address | null }) {
  const [native, setNative] = useState<bigint | null>(null);
  const [token, setToken] = useState<bigint | null>(null);
  const [plans, setPlans] = useState(0);
  const [marks, setMarks] = useState({ funded: "", subscribed: "", renewed: "", cancelled: "", planId: "", policy: "", paymaster: "", fundedPaymaster: "" });

  useEffect(() => {
    const readMarks = () => {
      setMarks({
        funded: readDemo(DEMO_FUNDED_KEY),
        subscribed: readDemo(DEMO_SUBSCRIPTION_KEY),
        renewed: readDemo(DEMO_RENEWED_KEY),
        cancelled: readDemo(DEMO_CANCELLED_KEY),
        planId: readDemo(DEMO_PLAN_KEY),
        policy: readDemo(DEMO_POLICY_KEY),
        paymaster: readDemo(DEMO_PAYMASTER_KEY),
        fundedPaymaster: readDemo(DEMO_PAYMASTER_FUNDED_KEY),
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
  const setupReady = marks.policy.length === 42 && marks.paymaster.length === 42 && marks.fundedPaymaster === "1";
  const steps = [
    { done: rightWallet && hasGas, text: `Connect ${short(DEMO_MERCHANT)}. This wallet holds the tUSD8 and the tQDAY for the two deploys.` },
    { done: setupReady, text: "Subscriber: deploy the renew policy, deploy the paymaster, then fund the paymaster with 0.05 tQDAY." },
    { done: planReady, text: "Merchant: leave the plan at 1 tUSD8 every 2 minutes and create it. The price is fixed once it is on chain." },
    { done: marks.funded.length > 0 && marks.subscribed.length > 0, text: "Subscriber: move 3 tUSD8, then subscribe. The first 1 tUSD8 moves. The network fee is 0.01 tUSD8." },
    { done: marks.renewed === "1", text: "Leave the page open. When the timer hits zero the keeper renews. The session key signs it. You do not click Renew." },
    { done: marks.cancelled === "1", text: "Pause and revoke, then show why a renewal stops. The chain answers SubscriptionIsCancelled, and the tUSD8 allowance is 0." },
  ];

  return (
    <section className="card guide">
      <h2>One subscription, start to finish</h2>
      <p className="lede">One wallet is the merchant and the owner of the subscriber account. Leave the numbers alone. The payment is tUSD8. The paymaster’s EntryPoint float is tQDAY, and the subscriber fee is 0.01 tUSD8. QDay’s paymaster does not sponsor SubscriptionManager. The keeper renews when the period is due, and the session key signs that renewal.</p>
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
