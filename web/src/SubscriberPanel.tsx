import { useEffect, useMemo, useState } from "react";
import { formatEther, isHex, type Address, type Hash, type Hex } from "viem";
import {
  cancel,
  formatChainError,
  fundSubscriber,
  readBalances,
  readDeposit,
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
  subscriptionAllowance,
  subscriptionIdFor,
} from "./lib/billing";
import {
  DEMO_AMOUNT,
  DEMO_CAP,
  DEMO_FUND,
  DEMO_GAS_DEPOSIT,
  SPONSOR_FEE,
  SUBSCRIPTION_MANAGER,
  YEAR_SECONDS,
  explorerAddress,
  explorerTx,
} from "./lib/chain";
import { Keeper } from "./Keeper";
import { ReceiptList, StepProgress, type Receipt } from "./Receipts";
import { deployPaymaster, deployPolicy, fundPaymaster, rotateSessionSigner, savedPaymaster, savedPolicy, sessionSigner } from "./lib/sponsorship";
import { DEMO_CANCELLED_KEY, DEMO_FUNDED_KEY, DEMO_PLAN_KEY, DEMO_RENEWED_KEY, DEMO_SUBSCRIPTION_KEY, markDemo } from "./lib/demo";

function SetupButtons({
  pending,
  owner,
  policy,
  paymaster,
  onDeployPolicy,
  onDeployPaymaster,
  onFundPaymaster,
  emphasizeNext = false,
}: {
  pending: boolean;
  owner: Address | null;
  policy: Address | null;
  paymaster: Address | null;
  onDeployPolicy: () => Promise<void>;
  onDeployPaymaster: () => Promise<void>;
  onFundPaymaster: () => Promise<void>;
  emphasizeNext?: boolean;
}) {
  return (
    <div className="actions">
      <button className={emphasizeNext && !policy ? "primary" : "ghost"} type="button" disabled={pending || !owner || Boolean(policy)} onClick={() => void onDeployPolicy()}>
        {policy ? "1. Policy deployed" : "1. Deploy renew policy"}
      </button>
      <button className={emphasizeNext && policy && !paymaster ? "primary" : "ghost"} type="button" disabled={pending || !owner || !policy || Boolean(paymaster)} onClick={() => void onDeployPaymaster()}>
        {paymaster ? "2. Paymaster deployed" : "2. Deploy paymaster"}
      </button>
      <button className={emphasizeNext && policy && paymaster ? "primary" : "ghost"} type="button" disabled={pending || !paymaster} onClick={() => void onFundPaymaster()}>
        3. Fund paymaster {formatEther(DEMO_GAS_DEPOSIT)} tQDAY
      </button>
    </div>
  );
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function SubscriberPanel({ ethereum, owner }: { ethereum?: EthereumProvider; owner: Address | null }) {
  const [planId, setPlanId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [cap, setCap] = useState(DEMO_CAP.toString());
  const [expiryDays, setExpiryDays] = useState("1");
  const fund = DEMO_FUND.toString();
  const [sessionKey, setSessionKey] = useState<Address | null>(null);
  const [policy, setPolicy] = useState<Address | null>(null);
  const [paymaster, setPaymaster] = useState<Address | null>(null);
  const [subscriber, setSubscriber] = useState<Address | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<Hex | null>(null);
  const [ownerBalance, setOwnerBalance] = useState<bigint | null>(null);
  const [subscriberBalance, setSubscriberBalance] = useState<bigint | null>(null);
  const [native, setNative] = useState<bigint | null>(null);
  const [deposit, setDeposit] = useState<bigint | null>(null);
  const [now, setNow] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)));
  const [status, setStatus] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [subscribeStep, setSubscribeStep] = useState(0);

  function remember(label: string, hash: Hash) {
    setTx(hash);
    setReceipts((current) => [{ label, hash }, ...current.filter((item) => item.hash !== hash)]);
  }

  useEffect(() => {
    setSessionKey(sessionSigner().address);
    setPolicy(savedPolicy());
    setPaymaster(savedPaymaster());
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
        const paymasterAddress = savedPaymaster();
        const [walletBalances, accountBalances, gasDeposit] = await Promise.all([
          readBalances(owner),
          readBalances(address),
          paymasterAddress ? readDeposit(paymasterAddress) : Promise.resolve(0n),
        ]);
        if (cancelled) return;
        setOwnerBalance(walletBalances.token);
        setNative(walletBalances.native);
        setSubscriberBalance(accountBalances.token);
        setDeposit(gasDeposit);
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

  async function onDeployPolicy() {
    if (!ethereum || !owner) return;
    setPending(true);
    setError(null);
    try {
      const address = await deployPolicy(ethereum, owner);
      setPolicy(address);
      setTx(null);
      setStatus("Renew policy deployed. Deploy the paymaster next.");
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onDeployPaymaster() {
    if (!ethereum || !owner) return;
    setPending(true);
    setError(null);
    try {
      const address = await deployPaymaster(ethereum, owner);
      setPaymaster(address);
      setDeposit(0n);
      setTx(null);
      setStatus("Paymaster deployed. Fund it with 0.05 tQDAY. That is the float. Subscribers pay 0.01 tUSD8.");
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onFundPaymaster() {
    if (!ethereum || !owner || !paymaster) return;
    setPending(true);
    setError(null);
    try {
      const hash = await fundPaymaster(ethereum, owner, paymaster);
      setTx(hash);
      setDeposit(await readDeposit(paymaster));
      setStatus("Paymaster funded. Move tUSD8, then subscribe. The network fee on subscribe is 0.01 tUSD8.");
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onFund() {
    if (!ethereum || !owner || !subscriber) return;
    setPending(true);
    setError(null);
    try {
      const hash = await fundSubscriber({ ethereum, from: owner, to: subscriber, amount: parseTusdInput(fund) });
      remember("Moved tUSD8 onto the subscriber account", hash);
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
    setSubscribeStep(1);
    try {
      const hash = await subscribe({
        ethereum,
        planId,
        sessionKey,
        cap: parseTusdInput(cap),
        expiry,
        periodSeconds: plan.periodSeconds,
      });
      remember("Subscribed", hash);
      setSubscribeStep(3);
      setStatus("Subscribed. The first period moved to the merchant, and 0.01 tUSD8 paid the network fee. Wait for the timer, then renew.");
      if (predictedId) {
        markDemo(DEMO_SUBSCRIPTION_KEY, predictedId);
        await refreshSubscription(predictedId);
      }
    } catch (cause) {
      setSubscribeStep(0);
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onRenew() {
    if (!ethereum || !owner || !subscriber || !subscriptionId || !subscription || !sessionKey) return;
    setPending(true);
    setError(null);
    try {
      const result = await renew({
        ethereum,
        owner,
        subscriber,
        subscriptionId,
        sessionKey: subscription.sessionKey,
        cap: subscription.spendingCapPerPeriod,
        expiry: subscription.expiry,
        periodSeconds: subscription.periodSeconds,
      });
      remember("Renewed", result.hash);
      markDemo(DEMO_RENEWED_KEY, "1");
      setStatus(
        result.firstEnable
          ? "Renewed. The wallet approved this session key, and the key signed the renewal. Another 1 tUSD8 moved. The network fee was 0.01 tUSD8."
          : "Renewed. The session key signed this one, with no extra wallet approval. Another 1 tUSD8 moved.",
      );
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
      remember("Paused and revoked", hash);
      markDemo(DEMO_CANCELLED_KEY, "1");
      setStatus("Paused. The subscription is cancelled and the session key is revoked. The manager allowance is 0. The paymaster allowance was set to the 0.01 tUSD8 fee, which this operation spends, so that allowance ends at 0. The live manager cannot change the token allowance itself. This click did it from the subscriber account.");
      await refreshSubscription(subscriptionId);
    } catch (cause) {
      setError(formatChainError(cause));
    } finally {
      setPending(false);
    }
  }

  const setupDone = Boolean(policy && paymaster && deposit !== null && deposit > 0n);
  const needsFunds = subscriberBalance !== null && plan !== null && subscriberBalance < plan.amount;
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
        <h2>{setupDone ? "Subscribe" : "First visit"}</h2>
        {setupDone ? (
          <details>
            <summary>Setup is done. The three confirms stay here, in order.</summary>
            <SetupButtons pending={pending} owner={owner} policy={policy} paymaster={paymaster} onDeployPolicy={onDeployPolicy} onDeployPaymaster={onDeployPaymaster} onFundPaymaster={onFundPaymaster} />
          </details>
        ) : (
          <>
            <p className="lede">These three confirms happen once, in this order. The paymaster’s EntryPoint float is tQDAY. The subscriber fee is 0.01 tUSD8. QDay’s paymaster does not sponsor SubscriptionManager.</p>
            <SetupButtons pending={pending} owner={owner} policy={policy} paymaster={paymaster} onDeployPolicy={onDeployPolicy} onDeployPaymaster={onDeployPaymaster} onFundPaymaster={onFundPaymaster} emphasizeNext />
          </>
        )}
        <p className="lede">Choose the 1 tUSD8 plan. The review shows the cap, the fee, and the recipient. Then confirm once.</p>
        <button className={plan?.amount === DEMO_AMOUNT ? "primary" : "ghost"} type="button" disabled={pending || !setupDone} onClick={() => void loadPlan()}>
          {plan?.amount === DEMO_AMOUNT ? "1 tUSD8 plan selected" : "Choose the 1 tUSD8 plan"}
        </button>
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
        {plan && sessionKey ? (
          <div className="review">
            <strong>Review before you confirm</strong>
            <div>Plan {formatTusd(plan.amount)} tUSD8</div>
            <div>Cap 2 tUSD8 per period</div>
            <div>Fee {formatTusd(SPONSOR_FEE)} tUSD8</div>
            <div>Recipient {plan.merchant}</div>
          </div>
        ) : null}
        <details>
          <summary>Balances, cap, and session key</summary>
          <label>
            Session key. This browser holds it. Pause revokes it.
            <input readOnly value={sessionKey ?? ""} />
          </label>
          <div className="actions">
            <button className="ghost" type="button" onClick={() => setSessionKey(rotateSessionSigner())}>New session key</button>
          </div>
          <label>
            Plan id
            <input value={planId} onChange={(event) => setPlanId(event.target.value.trim())} spellCheck={false} />
          </label>
          <label>
            Spending cap per period. 2000000 is 2 tUSD8.
            <input value={cap} onChange={(event) => setCap(event.target.value)} inputMode="numeric" />
          </label>
          <label>
            Expiry, days from now. The default is 1. The key stays in this browser tab, not in saved site data.
            <input value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} inputMode="numeric" />
          </label>
          <div className="note">Allowance {allowancePreview ?? "—"} tUSD8. Cap times two. It stays finite.</div>
          {subscriber ? <p className="mono">Subscriber account {subscriber}</p> : <p className="lede">Connect a wallet to derive the subscriber account.</p>}
          <dl>
            <dt>Wallet tUSD8</dt>
            <dd>{ownerBalance === null ? "—" : formatTusd(ownerBalance)}</dd>
            <dt>Wallet tQDAY</dt>
            <dd>{native === null ? "—" : formatEther(native)}</dd>
            <dt>Subscriber tUSD8</dt>
            <dd>{subscriberBalance === null ? "—" : formatTusd(subscriberBalance)}</dd>
            <dt>Paymaster float, tQDAY</dt>
            <dd>{deposit === null ? "—" : formatEther(deposit)}</dd>
          </dl>
          <p className="lede">
            The contracts are <a href="https://github.com/martinuhor/renewpay/blob/cursor/week2-checkout-a136/src/RenewOnlyPolicy.sol">RenewOnlyPolicy.sol</a> and <a href="https://github.com/martinuhor/renewpay/blob/cursor/week2-checkout-a136/src/SubscriptionPaymaster.sol">SubscriptionPaymaster.sol</a>.
          </p>
        </details>
        <StepProgress
          labels={["Approve the capped tUSD8 allowance", "Activate the subscription", "Receipt"]}
          active={subscribeStep}
        />
        <div className="actions">
          {needsFunds ? (
            <button className="ghost" type="button" disabled={pending || !subscriber} onClick={() => void onFund()}>Move 3 tUSD8</button>
          ) : null}
          <button className="primary" type="button" disabled={pending || !plan || !subscriber || !paymaster || deposit === 0n || needsFunds} onClick={() => void onSubscribe()}>
            {pending ? "Working…" : "Confirm"}
          </button>
        </div>
        {predictedId ? <p className="mono">Subscription id {predictedId}</p> : null}
        {status ? <p className="note">{status}</p> : null}
        {tx ? <p><a href={explorerTx(tx)}>{explorerTx(tx)}</a></p> : null}
        {error ? <p className="error">{error}</p> : null}
        <ReceiptList receipts={receipts} />
        <Keeper ethereum={ethereum} owner={owner} />
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
            <div className="review">
              <strong>Review the next charge before you sign</strong>
              <div>Amount {formatTusd(subscription.amount)} tUSD8</div>
              <div>Period {formatPeriod(subscription.periodSeconds)}</div>
              <div>Recipient {subscription.merchant}</div>
              <div>Spending cap {formatTusd(subscription.spendingCapPerPeriod)} tUSD8 per period</div>
            </div>
            <p className="note">Pause and revoke cancels on chain. The live manager revokes the session key and cannot set the tUSD8 allowance to 0, so this same click does that from the subscriber account.</p>
            <div className="actions">
              <button className="primary" type="button" disabled={pending || !renewReady} onClick={() => void onRenew()}>
                Renew
              </button>
              <button className="ghost" type="button" disabled={pending || subscription.cancelled} onClick={() => void onCancel()}>
                Pause and revoke
              </button>
              {subscription.cancelled ? (
                <button className="ghost" type="button" disabled={pending} onClick={() => void onExplain()}>
                  Show why a renewal stops
                </button>
              ) : null}
            </div>
            {!subscription.cancelled && !renewReady ? (
              <p className="note">Next charge in {Math.max(secondsLeft, 0)}s. Arm the keeper above, then this page can close.</p>
            ) : null}
            {stopReason ? <p className="error">{stopReason}</p> : null}
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
