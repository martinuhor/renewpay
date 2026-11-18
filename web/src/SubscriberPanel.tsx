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
  DEMO_CAP,
  DEMO_FUND,
  DEMO_GAS_DEPOSIT,
  SPONSOR_FEE,
  SUBSCRIPTION_MANAGER,
  YEAR_SECONDS,
  explorerAddress,
  explorerTx,
} from "./lib/chain";
import { ReceiptList, StepProgress, type Receipt } from "./Receipts";
import { paymasterGasAllowance } from "./lib/billing";
import { deployPaymaster, deployPolicy, fundPaymaster, rotateSessionSigner, savedPaymaster, savedPolicy, sessionSigner } from "./lib/sponsorship";
import { DEMO_CANCELLED_KEY, DEMO_FUNDED_KEY, DEMO_PLAN_KEY, DEMO_RENEWED_KEY, DEMO_SUBSCRIPTION_KEY, markDemo } from "./lib/demo";

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function SubscriberPanel({ ethereum, owner }: { ethereum?: EthereumProvider; owner: Address | null }) {
  const [planId, setPlanId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [cap, setCap] = useState(DEMO_CAP.toString());
  const [expiryDays, setExpiryDays] = useState("365");
  const [fund, setFund] = useState(DEMO_FUND.toString());
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
  let capPreview = "—";
  try {
    capPreview = formatTusd(parseTusdInput(cap));
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
        <h2>Authorize and pay</h2>
        <p className="lede">The paymaster’s EntryPoint float is tQDAY. Fund it once with 0.05 tQDAY. The subscriber fee on subscribe, renew, and cancel is 0.01 tUSD8. QDay’s paymaster does not sponsor SubscriptionManager.</p>
        <div className="actions">
          <button className="ghost" type="button" disabled={pending || !owner || Boolean(policy)} onClick={() => void onDeployPolicy()}>
            {policy ? "Policy deployed" : "Deploy renew policy"}
          </button>
          <button className="ghost" type="button" disabled={pending || !owner || !policy || Boolean(paymaster)} onClick={() => void onDeployPaymaster()}>
            {paymaster ? "Paymaster deployed" : "Deploy paymaster"}
          </button>
          <button className="primary" type="button" disabled={pending || !paymaster} onClick={() => void onFundPaymaster()}>
            Fund paymaster {formatEther(DEMO_GAS_DEPOSIT)} tQDAY
          </button>
        </div>
        {policy ? <p className="mono">Renew policy {policy}</p> : null}
        {paymaster ? <p className="mono">Paymaster {paymaster}</p> : null}
        <p className="lede">
          Deploy renew policy sends the bytecode compiled from <a href="https://github.com/martinuhor/renewpay/blob/cursor/week2-checkout-a136/src/RenewOnlyPolicy.sol">RenewOnlyPolicy.sol</a>. Deploy paymaster sends the bytecode compiled from <a href="https://github.com/martinuhor/renewpay/blob/cursor/week2-checkout-a136/src/SubscriptionPaymaster.sol">SubscriptionPaymaster.sol</a>. Your wallet signs those transactions and the 0.05 tQDAY fund.
        </p>
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
          Session key. This browser holds the private key. The chain records the address, the cap, and the expiry. Pause revokes it.
          <input readOnly value={sessionKey ?? ""} />
        </label>
        <p className="note">The first renewal asks the wallet to approve this key. After that, the key signs renewals itself, and it can only call renew. The price still has to fit the cap, the period has to be due, and the allowance stays finite.</p>
        <div className="actions">
          <button
            className="ghost"
            type="button"
            onClick={() => setSessionKey(rotateSessionSigner())}
          >
            New session key
          </button>
        </div>
        <label>
          Spending cap per period. 2000000 is 2 tUSD8. The plan price cannot exceed it.
          <input value={cap} onChange={(event) => setCap(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          Expiry, days from now
          <input value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} inputMode="numeric" />
        </label>
        <div className="note">
          Subscription allowance {allowancePreview ?? "—"} tUSD8. That is two periods at the spending cap. It stays finite, and the session key can still last until the expiry above.
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
          <dt>Paymaster float, tQDAY</dt>
          <dd>{deposit === null ? "—" : formatEther(deposit)}</dd>
          <dt>Network fee</dt>
          <dd>{formatTusd(SPONSOR_FEE)} tUSD8</dd>
        </dl>
        <label>
          Move tUSD8 onto the subscriber account
          <input value={fund} onChange={(event) => setFund(event.target.value)} inputMode="numeric" />
        </label>
        <p className="warn">That transfer is a wallet transaction, so its network fee is tQDAY. Default is 3 tUSD8: the first period and one renewal. Do not move it again if the account already holds 3 tUSD8.</p>
        {plan && sessionKey ? (
          <div className="review">
            <strong>Review before you sign</strong>
            <div>Amount {formatTusd(plan.amount)} tUSD8</div>
            <div>Period {formatPeriod(plan.periodSeconds)}</div>
            <div>Recipient {plan.merchant}</div>
            <div>Spending cap {capPreview} tUSD8 per period</div>
            <div>Allowance {allowancePreview ?? "—"} tUSD8, which is the cap times two. Paymaster approval {formatTusd(paymasterGasAllowance())} tUSD8. Neither is unlimited.</div>
            <div>Network fee {formatTusd(SPONSOR_FEE)} tUSD8. The paymaster’s EntryPoint float is tQDAY. QDay’s paymaster does not sponsor SubscriptionManager.</div>
          </div>
        ) : null}
        <StepProgress
          labels={["Approve the capped tUSD8 allowance", "Activate the subscription", "Receipt"]}
          active={subscribeStep}
        />
        <div className="actions">
          <button className="ghost" type="button" disabled={pending || !subscriber} onClick={() => void onFund()}>Move 3 tUSD8</button>
          <button className="primary" type="button" disabled={pending || !plan || !subscriber || !paymaster || deposit === 0n} onClick={() => void onSubscribe()}>
            {pending ? "Working…" : "Sign subscription"}
          </button>
        </div>
        {predictedId ? <p className="mono">Subscription id {predictedId}</p> : null}
        {status ? <p className="note">{status}</p> : null}
        {tx ? <p><a href={explorerTx(tx)}>{explorerTx(tx)}</a></p> : null}
        {error ? <p className="error">{error}</p> : null}
        <ReceiptList receipts={receipts} />
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
              <p className="note">Renew unlocks in {Math.max(secondsLeft, 0)}s. Leave this tab open.</p>
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
