import { useEffect, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { DemoGuide } from "./DemoGuide";
import { MerchantPanel } from "./MerchantPanel";
import { SubscriberPanel } from "./SubscriberPanel";
import { ensureAevum } from "./lib/account";
import {
  AEVUM_BUNDLER,
  AEVUM_CHAIN_ID,
  ENTRY_POINT,
  SESSION_KEY_REGISTRY,
  SUBSCRIPTION_MANAGER,
  TUSD8,
  explorerAddress,
} from "./lib/chain";

type Tab = "merchant" | "subscriber";

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function App() {
  const [tab, setTab] = useState<Tab>("merchant");
  const [address, setAddress] = useState<Address | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ethereum = typeof window === "undefined" ? undefined : window.ethereum;

  useEffect(() => {
    if (!ethereum?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0];
      const first = Array.isArray(accounts) ? accounts[0] : null;
      setAddress(typeof first === "string" && isAddress(first) ? getAddress(first) : null);
    };
    ethereum.on("accountsChanged", onAccounts);
    return () => ethereum.removeListener?.("accountsChanged", onAccounts);
  }, [ethereum]);

  async function connect() {
    if (!ethereum) {
      setNotice("This checkout signs with the browser wallet.");
      return;
    }
    setNotice(null);
    await ensureAevum(ethereum);
    const accounts = await ethereum.request({ method: "eth_requestAccounts" });
    const first = Array.isArray(accounts) ? accounts[0] : null;
    if (typeof first !== "string" || !isAddress(first)) throw new Error("The wallet did not return an account.");
    setAddress(getAddress(first));
  }

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="tag live">QDay Aevum · chain {AEVUM_CHAIN_ID}</p>
          <h1 className="mark">RenewPay</h1>
          <p className="lede">
            Recurring tUSD8 billing on Aevum. The merchant sets the price. The subscriber sets a cap
            and an expiry. The chain collects each period, and the subscriber can stop the next one.
          </p>
        </div>
        <div className="wallet">
          <button className="primary" type="button" onClick={() => void connect().catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))}>
            {address ? short(address) : "Connect wallet"}
          </button>
          <span className="pill">{address ? "Merchant wallet connected" : "Wallet not connected"}</span>
        </div>
      </header>

      <div className="chain">
        <a className="pill" href={explorerAddress(SUBSCRIPTION_MANAGER)}>Manager {short(SUBSCRIPTION_MANAGER)}</a>
        <a className="pill" href={explorerAddress(SESSION_KEY_REGISTRY)}>Registry {short(SESSION_KEY_REGISTRY)}</a>
        <a className="pill" href={explorerAddress(TUSD8)}>tUSD8 {short(TUSD8)}</a>
        <a className="pill" href={explorerAddress(ENTRY_POINT)}>EntryPoint {short(ENTRY_POINT)}</a>
        <span className="pill">{AEVUM_BUNDLER}</span>
      </div>

      {notice ? <p className="error">{notice}</p> : null}
      {!ethereum ? <p className="warn">Open this page in a browser with a wallet extension and sign with that wallet.</p> : null}
      <DemoGuide address={address} />

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "merchant"} onClick={() => setTab("merchant")}>Merchant</button>
        <button type="button" role="tab" aria-selected={tab === "subscriber"} onClick={() => setTab("subscriber")}>Subscriber</button>
      </div>

      {tab === "merchant" ? (
        <MerchantPanel ethereum={ethereum} merchant={address} />
      ) : (
        <SubscriberPanel ethereum={ethereum} owner={address} />
      )}
    </div>
  );
}
