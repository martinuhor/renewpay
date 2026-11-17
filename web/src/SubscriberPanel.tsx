import { useEffect, useMemo, useState } from "react";
import { formatEther, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import {
  cancel,
  formatChainError,
  fundSubscriber,
  gasAllowance,
  readBalances,
  readPlan,
  readSubscription,
  renew,
  renewalRevert,
  subscribe,
  type Plan,
  type Subscription,
} from "./lib/actions";
import { subscriberAccount } from "./lib/account";
import {
  formatPeriod,
  formatTusd,
  parseTusdInput,
  randomSessionKey,
  subscriptionAllowance,
  subscriptionIdFor,
} from "./lib/billing";
import {
  DEMO_CAP,
  DEMO_FUND,
  STABLECOIN_PAYMASTER,
  SUBSCRIPTION_MANAGER,
  YEAR_SECONDS,
  explorerAddress,
  explorerTx,
} from "./lib/chain";
import { DEMO_CANCELLED_KEY, DEMO_FUNDED_KEY, DEMO_PLAN_KEY, DEMO_RENEWED_KEY, DEMO_SUBSCRIPTION_KEY, markDemo } from "./lib/demo";

const SESSION_KEY = "renewpay.sessionKey";

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function loadSessionKey(): Address {
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved && isAddress(saved)) return getAddress(saved);
  const created = randomSessionKey();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

export function SubscriberPanel({ ethereum, owner }: { ethereum?: EthereumProvider; owner: Address | null }) {
  const [planId, setPlanId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [cap, setCap] = useState(DEMO_CAP.toString());
  const [expiryDays, setExpiryDays] = useState("365");
  const [fund, setFund] = useState(DEMO_FUND.toString());
  const [sessionKey, setSessionKey] = useState<Address | null>(null);
  const [subscriber, setSubscriber] = useState<Address | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<Hex | null>(null);
  const [ownerBalance, setOwnerBalance] = useState<bigint | null>(null);
  const [subscriberBalance, setSubscriberBalance] = useState<bigint | null>(null);
  const [native, setNative] = useState<bigint | null>(null);
  const [now, setNow] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)));
  const [status, setStatus] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    setSessionKey(loadSessionKey());
    const saved = localStorage.getItem(DEMO_PLAN_KEY) ?? "";
    setPlanId(saved);
    if (!isHex(saved) || saved.length !== 66) return;
    let stop = false;
    void readPlan(saved)
      .then((next) => {
        if (!stop) setPlan(next);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClock(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ethereum || !owner) return;
    let cancelled = false;
    void (async () => {
      try {
        const account = await subscriberAccount(ethereum);
        const address = await account.getAddress();
        if (cancelled) return;
        setSubscriber(address);
        const [walletBalances, accountBalances] = await Promise.all([readBalances(owner), readBalances(address)]);
        if (cancelled) return;
        setOwnerBalance(walletBalances.token);
        setNative(walletBalances.native);
        setSubscriberBalance(accountBalances.token);
      } catch (cause) {
        if (!cancelled) setError(formatChainError(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ethereum, owner]);

  const expiry = useMemo(() => {
    try {
      const days = parseTusdInput(expiryDays);
      return now + days * 24n * 60n * 60n;
    } catch {
      return now + YEAR_SECONDS;
    }
  }, [expiryDays, now]);

  let allowancePreview: string | null = null;
  try {
    if (plan) allowancePreview = formatTusd(subscriptionAllowance(parseTusdInput(cap), now, expiry, plan.periodSeconds));
  } catch (cause) {
    allowancePreview = cause instanceof Error ? cause.message : null;
  }

  const predictedId = plan && subscriber && sessionKey ? subscriptionIdFor(subscriber, planId as Hex, sessionKey) : null;

  async function loadPlan() {
    setError(null);
    setStatus(null);
    if (!isHex(planId) || planId.length !== 66) {
      setError("Plan id is a 32-byte hex value.");
      return;
    }
    setPending(true);
    try {
      const next = await readPlan(planId);
      setPlan(next);
      markDemo(DEMO_PLAN_KEY, planId);
      setNow(BigInt(Math.floor(Date.now() / 1000)));
    } catch (cause) {
      setPlan(null);
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function refreshSubscription(id: Hex) {
    const sub = await readSubscription(id);
    setSubscription(sub);
    setSubscriptionId(id);
    if (subscriber) {
      const balances = await readBalances(subscriber);
      setSubscriberBalance(balances.token);
    }
  }

  async function onFund() {
    if (!ethereum || !owner || !subscriber) return;
    setPending(true);
    setError(null);
    try {
      const hash = await fundSubscriber({ ethereum, from: owner, to: subscriber, amount: parseTusdInput(fund) });
      setTx(hash);
      markDemo(DEMO_FUNDED_KEY, hash);
      setStatus("3 tUSD8 is on the subscriber account. That transfer’s fee was tQDAY. Subscribe next.");
      const [walletBalances, accountBalances] = await Promise.all([readBalances(owner), readBalances(subscriber)]);
      setOwnerBalance(walletBalances.token);
      setSubscriberBalance(accountBalances.token);
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onSubscribe() {
    if (!ethereum || !plan || !sessionKey || !isHex(planId)) return;
    setPending(true);
    setError(null);
    try {
      const hash = await subscribe({
        ethereum,
        planId,
        sessionKey,
        cap: parseTusdInput(cap),
        expiry,
        periodSeconds: plan.periodSeconds,
      });
      setTx(hash);
      setStatus("Subscribed. The first 1 tUSD8 moved to you, and the network fee was tUSD8. Wait for the timer, then renew.");
      if (predictedId) {
        markDemo(DEMO_SUBSCRIPTION_KEY, predictedId);
        await refreshSubscription(predictedId);
      }
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onRenew() {
    if (!ethereum || !subscriber || !subscriptionId || !subscription) return;
    setPending(true);
    setError(null);
    try {
      const hash = await renew({
        ethereum,
        subscriber,
        subscriptionId,
        cap: subscription.spendingCapPerPeriod,
        expiry: subscription.expiry,
        periodSeconds: subscription.periodSeconds,
      });
      setTx(hash);
      markDemo(DEMO_RENEWED_KEY, "1");
      setStatus("Renewed. Another 1 tUSD8 moved, and the network fee was tUSD8. Cancel next.");
      await refreshSubscription(subscriptionId);
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onCancel() {
    if (!ethereum || !subscriptionId) return;
    setPending(true);
    setError(null);
    try {
      const hash = await cancel(ethereum, subscriptionId);
      setTx(hash);
      markDemo(DEMO_CANCELLED_KEY, "1");
      setStatus("Cancelled. Click Show why a renewal stops.");
      await refreshSubscription(subscriptionId);
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  const renewReady = Boolean(subscription && !subscription.cancelled && BigInt(clock) >= subscription.paidUntil);
  const secondsLeft = subscription && !subscription.cancelled ? Number(subscription.paidUntil) - clock : 0;

  async function onExplain() {
    if (!subscriptionId) return;
    setPending(true);
    setError(null);
    try {
      setStopReason(await renewalRevert(subscriptionId));
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Subscribe</h2>
        <p className="lede">Use the same wallet. Move 3 tUSD8, then subscribe. Gas for subscribe, renew, and cancel is tUSD8 through the paymaster at {short(STABLECOIN_PAYMASTER)}.</p>
        <label>
          Plan id
          <input value={planId} onChange={(event) => setPlanId(event.target.value.trim())} spellCheck={false} />
        </label>
        <div className="actions">
          <button className="ghost" type="button" disabled={pending} onClick={() => void loadPlan()}>Load plan</button>
        </div>
        {plan ? (
          <dl>
            <dt>Price</dt>
            <dd>{formatTusd(plan.amount)} tUSD8 / {formatPeriod(plan.periodSeconds)}</dd>
            <dt>Merchant</dt>
            <dd><a href={explorerAddress(plan.merchant)}>{plan.merchant}</a></dd>
            <dt>Trial</dt>
            <dd>{plan.trialSeconds.toString()}s</dd>
            <dt>Metadata</dt>
            <dd>{plan.metadataURI}</dd>
          </dl>
        ) : null}
        <label>
          Session key
          <input readOnly value={sessionKey ?? ""} />
        </label>
        <div className="actions">
          <button
            className="ghost"
            type="button"
            onClick={() => {
              const next = randomSessionKey();
              localStorage.setItem(SESSION_KEY, next);
              setSessionKey(next);
            }}
          >
            New session key
          </button>
        </div>
        <label>
          Spending cap per period, base units
          <input value={cap} onChange={(event) => setCap(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          Expiry, days from now
          <input value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} inputMode="numeric" />
        </label>
        <div className="note">
          Subscription allowance {allowancePreview ?? "—"} tUSD8. That figure is the cap multiplied by the periods until expiry.
          Paymaster allowance {formatTusd(gasAllowance())} tUSD8. Both approvals are finite.
        </div>
        {subscriber ? (
          <p className="mono">Subscriber account {subscriber}</p>
        ) : (
          <p className="lede">Connect a wallet to derive the Kernel subscriber account.</p>
        )}
        <dl>
          <dt>Wallet tUSD8</dt>
          <dd>{ownerBalance === null ? "—" : formatTusd(ownerBalance)}</dd>
          <dt>Wallet tQDAY</dt>
          <dd>{native === null ? "—" : formatEther(native)}</dd>
          <dt>Subscriber tUSD8</dt>
          <dd>{subscriberBalance === null ? "—" : formatTusd(subscriberBalance)}</dd>
        </dl>
        <label>
          Move tUSD8 onto the subscriber account
          <input value={fund} onChange={(event) => setFund(event.target.value)} inputMode="numeric" />
        </label>
        <p className="warn">That transfer is a wallet transaction, so its network fee is tQDAY. Default is 3 tUSD8: the first period, one renewal, and paymaster gas.</p>
        <div className="actions">
          <button className="ghost" type="button" disabled={pending || !subscriber} onClick={() => void onFund()}>Move 3 tUSD8</button>
          <button className="primary" type="button" disabled={pending || !plan || !subscriber} onClick={() => void onSubscribe()}>
            {pending ? "Working…" : "Subscribe"}
          </button>
        </div>
        {predictedId ? <p className="mono">Subscription id {predictedId}</p> : null}
        {status ? <p className="note">{status}</p> : null}
        {tx ? <p><a href={explorerTx(tx)}>Transaction</a></p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
      <section className="card">
        <h2>Billing</h2>
        {subscription ? (
          <>
            <dl>
              <dt>Status</dt>
              <dd>{subscription.cancelled ? "Cancelled" : "Active"}</dd>
              <dt>Paid until</dt>
              <dd>{new Date(Number(subscription.paidUntil) * 1000).toLocaleString()}</dd>
              <dt>Amount</dt>
              <dd>{formatTusd(subscription.amount)} tUSD8</dd>
              <dt>Cap</dt>
              <dd>{formatTusd(subscription.spendingCapPerPeriod)} tUSD8</dd>
              <dt>Session key</dt>
              <dd className="mono">{subscription.sessionKey}</dd>
            </dl>
            <div className="actions">
              <button className="primary" type="button" disabled={pending || !renewReady} onClick={() => void onRenew()}>
                Renew
              </button>
              <button className="ghost" type="button" disabled={pending || subscription.cancelled} onClick={() => void onCancel()}>
                Cancel
              </button>
              {subscription.cancelled ? (
                <button className="ghost" type="button" disabled={pending} onClick={() => void onExplain()}>
                  Show why a renewal stops
                </button>
              ) : null}
            </div>
            {!subscription.cancelled && !renewReady ? (
              <p className="note">Renew unlocks in {Math.max(secondsLeft, 0)}s. Leave this tab open.</p>
            ) : null}
            {stopReason ? <p className="note">{stopReason}</p> : null}
          </>
        ) : (
          <p className="lede">The next billing date appears here after subscribe.</p>
        )}
        {subscriptionId ? (
          <p>
            <button className="ghost" type="button" disabled={pending} onClick={() => void refreshSubscription(subscriptionId).catch((cause: unknown) => setError(formatChainError(cause)))}>
              Refresh
            </button>
          </p>
        ) : null}
        <p className="lede">The manager recorded at {short(SUBSCRIPTION_MANAGER)} pulls one period at a time, and only when the session key is inside its cap and expiry.</p>
      </section>
    </div>
  );
}
