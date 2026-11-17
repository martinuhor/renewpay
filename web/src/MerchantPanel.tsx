import { useEffect, useState } from "react";
import type { Address, Hash, Hex } from "viem";
import { Inbox } from "./Inbox";
import { createPlan, formatChainError, merchantPlans, merchantRenewals, merchantSubscriptions, type Plan, type Renewal, type Subscription } from "./lib/actions";
import { formatPeriod, formatTusd, parseTusdInput, planIdFor } from "./lib/billing";
import {
  DEMO_AMOUNT,
  DEMO_METADATA,
  DEMO_PERIOD_SECONDS,
  DEMO_SHORT_PERIOD_SECONDS,
  DEMO_TRIAL_SECONDS,
  explorerTx,
} from "./lib/chain";
import { DEMO_PLAN_KEY, markDemo } from "./lib/demo";

function short(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function MerchantPanel({ ethereum, merchant }: { ethereum?: EthereumProvider; merchant: Address | null }) {
  const [amount, setAmount] = useState(DEMO_AMOUNT.toString());
  const [period, setPeriod] = useState(DEMO_SHORT_PERIOD_SECONDS.toString());
  const [trial, setTrial] = useState(DEMO_TRIAL_SECONDS.toString());
  const [metadata, setMetadata] = useState(DEMO_METADATA);
  const [plans, setPlans] = useState<{ planId: Hex; plan: Plan; txHash: Hash }[]>([]);
  const [subscriptions, setSubscriptions] = useState<{ id: Hex; sub: Subscription }[]>([]);
  const [renewals, setRenewals] = useState<Renewal[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function refresh(address: Address) {
    const [nextPlans, nextSubscriptions, nextRenewals] = await Promise.all([
      merchantPlans(address),
      merchantSubscriptions(address),
      merchantRenewals(address),
    ]);
    setPlans(nextPlans);
    setSubscriptions(nextSubscriptions);
    setRenewals(nextRenewals);
  }

  useEffect(() => {
    if (!merchant) return;
    void refresh(merchant).catch((cause: unknown) => setError(formatChainError(cause)));
  }, [merchant]);

  async function onCreate() {
    if (!ethereum || !merchant) {
      setError("Connect the merchant wallet first.");
      return;
    }
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const created = await createPlan({
        ethereum,
        merchant,
        amount: parseTusdInput(amount),
        periodSeconds: parseTusdInput(period),
        trialSeconds: parseTusdInput(trial),
        metadataURI: metadata,
      });
      markDemo(DEMO_PLAN_KEY, created.planId);
      setStatus("Plan is on-chain. Open Subscriber and continue with this same wallet.");
      await refresh(merchant);
    } catch (cause) {
      const message = formatChainError(cause);
      if (/PlanExists/i.test(message) && merchant) {
        const existing = planIdFor(merchant, parseTusdInput(amount), parseTusdInput(period), parseTusdInput(trial), metadata);
        markDemo(DEMO_PLAN_KEY, existing);
        setStatus("This exact plan is already on-chain. Open Subscriber and continue.");
        await refresh(merchant);
        return;
      }
      setError(message);
    } finally {
      setPending(false);
    }
  }

  let preview = "";
  let previewAmount = "";
  try {
    const parsedAmount = parseTusdInput(amount);
    const parsedPeriod = parseTusdInput(period);
    previewAmount = `${formatTusd(parsedAmount)} tUSD8 every ${formatPeriod(parsedPeriod)}.`;
    if (merchant) preview = planIdFor(merchant, parsedAmount, parsedPeriod, parseTusdInput(trial), metadata);
  } catch {
    preview = "";
    previewAmount = "";
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Create a plan</h2>
        <p className="lede">Leave this at 1 tUSD8 every 2 minutes. Creating a plan is a wallet transaction, so its fee is tQDAY. {previewAmount}</p>
        <label>
          Amount, base units (1000000 = 1 tUSD8)
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          Period, seconds
          <input value={period} onChange={(event) => setPeriod(event.target.value)} inputMode="numeric" />
        </label>
        <div className="row presets">
          <button type="button" onClick={() => setPeriod(DEMO_PERIOD_SECONDS.toString())}>30 days</button>
          <button type="button" onClick={() => setPeriod(DEMO_SHORT_PERIOD_SECONDS.toString())}>120 seconds</button>
        </div>
        <p className="warn">Aevum has no time warp. 120 seconds lets you renew in this sitting. 30 days is the monthly plan, and you would have to come back.</p>
        <label>
          Trial, seconds
          <input value={trial} onChange={(event) => setTrial(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          Metadata
          <textarea value={metadata} onChange={(event) => setMetadata(event.target.value)} />
        </label>
        {preview ? <p className="mono">Plan id {preview}</p> : null}
        <div className="actions">
          <button className="primary" type="button" disabled={pending || !merchant} onClick={() => void onCreate()}>
            {pending ? "Creating…" : "Create plan"}
          </button>
        </div>
        {status ? <p className="note">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        <Inbox merchant={merchant} />
      </section>
      <section className="card">
        <h2>Plans and renewals</h2>
        <div className="list">
          {plans.length === 0 ? <p className="lede">No plans from this merchant yet.</p> : null}
          {plans.map((item) => (
            <article className="item" key={item.planId}>
              <div className="mono">{item.planId}</div>
              <div>{formatTusd(item.plan.amount)} tUSD8 · every {formatPeriod(item.plan.periodSeconds)}</div>
              <div>{item.plan.metadataURI}</div>
              <a href={explorerTx(item.txHash)}>Creation transaction</a>
            </article>
          ))}
        </div>
        <h3>Subscriptions</h3>
        <div className="list">
          {subscriptions.length === 0 ? <p className="lede">No subscriptions for this merchant yet.</p> : null}
          {subscriptions.map((item) => (
            <article className="item" key={item.id}>
              <div className="mono">{short(item.id)}</div>
              <div>Subscriber {short(item.sub.subscriber)}</div>
              <div>{item.sub.cancelled ? "Cancelled" : `Paid until ${new Date(Number(item.sub.paidUntil) * 1000).toLocaleString()}`}</div>
            </article>
          ))}
        </div>
        <h3>Renewal history</h3>
        <div className="list">
          {renewals.length === 0 ? <p className="lede">No renewals yet.</p> : null}
          {renewals.map((item) => (
            <article className="item" key={`${item.txHash}-${item.subscriptionId}`}>
              <div>{formatTusd(item.amount)} tUSD8 · {short(item.subscriber)}</div>
              <a href={explorerTx(item.txHash)}>Renewal transaction</a>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
